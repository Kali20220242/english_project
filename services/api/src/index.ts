import { randomUUID } from "node:crypto";

import Fastify from "fastify";

import {
  CreateSessionSchema,
  RoleplayTurnJobSchema,
  SubmitTurnSchema
} from "@neontalk/contracts";

const app = Fastify({ logger: true });

app.get("/health", async () => {
  return {
    status: "ok",
    service: "api",
    time: new Date().toISOString()
  };
});

app.post("/v1/sessions", async (request, reply) => {
  const parsed = CreateSessionSchema.safeParse(request.body);

  if (!parsed.success) {
    return reply.code(400).send({
      error: "INVALID_SESSION_PAYLOAD",
      issues: parsed.error.flatten()
    });
  }

  return reply.code(201).send({
    sessionId: `sess_${randomUUID()}`,
    state: "created",
    ...parsed.data
  });
});

app.post("/v1/messages", async (request, reply) => {
  const parsed = SubmitTurnSchema.safeParse(request.body);

  if (!parsed.success) {
    return reply.code(400).send({
      error: "INVALID_MESSAGE_PAYLOAD",
      issues: parsed.error.flatten()
    });
  }

  const job = RoleplayTurnJobSchema.parse({
    jobId: `job_${randomUUID()}`,
    type: "ROLEPLAY_TURN",
    requestId: `req_${randomUUID()}`,
    sessionId: parsed.data.sessionId,
    userId: "dev_user",
    seq: parsed.data.seq,
    scenarioId: "dating_confident_v1",
    inputText: parsed.data.message.text,
    contextVersion: 1
  });

  return reply.code(202).send({
    accepted: true,
    queue: "roleplay-turns",
    job
  });
});

const port = Number(process.env.PORT ?? 4000);

app
  .listen({
    host: "0.0.0.0",
    port
  })
  .catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
