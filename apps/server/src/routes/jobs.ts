import {
  cancelJobInputSchema,
  createJobInputSchema,
  listJobsQuerySchema,
  updateJobInputSchema,
} from "@boda-dispatch/shared";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";

import {
  type ChangeJobResult,
  changeJob,
  createJob,
  listJobs,
} from "../jobs/service.js";
import { parseInput } from "./validate.js";

const jobParamsSchema = z.object({ id: z.uuid() });

const sendChangeResult = (reply: FastifyReply, result: ChangeJobResult) => {
  switch (result.kind) {
    case "ok":
      return result.job;
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
        message: result.message,
        job: result.job,
      });
  }
};

const jobRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.post("/", async (request, reply) => {
    const body = parseInput(createJobInputSchema, request.body, reply);
    if (!body) return reply;

    const job = await createJob(app.db, request.dispatcher.id, body);
    return reply.code(201).send(job);
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

  app.patch("/:id", async (request, reply) => {
    const params = parseInput(jobParamsSchema, request.params, reply, "job id");
    if (!params) return reply;
    const body = parseInput(updateJobInputSchema, request.body, reply);
    if (!body) return reply;

    return sendChangeResult(
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
      reply,
      await changeJob(app.db, request.dispatcher.id, params.id, {
        status: "CANCELLED",
        ...body,
      }),
    );
  });
};

export default jobRoutes;
