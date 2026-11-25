import { DISPATCH_ROOM, type Job, type JobEvent } from "@boda-dispatch/shared";
import type { FastifyInstance } from "fastify";

/**
 * Tells every connected dispatcher, on every server instance (the Redis
 * adapter relays it), that a job changed. Call it after the write has
 * committed. The write already succeeded, so a failure here is logged, never
 * thrown: a dispatcher who misses the event catches up when they resync.
 */
export const publishJob = (
  app: FastifyInstance,
  event: "job:created" | "job:updated",
  job: Job,
) => {
  const payload: JobEvent = { job };
  try {
    app.io.to(DISPATCH_ROOM).emit(event, payload);
  } catch (err) {
    app.log.error({ err, jobId: job.id, event }, "Failed to publish job event");
  }
};
