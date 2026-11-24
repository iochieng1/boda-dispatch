import {
  createJobInputSchema,
  listJobsQuerySchema,
} from "@boda-dispatch/shared";
import type { FastifyPluginAsync } from "fastify";

import { createJob, listJobs } from "../jobs/service.js";
import { parseInput } from "./validate.js";

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
};

export default jobRoutes;
