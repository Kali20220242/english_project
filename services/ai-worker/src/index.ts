import { createServer, type Server } from "node:http";

import { PubSub, type Message, type Subscription } from "@google-cloud/pubsub";
import { OutboxStatus } from "@prisma/client";

import { RoleplayTurnJobSchema, type RoleplayTurnJob } from "@neontalk/contracts";
import { prisma } from "@neontalk/db";
import {
  AntiCorruptionMapperError,
  mapAiPayloadToDomain
} from "./lib/anti-corruption-mapper";
import { AiAdapterError, generateRoleplayTurn } from "./lib/ai-adapter";
import {
  PersistDomainTurnError,
  persistDomainTurn
} from "./lib/persist-domain-turn";
import {
  logWorker,
  registerWorkerProcessErrorHandlers,
  trackWorkerError
} from "./lib/observability";

const roleplayTurnsSubscriptionName =
  process.env.PUBSUB_ROLEPLAY_TURNS_SUBSCRIPTION ?? "";
const projectId =
  process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? undefined;
const roleplayTurnsTopic = "roleplay-turns";
const parsedMaxInFlight = Number.parseInt(
  process.env.WORKER_MAX_IN_FLIGHT ?? "10",
  10
);
const maxInFlight =
  Number.isFinite(parsedMaxInFlight) && parsedMaxInFlight > 0
    ? parsedMaxInFlight
    : 10;
const parsedHeartbeatMs = Number.parseInt(
  process.env.WORKER_HEARTBEAT_MS ?? "30000",
  10
);
const heartbeatMs =
  Number.isFinite(parsedHeartbeatMs) && parsedHeartbeatMs > 0
    ? parsedHeartbeatMs
    : 30000;
const parsedOutboxPollMs = Number.parseInt(
  process.env.WORKER_OUTBOX_POLL_MS ?? "1500",
  10
);
const outboxPollMs =
  Number.isFinite(parsedOutboxPollMs) && parsedOutboxPollMs > 0
    ? parsedOutboxPollMs
    : 1500;
const parsedOutboxRetryDelayMs = Number.parseInt(
  process.env.WORKER_OUTBOX_RETRY_DELAY_MS ?? "60000",
  10
);
const outboxRetryDelayMs =
  Number.isFinite(parsedOutboxRetryDelayMs) && parsedOutboxRetryDelayMs > 0
    ? parsedOutboxRetryDelayMs
    : 60000;
const parsedMaxRetries = Number.parseInt(
  process.env.WORKER_MAX_RETRIES ?? "5",
  10
);
const maxRetries =
  Number.isFinite(parsedMaxRetries) && parsedMaxRetries > 0
    ? parsedMaxRetries
    : 5;
const parsedWorkerPort = Number.parseInt(process.env.PORT ?? "8080", 10);
const workerPort =
  Number.isFinite(parsedWorkerPort) && parsedWorkerPort > 0
    ? parsedWorkerPort
    : 8080;
const dlqStream = process.env.WORKER_DLQ_STREAM?.trim() || "worker.dlq";
const rawPayloadPreviewLength = 2000;
const rawModelOutputPreviewLength = 2000;

const pubsubClient = roleplayTurnsSubscriptionName
  ? new PubSub(projectId ? { projectId } : undefined)
  : null;

let roleplayTurnsSubscription: Subscription | null = null;
let processedCount = 0;
let malformedCount = 0;
let failedCount = 0;
let retriedCount = 0;
let dlqCount = 0;
let adapterFailureCount = 0;
let mapperFailureCount = 0;
let persistenceFailureCount = 0;
let shuttingDown = false;
let healthServer: Server | null = null;
let outboxPollingInFlight = false;

const bootAt = new Date();

type ParsedMessageData =
  | {
      ok: true;
      payload: unknown;
      payloadText: string;
    }
  | {
      ok: false;
      payloadText: string;
      error: string;
    };

