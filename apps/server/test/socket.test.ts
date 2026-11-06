import type { ServerToClientEvents } from "@boda-dispatch/shared";
import { serverHelloSchema } from "@boda-dispatch/shared";
import type { AddressInfo } from "node:net";
import { type Socket, io as connect } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";

import type { buildApp } from "../src/app.js";
import { buildTestApp } from "./helpers.js";

type App = Awaited<ReturnType<typeof buildApp>>;

describe("Socket.IO", () => {
  let app: App | undefined;
  let client: Socket<ServerToClientEvents> | undefined;

  afterEach(async () => {
    client?.disconnect();
    await app?.close();
    client = undefined;
    app = undefined;
  });

  it("greets a connecting client with server:hello", async () => {
    app = await buildTestApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;

    client = connect(`http://127.0.0.1:${port}`, {
      transports: ["websocket"],
      reconnection: false,
    });

    const hello = await new Promise((resolve, reject) => {
      client!.once("server:hello", resolve);
      client!.once("connect_error", reject);
    });

    expect(serverHelloSchema.parse(hello)).toEqual({
      socketId: client.id,
      serverTime: expect.any(String),
    });
  });
});
