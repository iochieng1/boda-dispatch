import type { FastifyReply } from "fastify";
import type { z } from "zod";

/** Parses input with a shared zod schema, replying 400 on failure. */
export const parseInput = <T extends z.ZodType>(
  schema: T,
  input: unknown,
  reply: FastifyReply,
  what = "request body",
): z.infer<T> | undefined => {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  void reply.code(400).send({
    statusCode: 400,
    error: "Bad Request",
    message: `Invalid ${what}`,
    issues: result.error.issues.map(({ path, message }) => ({
      path: path.join("."),
      message,
    })),
  });
  return undefined;
};