function resolveWorkerState() {
  if (shuttingDown) {
    return "shutting_down";
  }

  if (!roleplayTurnsSubscriptionName || !pubsubClient) {
    return "consuming_outbox";
  }

  return roleplayTurnsSubscription ? "consuming" : "starting";
}

function buildHealthPayload() {
  return {
    status: "ok",
    service: "ai-worker",
    state: resolveWorkerState(),
    time: new Date().toISOString(),
    subscription: roleplayTurnsSubscriptionName || null,
    counters: {
      processed: processedCount,
      malformed: malformedCount,
      failed: failedCount,
      retried: retriedCount,
      dlq: dlqCount
    }
  };
}

type ProcessRoleplayTurnInput = {
  job: RoleplayTurnJob;
  messageId: string;
  outboxEventId: string | null;
  sourceUserMessageId: string | null;
  publishTime: Date | null;
  transport: "pubsub" | "outbox";
  payloadText?: string | null;
  attributes?: {
    aggregateId?: string | null;
    aggregateType?: string | null;
    type?: string | null;
  };
};

async function processRoleplayTurn(input: ProcessRoleplayTurnInput) {
  const aiOutput = await generateRoleplayTurn(input.job);
  const domainTurn = mapAiPayloadToDomain({
    job: input.job,
    aiPayload: aiOutput.result
  });
  const persistedTurn = await persistDomainTurn({
    domainTurn,
    sourceUserMessageId: input.sourceUserMessageId,
    pubsubMessageId: input.messageId,
    outboxEventId: input.outboxEventId,
    aiProvider: aiOutput.provider,
    aiModel: aiOutput.model
  });

  await prisma.eventLog.create({
    data: {
      messageId: persistedTurn.assistantMessageId,
      stream:
        input.transport === "pubsub"
          ? "pubsub.roleplay-turns"
          : "outbox.roleplay-turns",
      streamId: input.job.sessionId,
      eventType: "ROLEPLAY_TURN_DOMAIN_MAPPED",
      payload: {
        provider: input.transport,
        messageId: input.messageId,
        publishTime: input.publishTime ? input.publishTime.toISOString() : null,
        outboxEventId: input.outboxEventId,
        aggregateId: input.attributes?.aggregateId ?? null,
        aggregateType: input.attributes?.aggregateType ?? null,
        topicType: input.attributes?.type ?? null,
        job: input.job,
        rawPayloadPreview: input.payloadText?.slice(0, rawPayloadPreviewLength) ?? null,
        aiAdapter: {
          provider: aiOutput.provider,
          model: aiOutput.model,
          rawPreview: aiOutput.rawContent.slice(0, rawModelOutputPreviewLength)
        },
        result: aiOutput.result,
        domainTurn,
        persistedTurn
      }
    }
  });

  return {
    aiOutput,
    persistedTurn
  };
}

async function startHealthServer() {
  if (healthServer) {
    return;
  }

  healthServer = createServer((request, response) => {
    if (request.url === "/health") {
      response.statusCode = 200;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify(buildHealthPayload()));
      return;
    }

    response.statusCode = 200;
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.end("ok");
  });

  await new Promise<void>((resolve, reject) => {
    healthServer?.once("error", reject);
    healthServer?.listen(workerPort, "0.0.0.0", () => {
      resolve();
    });
  });

  logWorker("info", "worker.health.ready", {
    port: workerPort
  });
}

function parseMessageData(message: Message): ParsedMessageData {
  const payloadText = message.data.toString("utf8");

  try {
    return {
      ok: true,
      payload: JSON.parse(payloadText),
      payloadText
    };
  } catch (error) {
    return {
      ok: false,
      payloadText,
      error: error instanceof Error ? error.message : "Invalid JSON payload."
    };
  }
}

function getDeliveryAttempt(message: Message) {
  const attempt = (
    message as Message & {
      deliveryAttempt?: number;
    }
  ).deliveryAttempt;

  return typeof attempt === "number" && attempt > 0 ? attempt : 1;
}

