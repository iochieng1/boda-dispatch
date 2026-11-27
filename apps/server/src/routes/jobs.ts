import {
  cancelJobInputSchema,
  createJobInputSchema,
  IDEMPOTENT_REPLAYED_HEADER,
  jobChangesQuerySchema,
  listJobsQuerySchema,
  type JobConflict,
  updateJobInputSchema,
} from "@boda-dispatch/shared";
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
} from "fastify";
import { z } from "zod";

import {
  type ChangeJobResult,
  changeJob,
  createJob,
  listJobChanges,
  listJobs,
} from "../jobs/service.js";
import { publishJob } from "../realtime/publish.js";
import { parseInput } from "./validate.js";

const jobParamsSchema = z.object({ id: z.uuid() });

const mutationIdReused = (reply: FastifyReply) =>
  reply.code(400).send({
    statusCode: 400,
    error: "Bad Request",
    message: "Invalid request body",
    issues: [
      {
        path: "clientMutationId",
        message: "Already used by a different change",
      },
    ],
  });

const sendChangeResult = (
  app: FastifyInstance,
  reply: FastifyReply,
  result: ChangeJobResult,
) => {
  switch (result.kind) {
    case "ok":
      if (result.replayed) reply.header(IDEMPOTENT_REPLAYED_HEADER, "true");
      if (result.changed) publishJob(app, "job:updated", result.job);
      return result.job;
    case "mutation_id_reused":
      return mutationIdReused(reply);
    case "not_found":
      return reply.code(404).send({
        statusCode: 404,
        error: "Not Found",
        message: "Job not found",
      });
    case "rider_not_found":
      // The route exists; it's a field that is wrong, so answer like any
      // other bad field rather than with the 404 used for a missing job.
      return reply.code(400).send({
        statusCode: 400,
        error: "Bad Request",
        message: "Invalid request body",
        issues: [{ path: "assignedRiderId", message: "Rider not found" }],
      });
    case "conflict":
      return reply.code(409).send({
        statusCode: 409,
        error: "Conflict",
        code: result.code,
        message: result.message,
        job: result.job,
      } satisfies JobConflict);
  }
};

const jobRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.post("/", async (request, reply) => {
    const body = parseInput(createJobInputSchema, request.body, reply);
    if (!body) return reply;

    const result = await createJob(app.db, request.dispatcher.id, body);
    switch (result.kind) {
      case "created":
        publishJob(app, "job:created", result.job);
        return reply.code(201).send(result.job);
      case "replayed":
        // Same answer as the first time, so a client that lost the ack can't
        // tell the difference; nothing new to publish.
        return reply
          .code(201)
          .header(IDEMPOTENT_REPLAYED_HEADER, "true")
          .send(result.job);
      case "mutation_id_reused":
        return mutationIdReused(reply);
    }
  });

  app.get("/", async (request, reply) => {
    const query = parseInput(
      listJobsQuerySchema,
      request.query,
      reply,
      "query",
    );
    if (!query) return reply;

    const page = await listJobs(app.db, query);
    if (!page) {
      return reply.code(400).send({
        statusCode: 400,
        error: "Bad Request",
        message: "Unknown cursor",
      });
    }
    return page;
  });

  // Registered before /:id routes; a fixed segment wins over a parameter.
  app.get("/changes", async (request, reply) => {
    const query = parseInput(
      jobChangesQuerySchema,
      request.query,
      reply,
      "query",
    );
    if (!query) return reply;

    return listJobChanges(app.db, query);
  });

  app.patch("/:id", async (request, reply) => {
    const params = parseInput(jobParamsSchema, request.params, reply, "job id");
    if (!params) return reply;
    const body = parseInput(updateJobInputSchema, request.body, reply);
    if (!body) return reply;

    return sendChangeResult(
      app,
      reply,
      await changeJob(app.db, request.dispatcher.id, params.id, body),
    );
  });

  app.post("/:id/cancel", async (request, reply) => {
    const params = parseInput(jobParamsSchema, request.params, reply, "job id");
    if (!params) return reply;
    const body = parseInput(cancelJobInputSchema, request.body ?? {}, reply);
    if (!body) return reply;

    return sendChangeResult(
      app,
      reply,
      await changeJob(app.db, request.dispatcher.id, params.id, {
        status: "CANCELLED",
        ...body,
      }),
    );
  });
};

export default jobRoutes;
