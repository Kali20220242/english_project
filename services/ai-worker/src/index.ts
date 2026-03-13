import { PubSub, type Message, type Subscription } from "@google-cloud/pubsub";

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

const roleplayTurnsSubscriptionName =
  process.env.PUBSUB_ROLEPLAY_TURNS_SUBSCRIPTION ?? "";
const projectId =
  process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? undefined;
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
const parsedMaxRetries = Number.parseInt(
  process.env.WORKER_MAX_RETRIES ?? "5",
  10
);
const maxRetries =
  Number.isFinite(parsedMaxRetries) && parsedMaxRetries > 0
    ? parsedMaxRetries
    : 5;
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
    return error.code !== "INVALID_RESULT_CONTEXT";
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
    console.error(
      JSON.stringify({
        service: "ai-worker",
        event: "worker.dlq.persist_failed",
        messageId: input.message.id,
        reason: input.reason,
        error: dlqError instanceof Error ? dlqError.message : String(dlqError)
      })
    );
  }
}

function logHeartbeat(state: string) {
  console.log(
    JSON.stringify({
      service: "ai-worker",
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
    })
  );
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

  console.error(
    JSON.stringify({
      service: "ai-worker",
      event: "worker.message.dlq",
      messageId: input.message.id,
      outboxEventId: input.message.attributes.outboxEventId ?? null,
      sessionId: input.job?.sessionId ?? null,
      reason: input.reason,
      retryable: input.retryable,
      deliveryAttempt: input.deliveryAttempt,
      maxRetries,
      error: buildErrorMessage(input.error),
      code: resolveWorkerErrorCode(input.error)
    })
  );

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
    const aiOutput = await generateRoleplayTurn(parsedJob.data);
    const domainTurn = mapAiPayloadToDomain({
      job: parsedJob.data,
      aiPayload: aiOutput.result
    });
    const persistedTurn = await persistDomainTurn({
      domainTurn,
      sourceUserMessageId: message.attributes.aggregateId ?? null,
      pubsubMessageId: message.id,
      outboxEventId: message.attributes.outboxEventId ?? null,
      aiProvider: aiOutput.provider,
      aiModel: aiOutput.model
    });

    await prisma.eventLog.create({
      data: {
        messageId: persistedTurn.assistantMessageId,
        stream: "pubsub.roleplay-turns",
        streamId: parsedJob.data.sessionId,
        eventType: "ROLEPLAY_TURN_DOMAIN_MAPPED",
        payload: {
          provider: "pubsub",
          messageId: message.id,
          publishTime: message.publishTime
            ? message.publishTime.toISOString()
            : null,
          outboxEventId: message.attributes.outboxEventId ?? null,
          aggregateId: message.attributes.aggregateId ?? null,
          aggregateType: message.attributes.aggregateType ?? null,
          topicType: message.attributes.type ?? null,
          job: parsedJob.data,
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

    processedCount += 1;

    console.log(
      JSON.stringify({
        service: "ai-worker",
        event: "worker.message.ack",
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
      })
    );

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

    console.error(
      JSON.stringify({
        service: "ai-worker",
        event: "worker.message.retry",
        messageId: message.id,
        outboxEventId: message.attributes.outboxEventId ?? null,
        sessionId: parsedJob.data.sessionId,
        error: buildErrorMessage(error),
        code: resolveWorkerErrorCode(error),
        deliveryAttempt,
        nextAttempt: deliveryAttempt + 1,
        maxRetries
      })
    );

    message.nack();
  }
}

async function bootstrap() {
  if (!roleplayTurnsSubscriptionName || !pubsubClient) {
    console.warn(
      "[worker] PUBSUB_ROLEPLAY_TURNS_SUBSCRIPTION is not set. Worker starts in idle mode."
    );

    setInterval(() => {
      logHeartbeat("idle");
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
    console.error(
      JSON.stringify({
        service: "ai-worker",
        event: "worker.subscription.error",
        subscription: roleplayTurnsSubscriptionName,
        error: error.message
      })
    );
  });

  console.log(
    JSON.stringify({
      service: "ai-worker",
      event: "worker.subscription.ready",
      provider: "pubsub",
      subscription: roleplayTurnsSubscriptionName,
      projectId: projectId ?? null,
      maxInFlight,
      maxRetries,
      dlqStream
    })
  );

  setInterval(() => {
    logHeartbeat("consuming");
  }, heartbeatMs);
}

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(
    JSON.stringify({
      service: "ai-worker",
      event: "worker.shutdown.start",
      signal,
      processedCount,
      malformedCount,
      failedCount,
      retriedCount,
      dlqCount,
      adapterFailureCount,
      mapperFailureCount,
      persistenceFailureCount
    })
  );

  if (roleplayTurnsSubscription) {
    roleplayTurnsSubscription.removeAllListeners("message");
    roleplayTurnsSubscription.removeAllListeners("error");
  }

  if (pubsubClient) {
    await pubsubClient.close().catch((error: unknown) => {
      console.error(
        JSON.stringify({
          service: "ai-worker",
          event: "worker.shutdown.pubsub_close_failed",
          error:
            error instanceof Error ? error.message : "Pub/Sub close error."
        })
      );
    });
  }

  await prisma.$disconnect().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        service: "ai-worker",
        event: "worker.shutdown.db_disconnect_failed",
        error:
          error instanceof Error ? error.message : "Database disconnect error."
      })
    );
  });

  console.log(
    JSON.stringify({
      service: "ai-worker",
      event: "worker.shutdown.done"
    })
  );
}

process.once("SIGINT", () => {
  void shutdown("SIGINT").finally(() => process.exit(0));
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM").finally(() => process.exit(0));
});

bootstrap().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      service: "ai-worker",
      event: "worker.bootstrap.failed",
      error: error instanceof Error ? error.message : "Bootstrap failed."
    })
  );

  void shutdown("SIGTERM").finally(() => process.exit(1));
});
