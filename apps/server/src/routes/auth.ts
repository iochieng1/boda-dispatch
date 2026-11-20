import {
  type DispatcherProfile,
  loginInputSchema,
  refreshInputSchema,
  type TokenPair,
} from "@boda-dispatch/shared";
import { sql } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";

import {
  ACCESS_TOKEN_TTL_SECONDS,
  findDispatcher,
} from "../auth/authenticate.js";
import { verifyAgainstDummyHash, verifyPassword } from "../auth/password.js";
import {
  issueRefreshToken,
  REFRESH_TOKEN_TTL_SECONDS,
  revokeRefreshTokenFamily,
  rotateRefreshToken,
} from "../auth/refresh-tokens.js";
import { dispatchers } from "../db/schema.js";

/** Parses the body with a shared zod schema, replying 400 on failure. */
const parseBody = <T extends z.ZodType>(
  schema: T,
  request: FastifyRequest,
  reply: FastifyReply,
): z.infer<T> | undefined => {
  const result = schema.safeParse(request.body);
  if (result.success) return result.data;
  void reply.code(400).send({
    statusCode: 400,
    error: "Bad Request",
    message: "Invalid request body",
    issues: result.error.issues.map(({ path, message }) => ({
      path: path.join("."),
      message,
    })),
  });
  return undefined;
};

const unauthorized = (reply: FastifyReply, message: string) =>
  reply.code(401).send({ statusCode: 401, error: "Unauthorized", message });

const authRoutes: FastifyPluginAsync = async (app) => {
  const tokenPair = (
    dispatcher: DispatcherProfile,
    refreshToken: string,
  ): TokenPair => ({
    access_token: app.jwt.sign({ sub: dispatcher.id }),
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    refresh_expires_in: REFRESH_TOKEN_TTL_SECONDS,
    dispatcher,
  });

  app.post("/login", async (request, reply) => {
    const body = parseBody(loginInputSchema, request, reply);
    if (!body) return reply;

    const limit = await app.loginLimiter(request.ip, body.email);
    if (!limit.allowed) {
      return reply
        .code(429)
        .header("retry-after", String(limit.retryAfterSeconds))
        .send({
          statusCode: 429,
          error: "Too Many Requests",
          message: "Too many login attempts. Try again later.",
        });
    }

    const [dispatcher] = await app.db
      .select({
        id: dispatchers.id,
        email: dispatchers.email,
        name: dispatchers.name,
        passwordHash: dispatchers.passwordHash,
      })
      .from(dispatchers)
      .where(sql`lower(${dispatchers.email}) = lower(${body.email})`)
      .limit(1);

    const valid = dispatcher
      ? await verifyPassword(dispatcher.passwordHash, body.password)
      : await verifyAgainstDummyHash(body.password);

    if (!dispatcher || !valid) {
      // Same status and message for both, so emails can't be enumerated.
      return unauthorized(reply, "Invalid email or password");
    }

    const refreshToken = await issueRefreshToken(app.db, dispatcher.id);
    const profile = {
      id: dispatcher.id,
      email: dispatcher.email,
      name: dispatcher.name,
    };
    return reply.send(tokenPair(profile, refreshToken));
  });

  app.post("/refresh", async (request, reply) => {
    const body = parseBody(refreshInputSchema, request, reply);
    if (!body) return reply;

    const result = await rotateRefreshToken(app.db, body.refresh_token, {
      graceSeconds: app.config.REFRESH_REUSE_GRACE_SECONDS,
    });

    if (!result.ok) {
      if (result.reason === "reused") {
        request.log.warn("Refresh token reuse detected; token family revoked");
      }
      // One response for every failure, so callers learn nothing about why.
      return unauthorized(reply, "Invalid refresh token");
    }

    // The FK cascades on delete, so a live token always has a dispatcher.
    const dispatcher = await findDispatcher(app, result.dispatcherId);
    if (!dispatcher) return unauthorized(reply, "Invalid refresh token");
    return reply.send(tokenPair(dispatcher, result.refreshToken));
  });

  app.post("/logout", async (request, reply) => {
    const body = parseBody(refreshInputSchema, request, reply);
    if (!body) return reply;

    await revokeRefreshTokenFamily(app.db, body.refresh_token);
    // 204 even for unknown tokens: logout is idempotent and not an oracle.
    return reply.code(204).send();
  });

  app.get("/me", { preHandler: app.authenticate }, async (request) => {
    return request.dispatcher;
  });
};

export default authRoutes;