function resolveWorkerErrorCode(error: unknown) {
  if (
    error instanceof AiAdapterError ||
    error instanceof AntiCorruptionMapperError ||
    error instanceof PersistDomainTurnError
  ) {
    return error.code;
  }

  if (error instanceof Error && error.name) {
    return error.name;
  }

  return "UNKNOWN_ERROR";
}

function resolveWorkerErrorDetails(error: unknown) {
  if (
    error instanceof AiAdapterError ||
    error instanceof AntiCorruptionMapperError ||
    error instanceof PersistDomainTurnError
  ) {
    return error.details ?? null;
  }

  return null;
}

function isRetryableProcessingError(error: unknown) {
  if (error instanceof AntiCorruptionMapperError) {
    return false;
  }

  if (error instanceof PersistDomainTurnError) {
    return error.code === "SOURCE_USER_MESSAGE_NOT_FOUND";
  }

  if (error instanceof AiAdapterError) {
    return (
      error.code !== "INVALID_RESULT_CONTEXT" &&
      error.code !== "MODEL_PROVIDER_NOT_CONFIGURED"
    );
  }

  return true;
}

function buildDlqStreamId(input: {
  message: Message;
  job: RoleplayTurnJob | null;
}) {
  if (input.job?.sessionId) {
    return input.job.sessionId;
  }

  if (input.message.attributes.outboxEventId) {
    return input.message.attributes.outboxEventId;
  }

  if (input.message.attributes.aggregateId) {
    return input.message.attributes.aggregateId;
  }

  return input.message.id;
}

function buildErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "Unexpected worker error.";
}

async function writeDlqEvent(input: {
  message: Message;
  job: RoleplayTurnJob | null;
  payloadText: string;
  reason: string;
  error: unknown;
  retryable: boolean;
  deliveryAttempt: number;
}) {
  const errorCode = resolveWorkerErrorCode(input.error);
  const errorDetails = resolveWorkerErrorDetails(input.error);
  const errorMessage = buildErrorMessage(input.error);

  try {
    await prisma.eventLog.create({
      data: {
        stream: dlqStream,
        streamId: buildDlqStreamId({
          message: input.message,
          job: input.job
        }),
        eventType: "ROLEPLAY_TURN_DLQ",
        payload: {
          reason: input.reason,
          retryable: input.retryable,
          deliveryAttempt: input.deliveryAttempt,
          maxRetries,
          error: {
            code: errorCode,
            message: errorMessage,
            details: errorDetails
          },
          message: {
            id: input.message.id,
            outboxEventId: input.message.attributes.outboxEventId ?? null,
            aggregateId: input.message.attributes.aggregateId ?? null,
            aggregateType: input.message.attributes.aggregateType ?? null,
            type: input.message.attributes.type ?? null,
            publishTime: input.message.publishTime
              ? input.message.publishTime.toISOString()
              : null
          },
          job: input.job,
          payloadPreview: input.payloadText.slice(0, rawPayloadPreviewLength)
        }
      }
    });
  } catch (dlqError) {
    logWorker("error", "worker.dlq.persist_failed", {
      messageId: input.message.id,
      reason: input.reason,
      error: dlqError instanceof Error ? dlqError.message : String(dlqError)
    });
  }
}

function logHeartbeat(state: string) {
  logWorker("info", "worker.heartbeat", {
    state,
    subscription: roleplayTurnsSubscriptionName || null,
    maxInFlight,
    maxRetries,
    dlqStream,
    bootAt: bootAt.toISOString(),
    heartbeatAt: new Date().toISOString(),
    counters: {
      processed: processedCount,
      malformed: malformedCount,
      failed: failedCount,
      retried: retriedCount,
      dlq: dlqCount,
      adapterFailures: adapterFailureCount,
      mapperFailures: mapperFailureCount,
      persistenceFailures: persistenceFailureCount
    }
  });
}

