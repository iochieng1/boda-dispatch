import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { buildApp } from "../src/app.js";
import { hashRefreshToken } from "../src/auth/refresh-tokens.js";
import { dispatchers, refreshTokens } from "../src/db/schema.js";
import { buildTestApp, createDispatcher, loginAs } from "./helpers.js";

type App = Awaited<ReturnType<typeof buildApp>>;

describe("dispatcher auth", () => {
  let app: App;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  const login = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/v1/auth/login", payload });

  const refresh = (refreshToken: string) =>
    app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refresh_token: refreshToken },
    });

  const logout = (refreshToken: string) =>
    app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      payload: { refresh_token: refreshToken },
    });

  const me = (authorization?: string) =>
    app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: authorization ? { authorization } : {},
    });

  const tokenRow = async (refreshToken: string) => {
    const [row] = await app.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashRefreshToken(refreshToken)));
    return row!;
  };

  const familyRows = (familyId: string) =>
    app.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.familyId, familyId));

  describe("POST /v1/auth/login", () => {
    it("returns a 15-minute access token for the dispatcher", async () => {
      const dispatcher = await createDispatcher(app);

      const res = await login({
        email: dispatcher.email.toUpperCase(),
        password: dispatcher.password,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ token_type: "Bearer", expires_in: 900 });
      expect(body.dispatcher).toEqual({
        id: dispatcher.id,
        email: dispatcher.email,
        name: dispatcher.name,
      });
      expect(body.dispatcher).not.toHaveProperty("passwordHash");
      const claims = app.jwt.decode<{ sub: string; iat: number; exp: number }>(
        body.access_token,
      );
      expect(claims?.sub).toBe(dispatcher.id);
      expect(claims!.exp - claims!.iat).toBe(900);
    });

    it("returns a 7-day refresh token stored only as a SHA-256 hash", async () => {
      const dispatcher = await createDispatcher(app);

      const body = await loginAs(app, dispatcher);

      expect(body.refresh_expires_in).toBe(7 * 24 * 60 * 60);
      const row = await tokenRow(body.refresh_token);
      expect(row.dispatcherId).toBe(dispatcher.id);
      expect(row.tokenHash).not.toBe(body.refresh_token);
      expect(row.usedAt).toBeNull();
      expect(row.revokedAt).toBeNull();
      const ttlMs = row.expiresAt.getTime() - row.createdAt.getTime();
      expect(ttlMs).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it("verifies against an argon2id hash", async () => {
      const dispatcher = await createDispatcher(app);

      const [row] = await app.db
        .select({ passwordHash: dispatchers.passwordHash })
        .from(dispatchers)
        .where(eq(dispatchers.id, dispatcher.id));

      expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
      expect(row?.passwordHash).not.toContain(dispatcher.password);
    });

    it("starts a new token family on every login", async () => {
      const dispatcher = await createDispatcher(app);

      const first = await loginAs(app, dispatcher);
      const second = await loginAs(app, dispatcher);

      const [a, b] = await Promise.all([
        tokenRow(first.refresh_token),
        tokenRow(second.refresh_token),
      ]);
      expect(a.familyId).not.toBe(b.familyId);
    });

    it("returns the same 401 for a wrong password and an unknown email", async () => {
      const dispatcher = await createDispatcher(app);

      const wrongPassword = await login({
        email: dispatcher.email,
        password: "wrong-password",
      });
      const unknownEmail = await login({
        email: `nobody-${randomUUID()}@boda.example`,
        password: dispatcher.password,
      });

      expect(wrongPassword.statusCode).toBe(401);
      expect(unknownEmail.statusCode).toBe(401);
      expect(wrongPassword.json()).toEqual(unknownEmail.json());
      expect(wrongPassword.json().message).toBe("Invalid email or password");
    });

    it.each([
      ["a missing password", { email: "a@boda.example" }],
      ["an empty email", { email: "", password: "x" }],
      ["unknown keys", { email: "a@boda.example", password: "x", role: "x" }],
    ])("rejects %s with 400", async (_, payload) => {
      expect((await login(payload)).statusCode).toBe(400);
    });
  });

  describe("GET /v1/auth/me (protected)", () => {
    it("returns the dispatcher for a valid token", async () => {
      const dispatcher = await createDispatcher(app);
      const { access_token } = await loginAs(app, dispatcher);

      const res = await me(`Bearer ${access_token}`);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        id: dispatcher.id,
        email: dispatcher.email,
        name: dispatcher.name,
      });
    });

    it("returns 401 without a token", async () => {
      expect((await me()).statusCode).toBe(401);
    });

    it("returns 401 for a tampered token", async () => {
      const dispatcher = await createDispatcher(app);
      const { access_token } = await loginAs(app, dispatcher);
      const [header, , signature] = access_token.split(".");
      const forged = Buffer.from(
        JSON.stringify({ sub: randomUUID() }),
      ).toString("base64url");

      const res = await me(`Bearer ${header}.${forged}.${signature}`);

      expect(res.statusCode).toBe(401);
    });

    it("returns 401 for a token signed with another secret", async () => {
      const other = await buildTestApp({
        JWT_SECRET: "another-secret-that-is-at-least-32-chars",
      });
      const dispatcher = await createDispatcher(app);
      const token = other.jwt.sign({ sub: dispatcher.id });
      await other.close();

      expect((await me(`Bearer ${token}`)).statusCode).toBe(401);
    });

    it("returns 401 for an expired token", async () => {
      const dispatcher = await createDispatcher(app);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() - 16 * 60 * 1000);
      const token = app.jwt.sign({ sub: dispatcher.id });
      vi.useRealTimers();

      expect((await me(`Bearer ${token}`)).statusCode).toBe(401);
    });

    it("returns 401 when the dispatcher no longer exists", async () => {
      const token = app.jwt.sign({ sub: randomUUID() });

      expect((await me(`Bearer ${token}`)).statusCode).toBe(401);
    });
  });

  describe("POST /v1/auth/refresh", () => {
    it("rotates the token within the same family", async () => {
      const dispatcher = await createDispatcher(app);
      const { refresh_token } = await loginAs(app, dispatcher);

      const res = await refresh(refresh_token);

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ token_type: "Bearer", expires_in: 900 });
      expect(body.refresh_token).not.toBe(refresh_token);
      expect(body.dispatcher.id).toBe(dispatcher.id);
      expect(app.jwt.decode<{ sub: string }>(body.access_token)?.sub).toBe(
        dispatcher.id,
      );

      const [old, next] = await Promise.all([
        tokenRow(refresh_token),
        tokenRow(body.refresh_token),
      ]);
      expect(old.usedAt).not.toBeNull();
      expect(next.familyId).toBe(old.familyId);
      expect(next.usedAt).toBeNull();
      expect((await me(`Bearer ${body.access_token}`)).statusCode).toBe(200);
    });

    it("can be chained: each new token works once", async () => {
      const dispatcher = await createDispatcher(app);
      const { refresh_token } = await loginAs(app, dispatcher);

      const second = (await refresh(refresh_token)).json().refresh_token;

      expect((await refresh(second)).statusCode).toBe(200);
    });

    it("revokes the whole family, including the newest token, on reuse", async () => {
      const dispatcher = await createDispatcher(app);
      const { refresh_token } = await loginAs(app, dispatcher);
      const second = (await refresh(refresh_token)).json().refresh_token;
      const third = (await refresh(second)).json().refresh_token;

      const reuse = await refresh(refresh_token);

      expect(reuse.statusCode).toBe(401);
      const { familyId } = await tokenRow(refresh_token);
      const rows = await familyRows(familyId);
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
      expect((await refresh(third)).statusCode).toBe(401);
    });

    it("issues exactly one new pair for concurrent refreshes of one token", async () => {
      const dispatcher = await createDispatcher(app);
      const { refresh_token } = await loginAs(app, dispatcher);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => refresh(refresh_token)),
      );

      const codes = results.map((r) => r.statusCode).sort();
      expect(codes).toEqual([200, 401, 401, 401, 401]);
      const { familyId } = await tokenRow(refresh_token);
      expect(await familyRows(familyId)).toHaveLength(2);
    });

    it("returns 401 for an expired token without revoking the family", async () => {
      const dispatcher = await createDispatcher(app);
      const { refresh_token } = await loginAs(app, dispatcher);
      await app.db
        .update(refreshTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(refreshTokens.tokenHash, hashRefreshToken(refresh_token)));

      expect((await refresh(refresh_token)).statusCode).toBe(401);
      expect((await tokenRow(refresh_token)).revokedAt).toBeNull();
    });

    it("returns the same 401 for unknown, reused and revoked tokens", async () => {
      const unknown = await refresh("not-a-real-token");
      const dispatcher = await createDispatcher(app);
      const { refresh_token } = await loginAs(app, dispatcher);
      await refresh(refresh_token);
      const reused = await refresh(refresh_token);
      const revoked = await refresh(refresh_token);

      expect(unknown.statusCode).toBe(401);
      expect(reused.json()).toEqual(unknown.json());
      expect(revoked.json()).toEqual(unknown.json());
      expect(unknown.json().message).toBe("Invalid refresh token");
    });

    it("rejects a missing refresh_token with 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/refresh",
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /v1/auth/logout", () => {
    it("revokes the family so its tokens can no longer refresh", async () => {
      const dispatcher = await createDispatcher(app);
      const first = (await loginAs(app, dispatcher)).refresh_token;
      const current = (await refresh(first)).json().refresh_token;

      expect((await logout(current)).statusCode).toBe(204);

      expect((await refresh(current)).statusCode).toBe(401);
      const { familyId } = await tokenRow(current);
      const rows = await familyRows(familyId);
      expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
    });

    it("leaves the dispatcher's other sessions alive", async () => {
      const dispatcher = await createDispatcher(app);
      const phone = (await loginAs(app, dispatcher)).refresh_token;
      const laptop = (await loginAs(app, dispatcher)).refresh_token;

      await logout(phone);

      expect((await refresh(laptop)).statusCode).toBe(200);
    });

    it("returns 204 for an unknown token", async () => {
      expect((await logout("not-a-real-token")).statusCode).toBe(204);
    });
  });
});
