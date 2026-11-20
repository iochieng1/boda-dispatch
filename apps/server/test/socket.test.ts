import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import {
  type ClientToServerEvents,
  type ServerToClientEvents,
  serverHelloSchema,
  SOCKET_UNAUTHORIZED,
  type SocketAuthRefreshAck,
} from "@boda-dispatch/shared";
import { type Socket, io as connect } from "socket.io-client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { buildApp } from "../src/app.js";
import { buildTestApp, createDispatcher, loginAs } from "./helpers.js";

type App = Awaited<ReturnType<typeof buildApp>>;
type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Socket.IO auth", () => {
  let app: App;
  let url: string;
  const clients: ClientSocket[] = [];

  beforeAll(async () => {
    app = await buildTestApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.disconnect();
  });

  afterAll(async () => {
    await app.close();
  });

  const open = (auth?: ClientSocket["auth"]) => {
    const client: ClientSocket = connect(url, {
      transports: ["websocket"],
      reconnection: false,
      ...(auth !== undefined && { auth }),
    });
    clients.push(client);
    return client;
  };

  /** Resolves once connected, rejects with the connect_error. */
  const connected = (client: ClientSocket) =>
    new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("connect_error", reject);
    });

  const refusal = (client: ClientSocket) =>
    new Promise<Error>((resolve, reject) => {
      client.once("connect", () => reject(new Error("socket connected")));
      client.once("connect_error", resolve);
    });

  const refreshOnSocket = (client: ClientSocket, token: string) =>
    client
      .timeout(5_000)
      .emitWithAck("auth:refresh", { token }) as Promise<SocketAuthRefreshAck>;

  /** An access token for the dispatcher that expires in `seconds`. */
  const shortLivedToken = (sub: string, seconds: number) =>
    app.jwt.sign({ sub }, { expiresIn: seconds });

  describe("handshake", () => {
    it("greets an authenticated dispatcher with server:hello", async () => {
      const dispatcher = await createDispatcher(app);
      const { access_token } = await loginAs(app, dispatcher);
      const client = open({ token: access_token });

      const hello = await new Promise((resolve, reject) => {
        client.once("server:hello", resolve);
        client.once("connect_error", reject);
      });

      expect(serverHelloSchema.parse(hello)).toEqual({
        socketId: client.id,
        serverTime: expect.any(String),
      });
      const [serverSocket] = await app.io.in(client.id!).fetchSockets();
      expect(serverSocket?.data.dispatcher.id).toBe(dispatcher.id);
    });

    it("refuses a connection without a token", async () => {
      const err = await refusal(open());

      expect(err.message).toBe(SOCKET_UNAUTHORIZED);
    });

    it.each([
      ["an empty token", ""],
      ["a malformed token", "not-a-jwt"],
    ])("refuses %s", async (_, token) => {
      const err = await refusal(open({ token }));

      expect(err.message).toBe(SOCKET_UNAUTHORIZED);
    });

    it("refuses a token signed with another secret", async () => {
      const other = await buildTestApp({
        JWT_SECRET: "another-secret-that-is-at-least-32-chars",
      });
      const dispatcher = await createDispatcher(app);
      const token = other.jwt.sign({ sub: dispatcher.id });
      await other.close();

      const err = await refusal(open({ token }));

      expect(err.message).toBe(SOCKET_UNAUTHORIZED);
    });

    it("refuses an expired token", async () => {
      const dispatcher = await createDispatcher(app);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() - 16 * 60 * 1000);
      const token = app.jwt.sign({ sub: dispatcher.id });
      vi.useRealTimers();

      const err = await refusal(open({ token }));

      expect(err.message).toBe(SOCKET_UNAUTHORIZED);
    });

    it("refuses a token for a dispatcher that no longer exists", async () => {
      const token = app.jwt.sign({ sub: randomUUID() });

      const err = await refusal(open({ token }));

      expect(err.message).toBe(SOCKET_UNAUTHORIZED);
    });
  });

  describe("token refresh on a live socket", () => {
    it("keeps the same socket session when the access token is refreshed", async () => {
      const dispatcher = await createDispatcher(app);
      const { refresh_token } = await loginAs(app, dispatcher);
      const client = open({ token: shortLivedToken(dispatcher.id, 2) });
      await connected(client);
      const socketId = client.id;
      let disconnected = false;
      client.on("disconnect", () => (disconnected = true));

      // What the dashboard does before expiry: rotate over HTTP, then hand
      // the new access token to the socket.
      const rotated = await app.inject({
        method: "POST",
        url: "/v1/auth/refresh",
        payload: { refresh_token },
      });
      expect(rotated.statusCode).toBe(200);
      const ack = await refreshOnSocket(client, rotated.json().access_token);

      expect(ack).toEqual({ ok: true, expiresAt: expect.any(String) });
      const { expiresAt } = ack as { expiresAt: string };
      expect(new Date(expiresAt).getTime()).toBeGreaterThan(
        Date.now() + 10 * 60 * 1000,
      );

      // Outlive the original token.
      await sleep(2_500);

      expect(disconnected).toBe(false);
      expect(client.connected).toBe(true);
      expect(client.id).toBe(socketId);
      const [serverSocket] = await app.io.in(socketId!).fetchSockets();
      expect(serverSocket).toBeDefined();
    });

    it("disconnects with auth:expired when the token runs out unrefreshed", async () => {
      const dispatcher = await createDispatcher(app);
      const client = open({ token: shortLivedToken(dispatcher.id, 2) });
      await connected(client);

      const expired = new Promise<void>((r) => client.once("auth:expired", r));
      const reason = new Promise<string>((r) =>
        client.once("disconnect", (why) => r(why)),
      );

      await expired;
      expect(await reason).toBe("io server disconnect");
    });

    it("can reconnect with a fresh token after expiry", async () => {
      const dispatcher = await createDispatcher(app);
      let token = shortLivedToken(dispatcher.id, 2);
      // Like the dashboard: auth is read on every (re)connect.
      const client = open((cb) => cb({ token }));
      await connected(client);
      await new Promise((r) => client.once("disconnect", r));

      token = (await loginAs(app, dispatcher)).access_token;
      client.connect();
      await connected(client);

      expect(client.connected).toBe(true);
    });

    it("rejects a refresh with an invalid token but keeps the socket", async () => {
      const dispatcher = await createDispatcher(app);
      const { access_token } = await loginAs(app, dispatcher);
      const client = open({ token: access_token });
      await connected(client);

      const ack = await refreshOnSocket(client, "not-a-jwt");

      expect(ack).toEqual({ ok: false, error: SOCKET_UNAUTHORIZED });
      expect(client.connected).toBe(true);
    });

    it("rejects a refresh with another dispatcher's token", async () => {
      const [alice, bob] = await Promise.all([
        createDispatcher(app, "Alice"),
        createDispatcher(app, "Bob"),
      ]);
      const client = open({ token: (await loginAs(app, alice)).access_token });
      await connected(client);

      const ack = await refreshOnSocket(
        client,
        (await loginAs(app, bob)).access_token,
      );

      expect(ack).toEqual({ ok: false, error: SOCKET_UNAUTHORIZED });
      const [serverSocket] = await app.io.in(client.id!).fetchSockets();
      expect(serverSocket?.data.dispatcher.id).toBe(alice.id);
    });
  });
});