async function moveMessageToDlq(input: {
  message: Message;
  job: RoleplayTurnJob | null;
  payloadText: string;
  reason: string;
  error: unknown;
  retryable: boolean;
  deliveryAttempt: number;
}) {
  dlqCount += 1;

  await writeDlqEvent({
    message: input.message,
    job: input.job,
    payloadText: input.payloadText,
    reason: input.reason,
    error: input.error,
    retryable: input.retryable,
    deliveryAttempt: input.deliveryAttempt
  });

  logWorker("error", "worker.message.dlq", {
    messageId: input.message.id,
    outboxEventId: input.message.attributes.outboxEventId ?? null,
    sessionId: input.job?.sessionId ?? null,
    reason: input.reason,
    retryable: input.retryable,
    deliveryAttempt: input.deliveryAttempt,
    maxRetries,
    error: buildErrorMessage(input.error),
    code: resolveWorkerErrorCode(input.error)
  });

  await trackWorkerError({
    event: "worker.message.dlq",
    error: input.error,
    context: {
      messageId: input.message.id,
      outboxEventId: input.message.attributes.outboxEventId ?? null,
      sessionId: input.job?.sessionId ?? null,
      reason: input.reason,
      retryable: input.retryable,
      deliveryAttempt: input.deliveryAttempt,
      maxRetries
    }
  });

  input.message.ack();
}

async function handleRoleplayTurnMessage(message: Message) {
  const deliveryAttempt = getDeliveryAttempt(message);
  const parsedPayload = parseMessageData(message);

  if (!parsedPayload.ok) {
    malformedCount += 1;

    await moveMessageToDlq({
      message,
      job: null,
      payloadText: parsedPayload.payloadText,
      reason: "INVALID_JSON_PAYLOAD",
      error: new Error(parsedPayload.error),
      retryable: false,
      deliveryAttempt
    });

    return;
  }

  const parsedJob = RoleplayTurnJobSchema.safeParse(parsedPayload.payload);

  if (!parsedJob.success) {
    malformedCount += 1;

    await moveMessageToDlq({
      message,
      job: null,
      payloadText: parsedPayload.payloadText,
      reason: "INVALID_JOB_CONTRACT",
      error: parsedJob.error,
      retryable: false,
      deliveryAttempt
    });

    return;
  }

  try {
    const { aiOutput, persistedTurn } = await processRoleplayTurn({
      job: parsedJob.data,
      messageId: message.id,
      outboxEventId: message.attributes.outboxEventId ?? null,
      sourceUserMessageId: message.attributes.aggregateId ?? null,
      publishTime: message.publishTime ?? null,
      transport: "pubsub",
      payloadText: parsedPayload.payloadText,
      attributes: {
        aggregateId: message.attributes.aggregateId ?? null,
        aggregateType: message.attributes.aggregateType ?? null,
        type: message.attributes.type ?? null
      }
    });

    processedCount += 1;

    logWorker("info", "worker.message.ack", {
      messageId: message.id,
      outboxEventId: message.attributes.outboxEventId ?? null,
      sessionId: parsedJob.data.sessionId,
      seq: parsedJob.data.seq,
      provider: aiOutput.provider,
      model: aiOutput.model,
      replayed: persistedTurn.replayed,
      assistantMessageId: persistedTurn.assistantMessageId,
      savedPhraseCount: persistedTurn.savedPhraseCount,
      deliveryAttempt
    });

    message.ack();
  } catch (error) {
    failedCount += 1;
    if (error instanceof AiAdapterError) {
      adapterFailureCount += 1;
    }
    if (error instanceof AntiCorruptionMapperError) {
      mapperFailureCount += 1;
    }
    if (error instanceof PersistDomainTurnError) {
      persistenceFailureCount += 1;
    }

    const retryable = isRetryableProcessingError(error);
    const reachedRetryLimit = deliveryAttempt >= maxRetries;

    if (!retryable || reachedRetryLimit) {
      await moveMessageToDlq({
        message,
        job: parsedJob.data,
        payloadText: parsedPayload.payloadText,
        reason: !retryable ? "NON_RETRYABLE_ERROR" : "MAX_RETRIES_EXCEEDED",
        error,
        retryable,
        deliveryAttempt
      });

      return;
    }

    retriedCount += 1;

    logWorker("warn", "worker.message.retry", {
      messageId: message.id,
      outboxEventId: message.attributes.outboxEventId ?? null,
      sessionId: parsedJob.data.sessionId,
      error: buildErrorMessage(error),
      code: resolveWorkerErrorCode(error),
      deliveryAttempt,
      nextAttempt: deliveryAttempt + 1,
      maxRetries
    });

    message.nack();
  }
}

