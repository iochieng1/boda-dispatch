import type { DispatcherProfile } from "@boda-dispatch/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { dispatchers } from "../db/schema.js";

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export type AccessTokenClaims = { sub: string; iat: number; exp: number };

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string };
    user: AccessTokenClaims;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
  }

  interface FastifyRequest {
    dispatcher: DispatcherProfile;
  }
}

/** Loads a dispatcher by id; undefined if they no longer exist. */
export const findDispatcher = async (
  app: FastifyInstance,
  id: string,
): Promise<DispatcherProfile | undefined> => {
  const [dispatcher] = await app.db
    .select({
      id: dispatchers.id,
      email: dispatchers.email,
      name: dispatchers.name,
    })
    .from(dispatchers)
    .where(eq(dispatchers.id, id))
    .limit(1);
  return dispatcher;
};

/**
 * Verifies an access token and loads its dispatcher. Returns undefined for a
 * missing, expired, tampered or foreign token, or a deleted dispatcher, so
 * HTTP and socket auth reject them all the same way.
 */
export const verifyAccessToken = async (
  app: FastifyInstance,
  token: unknown,
): Promise<
  { dispatcher: DispatcherProfile; claims: AccessTokenClaims } | undefined
> => {
  if (typeof token !== "string" || token.length === 0) return undefined;

  let claims: AccessTokenClaims;
  try {
    claims = app.jwt.verify<AccessTokenClaims>(token);
  } catch {
    return undefined;
  }

  const dispatcher = await findDispatcher(app, claims.sub);
  return dispatcher && { dispatcher, claims };
};

/**
 * preHandler for protected routes: verifies the Bearer access token and puts
 * the dispatcher on `request.dispatcher`.
 */
export const authenticate = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const result = await verifyAccessToken(request.server, token);

  if (!result) {
    return reply.code(401).send({
      statusCode: 401,
      error: "Unauthorized",
      message: "Missing or invalid access token",
    });
  }

  request.dispatcher = result.dispatcher;
};
