import { PubSub, type Message, type Subscription } from "@google-cloud/pubsub";

import { RoleplayTurnJobSchema } from "@neontalk/contracts";
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
const rawModelOutputPreviewLength = 2000;

const pubsubClient = roleplayTurnsSubscriptionName
  ? new PubSub(projectId ? { projectId } : undefined)
  : null;

let roleplayTurnsSubscription: Subscription | null = null;
let processedCount = 0;
let malformedCount = 0;
let failedCount = 0;
let adapterFailureCount = 0;
let mapperFailureCount = 0;
let persistenceFailureCount = 0;
let shuttingDown = false;

const bootAt = new Date();

function parseMessageData(message: Message) {
  try {
    return {
      ok: true as const,
      payload: JSON.parse(message.data.toString("utf8"))
    };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "Invalid JSON payload."
    };
  }
}

function logHeartbeat(state: string) {
  console.log(
    JSON.stringify({
      service: "ai-worker",
      state,
      subscription: roleplayTurnsSubscriptionName || null,
      maxInFlight,
      bootAt: bootAt.toISOString(),
      heartbeatAt: new Date().toISOString(),
      counters: {
        processed: processedCount,
        malformed: malformedCount,
        failed: failedCount,
        adapterFailures: adapterFailureCount,
        mapperFailures: mapperFailureCount,
        persistenceFailures: persistenceFailureCount
      }
    })
  );
}

async function handleRoleplayTurnMessage(message: Message) {
  const parsedPayload = parseMessageData(message);

  if (!parsedPayload.ok) {
    malformedCount += 1;

    console.error(
      JSON.stringify({
        service: "ai-worker",
        event: "worker.message.invalid_json",
        messageId: message.id,
        outboxEventId: message.attributes.outboxEventId ?? null,
        error: parsedPayload.error
      })
    );

    message.ack();
    return;
  }

  const parsedJob = RoleplayTurnJobSchema.safeParse(parsedPayload.payload);

  if (!parsedJob.success) {
    malformedCount += 1;

    console.error(
      JSON.stringify({
        service: "ai-worker",
        event: "worker.message.invalid_contract",
        messageId: message.id,
        outboxEventId: message.attributes.outboxEventId ?? null,
        issues: parsedJob.error.issues
      })
    );

    message.ack();
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
        savedPhraseCount: persistedTurn.savedPhraseCount
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

    console.error(
      JSON.stringify({
        service: "ai-worker",
        event: "worker.message.retry",
        messageId: message.id,
        outboxEventId: message.attributes.outboxEventId ?? null,
        error: error instanceof Error ? error.message : "Unexpected worker error.",
        code:
          error instanceof AiAdapterError ||
          error instanceof AntiCorruptionMapperError ||
          error instanceof PersistDomainTurnError
            ? error.code
            : null
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
      maxInFlight
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