type ClaimableOutboxEvent = {
  id: string;
  sessionId: string | null;
  aggregateId: string;
  aggregateType: string;
  payload: unknown;
  attempts: number;
};

async function fetchClaimableOutboxEvents() {
  const now = new Date();
  const candidates = await prisma.outboxEvent.findMany({
    where: {
      topic: roleplayTurnsTopic,
      status: {
        in: [OutboxStatus.PENDING, OutboxStatus.FAILED]
      },
      nextAttemptAt: {
        lte: now
      }
    },
    orderBy: [
      {
        nextAttemptAt: "asc"
      },
      {
        createdAt: "asc"
      }
    ],
    take: maxInFlight,
    select: {
      id: true,
      sessionId: true,
      aggregateId: true,
      aggregateType: true,
      payload: true,
      attempts: true
    }
  });

  const claimed: ClaimableOutboxEvent[] = [];

  for (const candidate of candidates) {
    const claimedRow = await prisma.outboxEvent.updateMany({
      where: {
        id: candidate.id,
        status: {
          in: [OutboxStatus.PENDING, OutboxStatus.FAILED]
        },
        nextAttemptAt: {
          lte: now
        }
      },
      data: {
        status: OutboxStatus.PROCESSING
      }
    });

    if (claimedRow.count === 1) {
      claimed.push(candidate);
    }
  }

  return claimed;
}

async function finalizeOutboxSuccess(eventId: string) {
  await prisma.outboxEvent.update({
    where: {
      id: eventId
    },
    data: {
      status: OutboxStatus.SENT,
      attempts: {
        increment: 1
      },
      errorText: null,
      nextAttemptAt: new Date()
    }
  });
}

async function finalizeOutboxFailure(input: {
  eventId: string;
  errorText: string;
  nextAttemptAt: Date;
}) {
  await prisma.outboxEvent.update({
    where: {
      id: input.eventId
    },
    data: {
      status: OutboxStatus.FAILED,
      attempts: {
        increment: 1
      },
      errorText: input.errorText.slice(0, 1000),
      nextAttemptAt: input.nextAttemptAt
    }
  });
}

async function writeOutboxDlqEvent(input: {
  eventId: string;
  sessionId: string | null;
  aggregateId: string;
  aggregateType: string;
  payloadText: string;
  job: RoleplayTurnJob | null;
  reason: string;
  retryable: boolean;
  attempt: number;
  error: unknown;
}) {
  const errorCode = resolveWorkerErrorCode(input.error);
  const errorDetails = resolveWorkerErrorDetails(input.error);
  const errorMessage = buildErrorMessage(input.error);

  try {
    await prisma.eventLog.create({
      data: {
        stream: dlqStream,
        streamId: input.sessionId ?? input.aggregateId ?? input.eventId,
        eventType: "ROLEPLAY_TURN_DLQ",
        payload: {
          reason: input.reason,
          retryable: input.retryable,
          deliveryAttempt: input.attempt,
          maxRetries,
          error: {
            code: errorCode,
            message: errorMessage,
            details: errorDetails
          },
          outboxEvent: {
            id: input.eventId,
            sessionId: input.sessionId,
            aggregateId: input.aggregateId,
            aggregateType: input.aggregateType
          },
          job: input.job,
          payloadPreview: input.payloadText.slice(0, rawPayloadPreviewLength)
        }
      }
    });
  } catch (dlqError) {
    logWorker("error", "worker.outbox.dlq.persist_failed", {
      outboxEventId: input.eventId,
      reason: input.reason,
      error: dlqError instanceof Error ? dlqError.message : String(dlqError)
    });
  }
}

