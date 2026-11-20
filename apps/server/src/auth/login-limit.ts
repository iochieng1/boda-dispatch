import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";

export type LoginLimitOptions = {
  redis: Redis;
  log: FastifyBaseLogger;
  /** Redis key prefix; tests give every app its own. */
  prefix: string;
  maxPerIp: number;
  maxPerEmail: number;
  windowSeconds: number;
};

const HIT_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end
return { count, redis.call("TTL", KEYS[1]) }
`;

export type LoginLimitResult =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * Fixed-window counters for login attempts, per client IP and per email.
 * Checked before any password hashing, so guessing is throttled and a flood
 * of logins can't pin the CPU and memory with argon2 work.
 *
 * Fails open: if Redis is unreachable, logins are still allowed (and logged),
 * so a cache outage doesn't lock every dispatcher out.
 */
export const createLoginLimiter = (options: LoginLimitOptions) => {
  const { redis, log, prefix, maxPerIp, maxPerEmail, windowSeconds } = options;

  // One atomic round trip: count the attempt, start the window on the first
  // one, and report the window's remaining seconds.
  const hit = async (key: string) => {
    const [count, ttl] = (await redis.eval(
      HIT_SCRIPT,
      1,
      key,
      windowSeconds,
    )) as [number, number];
    return { count, ttl };
  };

  return async (ip: string, email: string): Promise<LoginLimitResult> => {
    try {
      const [byIp, byEmail] = await Promise.all([
        hit(`${prefix}:ip:${ip}`),
        hit(`${prefix}:email:${email.trim().toLowerCase()}`),
      ]);
      const blocked = [
        byIp.count > maxPerIp && byIp.ttl,
        byEmail.count > maxPerEmail && byEmail.ttl,
      ].filter((ttl): ttl is number => typeof ttl === "number");

      return blocked.length === 0
        ? { allowed: true }
        : {
            allowed: false,
            retryAfterSeconds: Math.max(1, ...blocked),
          };
    } catch (err) {
      log.error({ err }, "Login rate limiter unavailable; allowing attempt");
      return { allowed: true };
    }
  };
};

export type LoginLimiter = ReturnType<typeof createLoginLimiter>;
