import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  // HS256 signing key for access tokens. 32+ characters so it can't be
  // brute-forced; generate one with: openssl rand -base64 48
  JWT_SECRET: z.string().min(32),
  // A refresh token presented again within this many seconds of its first use
  // is a lost response (page reload mid-refresh, flaky network), not theft:
  // it is rotated again instead of revoking the session. 0 disables.
  REFRESH_REUSE_GRACE_SECONDS: z.coerce.number().int().min(0).default(30),
  // Browser origins allowed to open a socket (the dispatcher dashboard).
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:3000")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.url()).min(1)),
});

export type Config = z.infer<typeof envSchema>;

/** Parses and validates environment variables, failing fast on bad config. */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return result.data;
};