async function processOutboxEvent(event: ClaimableOutboxEvent) {
  const payloadText = JSON.stringify(event.payload ?? null);
  const parsedJob = RoleplayTurnJobSchema.safeParse(event.payload);
  const attempt = event.attempts + 1;

  if (!parsedJob.success) {
    malformedCount += 1;

    await finalizeOutboxFailure({
      eventId: event.id,
      errorText: "INVALID_JOB_CONTRACT",
      nextAttemptAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    });

    await writeOutboxDlqEvent({
      eventId: event.id,
      sessionId: event.sessionId,
      aggregateId: event.aggregateId,
      aggregateType: event.aggregateType,
      payloadText,
      job: null,
      reason: "INVALID_JOB_CONTRACT",
      retryable: false,
      attempt,
      error: parsedJob.error
    });

    return;
  }

  try {
    const { aiOutput, persistedTurn } = await processRoleplayTurn({
      job: parsedJob.data,
      messageId: `outbox:${event.id}`,
      outboxEventId: event.id,
      sourceUserMessageId: event.aggregateId ?? null,
      publishTime: null,
      transport: "outbox",
      payloadText,
      attributes: {
        aggregateId: event.aggregateId,
        aggregateType: event.aggregateType,
        type: parsedJob.data.type
      }
    });

    await finalizeOutboxSuccess(event.id);
    processedCount += 1;

    logWorker("info", "worker.outbox.processed", {
      outboxEventId: event.id,
      sessionId: parsedJob.data.sessionId,
      seq: parsedJob.data.seq,
      provider: aiOutput.provider,
      model: aiOutput.model,
      replayed: persistedTurn.replayed,
      assistantMessageId: persistedTurn.assistantMessageId,
      savedPhraseCount: persistedTurn.savedPhraseCount,
      attempt
    });
  } catch (error) {
    failedCount += 1;
    if (error instanceof AiAdapterError) {
      adapterFailureCount += 1;
    }
    if (error instanceof AntiCorruptionMapperError) {
      mapperFailureCount += 1;
    }
    if (error instanceof PersistDomainTurnError) {
      persistenceFailureCount += 1;
    }

    const retryable = isRetryableProcessingError(error);
    const reachedRetryLimit = attempt >= maxRetries;

    if (!retryable || reachedRetryLimit) {
      dlqCount += 1;

      await finalizeOutboxFailure({
        eventId: event.id,
        errorText: buildErrorMessage(error),
        nextAttemptAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
      });

      await writeOutboxDlqEvent({
        eventId: event.id,
        sessionId: event.sessionId,
        aggregateId: event.aggregateId,
        aggregateType: event.aggregateType,
        payloadText,
        job: parsedJob.data,
        reason: !retryable ? "NON_RETRYABLE_ERROR" : "MAX_RETRIES_EXCEEDED",
        retryable,
        attempt,
        error
      });

      logWorker("error", "worker.outbox.dlq", {
        outboxEventId: event.id,
        sessionId: parsedJob.data.sessionId,
        reason: !retryable ? "NON_RETRYABLE_ERROR" : "MAX_RETRIES_EXCEEDED",
        retryable,
        attempt,
        maxRetries,
        code: resolveWorkerErrorCode(error),
        error: buildErrorMessage(error)
      });

      await trackWorkerError({
        event: "worker.outbox.dlq",
        error,
        context: {
          outboxEventId: event.id,
          sessionId: parsedJob.data.sessionId,
          retryable,
          attempt,
          maxRetries
        }
      });

      return;
    }

    retriedCount += 1;

    await finalizeOutboxFailure({
      eventId: event.id,
      errorText: buildErrorMessage(error),
      nextAttemptAt: new Date(Date.now() + outboxRetryDelayMs)
    });

    logWorker("warn", "worker.outbox.retry", {
      outboxEventId: event.id,
      sessionId: parsedJob.data.sessionId,
      attempt,
      nextAttempt: attempt + 1,
      maxRetries,
      code: resolveWorkerErrorCode(error),
      error: buildErrorMessage(error)
    });
  }
}

async function pollOutboxOnce() {
  if (outboxPollingInFlight || shuttingDown) {
    return;
  }

  outboxPollingInFlight = true;

  try {
    const claimedEvents = await fetchClaimableOutboxEvents();

    for (const event of claimedEvents) {
      await processOutboxEvent(event);
    }
  } catch (error) {
    logWorker("error", "worker.outbox.poll.failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    await trackWorkerError({
      event: "worker.outbox.poll.failed",
      error
    });
  } finally {
    outboxPollingInFlight = false;
  }
}

async function bootstrap() {
  await startHealthServer();

  if (!roleplayTurnsSubscriptionName || !pubsubClient) {
    logWorker("warn", "worker.subscription.idle", {
      reason:
        "PUBSUB_ROLEPLAY_TURNS_SUBSCRIPTION is not set. Falling back to outbox polling mode."
    });

    logWorker("info", "worker.outbox.poller.ready", {
      topic: roleplayTurnsTopic,
      pollIntervalMs: outboxPollMs,
      maxInFlight,
      maxRetries
    });

    void pollOutboxOnce();
    setInterval(() => {
      void pollOutboxOnce();
    }, outboxPollMs);

    setInterval(() => {
      logHeartbeat("consuming_outbox");
    }, heartbeatMs);

    return;
  }

  roleplayTurnsSubscription = pubsubClient.subscription(
    roleplayTurnsSubscriptionName,
    {
      flowControl: {
        maxMessages: maxInFlight
      }
    }
  );

  roleplayTurnsSubscription.on("message", (message) => {
    void handleRoleplayTurnMessage(message);
  });

  roleplayTurnsSubscription.on("error", (error) => {
    logWorker("error", "worker.subscription.error", {
      subscription: roleplayTurnsSubscriptionName,
      error: error.message
    });
    void trackWorkerError({
      event: "worker.subscription.error",
      error,
      context: {
        subscription: roleplayTurnsSubscriptionName
      }
    });
  });

  logWorker("info", "worker.subscription.ready", {
    provider: "pubsub",
    subscription: roleplayTurnsSubscriptionName,
    projectId: projectId ?? null,
    maxInFlight,
    maxRetries,
    dlqStream
  });

  setInterval(() => {
    logHeartbeat("consuming");
  }, heartbeatMs);
}

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  logWorker("info", "worker.shutdown.start", {
    signal,
    processedCount,
    malformedCount,
    failedCount,
    retriedCount,
    dlqCount,
    adapterFailureCount,
    mapperFailureCount,
    persistenceFailureCount
  });

  if (roleplayTurnsSubscription) {
    roleplayTurnsSubscription.removeAllListeners("message");
    roleplayTurnsSubscription.removeAllListeners("error");
  }

  if (pubsubClient) {
    await pubsubClient.close().catch((error: unknown) => {
      logWorker("error", "worker.shutdown.pubsub_close_failed", {
        error: error instanceof Error ? error.message : "Pub/Sub close error."
      });
    });
  }

  if (healthServer) {
    await new Promise<void>((resolve) => {
      healthServer?.close(() => resolve());
    });
    healthServer = null;
  }

  await prisma.$disconnect().catch((error: unknown) => {
    logWorker("error", "worker.shutdown.db_disconnect_failed", {
      error:
        error instanceof Error ? error.message : "Database disconnect error."
    });
  });

  logWorker("info", "worker.shutdown.done");
}

registerWorkerProcessErrorHandlers({
  onFatal: () => shutdown("SIGTERM")
});

process.once("SIGINT", () => {
  void shutdown("SIGINT").finally(() => process.exit(0));
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM").finally(() => process.exit(0));
});

bootstrap().catch((error: unknown) => {
  void trackWorkerError({
    event: "worker.bootstrap.failed",
    error
  }).finally(() => {
    void shutdown("SIGTERM").finally(() => process.exit(1));
  });
});
