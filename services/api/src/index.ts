import { createHash, randomUUID } from "node:crypto";

import Fastify from "fastify";
import type { RedisClientType } from "redis";

import { prisma } from "@neontalk/db";
import { MessageRole, OutboxStatus, Prisma, SessionStatus } from "@prisma/client";
import {
  CreateSessionSchema,
  RoleplayTurnJobSchema,
  SubmitTurnSchema
} from "@neontalk/contracts";

import { verifyFirebaseIdToken } from "./middleware/firebase-auth";
import {
  rateLimitAuthEndpoint,
  rateLimitMessageWrite,
  rateLimitSessionRead,
  rateLimitSessionWrite
} from "./middleware/rate-limit";
import { roleplayTurnPublisher } from "./lib/pubsub-publisher";
import { hasRedisConfig, redisClient } from "./lib/redis";

declare module "fastify" {
  interface FastifyInstance {
    redis: RedisClientType | null;
    outboxPublisher: typeof roleplayTurnPublisher;
  }
}

const app = Fastify({ logger: true });
app.decorateRequest("authUser", null);
app.decorateRequest("authDbUser", null);
app.decorate("redis", redisClient);
app.decorate("outboxPublisher", roleplayTurnPublisher);
app.addHook("onClose", async (instance) => {
  if (instance.redis?.isOpen) {
    await instance.redis.quit();
  }
});

const MESSAGE_IDEMPOTENCY_SCOPE = "submit_turn";
const MESSAGE_IDEMPOTENCY_TTL_HOURS = 24;
const ROLEPLAY_TURN_QUEUE = "roleplay-turns";
const ROLEPLAY_TURN_OUTBOX_AGGREGATE_TYPE = "Message";
const OUTBOX_PUBLISH_RETRY_DELAY_MS = 60_000;
const parsedSessionTurnLockTtl = Number.parseInt(
  process.env.REDIS_SESSION_LOCK_TTL_SEC ?? "15",
  10
);
const SESSION_TURN_LOCK_TTL_SECONDS =
  Number.isFinite(parsedSessionTurnLockTtl) && parsedSessionTurnLockTtl > 0
    ? parsedSessionTurnLockTtl
    : 15;

function buildSubmitTurnRequestHash(input: {
  sessionId: string;
  seq: number;
  text: string;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sessionId: input.sessionId,
        seq: input.seq,
        text: input.text
      })
    )
    .digest("hex");
}

function buildIdempotencyEntityId(input: {
  userId: string;
  scope: string;
  key: string;
}) {
  return `${input.userId}:${input.scope}:${input.key}`;
}

function buildActor(firebaseUid: string) {
  return `firebase:${firebaseUid}`;
}

function buildErrorText(error: unknown) {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.slice(0, 1000);
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error.slice(0, 1000);
  }

  return "Unknown publisher error.";
}

async function releaseRedisLock(
  redis: RedisClientType,
  key: string,
  token: string
) {
  await redis.eval(
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
    {
      keys: [key],
      arguments: [token]
    }
  );
}

app.get("/health", async () => {
  const redisStatus = !app.redis
    ? "disabled"
    : app.redis.isReady
      ? "ready"
      : app.redis.isOpen
        ? "connected"
        : "disconnected";
  const pubsubStatus = app.outboxPublisher.isConfigured
    ? "configured"
    : "disabled";

  return {
    status: "ok",
    service: "api",
    time: new Date().toISOString(),
    dependencies: {
      redis: redisStatus,
      pubsub: pubsubStatus
    }
  };
});

app.get(
  "/v1/me",
  { preHandler: [verifyFirebaseIdToken, rateLimitAuthEndpoint] },
  async (request, reply) => {
  if (!request.authUser || !request.authDbUser) {
    return reply.code(401).send({
      error: "UNAUTHORIZED",
      message: "Missing authenticated Firebase user context."
    });
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: request.authDbUser.id },
    include: { profile: true }
  });

  if (!dbUser) {
    return reply.code(404).send({
      error: "USER_NOT_FOUND",
      message: "Authenticated user is not found in database."
    });
  }

  return reply.code(200).send({
    user: {
      id: dbUser.id,
      email: dbUser.email,
      firebaseUid: dbUser.firebaseUid,
      createdAt: dbUser.createdAt,
      updatedAt: dbUser.updatedAt
    },
    profile: dbUser.profile
      ? {
          level: dbUser.profile.level,
          nativeLanguage: dbUser.profile.nativeLanguage,
          targetLanguage: dbUser.profile.targetLanguage,
          goals: dbUser.profile.goals,
          personaStyle: dbUser.profile.personaStyle
        }
      : null,
    auth: {
      firebaseUid: request.authUser.uid,
      emailVerified: request.authUser.email_verified ?? false
    }
  });
  }
);

app.get(
  "/v1/sessions/:id",
  { preHandler: [verifyFirebaseIdToken, rateLimitSessionRead] },
  async (request, reply) => {
  if (!request.authDbUser) {
    return reply.code(401).send({
      error: "UNAUTHORIZED",
      message: "Missing authenticated database user context."
    });
  }

  const { id } = request.params as { id?: string };

  if (!id) {
    return reply.code(400).send({
      error: "INVALID_SESSION_ID",
      message: "Session id is required."
    });
  }

  const session = await prisma.session.findFirst({
    where: {
      id,
      userId: request.authDbUser.id
    },
    select: {
      id: true,
      status: true,
      contextVersion: true,
      startedAt: true,
      finishedAt: true,
      createdAt: true,
      updatedAt: true,
      scenario: {
        select: {
          id: true,
          slug: true,
          title: true,
          theme: true,
          difficulty: true
        }
      },
      _count: {
        select: {
          messages: true,
          savedPhrases: true
        }
      }
    }
  });

  if (!session) {
    return reply.code(404).send({
      error: "SESSION_NOT_FOUND",
      message: "Session was not found for the current user."
    });
  }

  return reply.code(200).send({
    session
  });
  }
);

app.get(
  "/v1/sessions",
  { preHandler: [verifyFirebaseIdToken, rateLimitSessionRead] },
  async (request, reply) => {
  if (!request.authDbUser) {
    return reply.code(401).send({
      error: "UNAUTHORIZED",
      message: "Missing authenticated database user context."
    });
  }

  const query = request.query as {
    page?: string;
    limit?: string;
    status?: string;
  };

  const parsedPage = Number.parseInt(query.page ?? "1", 10);
  const parsedLimit = Number.parseInt(query.limit ?? "20", 10);
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 50)
      : 20;

  const rawStatus = query.status?.toUpperCase();
  let statusFilter: SessionStatus | undefined;

  if (rawStatus) {
    const allowedStatuses = new Set<SessionStatus>([
      SessionStatus.ACTIVE,
      SessionStatus.COMPLETED,
      SessionStatus.ARCHIVED
    ]);

    if (!allowedStatuses.has(rawStatus as SessionStatus)) {
      return reply.code(400).send({
        error: "INVALID_STATUS_FILTER",
        message: "status must be one of: ACTIVE, COMPLETED, ARCHIVED."
      });
    }

    statusFilter = rawStatus as SessionStatus;
  }

  const whereClause = {
    userId: request.authDbUser.id,
    ...(statusFilter ? { status: statusFilter } : {})
  };

  const [items, total] = await Promise.all([
    prisma.session.findMany({
      where: whereClause,
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        status: true,
        contextVersion: true,
        startedAt: true,
        finishedAt: true,
        createdAt: true,
        updatedAt: true,
        scenario: {
          select: {
            id: true,
            slug: true,
            title: true,
            theme: true,
            difficulty: true
          }
        },
        _count: {
          select: {
            messages: true
          }
        }
      }
    }),
    prisma.session.count({
      where: whereClause
    })
  ]);

  return reply.code(200).send({
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit))
    },
    filters: {
      status: statusFilter ?? null
    }
  });
  }
);

app.post(
  "/v1/sessions",
  { preHandler: [verifyFirebaseIdToken, rateLimitSessionWrite] },
  async (request, reply) => {
  if (!request.authUser || !request.authDbUser) {
    return reply.code(401).send({
      error: "UNAUTHORIZED",
      message: "Missing authenticated Firebase user context."
    });
  }

  const authUser = request.authUser;
  const authDbUser = request.authDbUser;

  const parsed = CreateSessionSchema.safeParse(request.body);

  if (!parsed.success) {
    return reply.code(400).send({
      error: "INVALID_SESSION_PAYLOAD",
      issues: parsed.error.flatten()
    });
  }

  const scenario = await prisma.scenario.findFirst({
    where: {
      isActive: true,
      OR: [
        { id: parsed.data.scenarioId },
        { slug: parsed.data.scenarioId }
      ]
    }
  });

  if (!scenario) {
    return reply.code(404).send({
      error: "SCENARIO_NOT_FOUND",
      message: "Requested scenario is not found or inactive."
    });
  }

  const session = await prisma.$transaction(async (tx) => {
    const createdSession = await tx.session.create({
      data: {
        userId: authDbUser.id,
        scenarioId: scenario.id
      },
      select: {
        id: true,
        status: true,
        contextVersion: true,
        startedAt: true,
        createdAt: true
      }
    });

    await tx.auditLog.create({
      data: {
        userId: authDbUser.id,
        actor: buildActor(authUser.uid),
        action: "SESSION_CREATED",
        entityType: "Session",
        entityId: createdSession.id,
        payload: {
          scenarioId: scenario.id,
          scenarioSlug: scenario.slug,
          level: parsed.data.level,
          personaStyle: parsed.data.personaStyle,
          nativeLanguage: parsed.data.nativeLanguage,
          timezone: parsed.data.timezone
        }
      }
    });

    return createdSession;
  });

  return reply.code(201).send({
    sessionId: session.id,
    state: session.status.toLowerCase(),
    userId: authDbUser.id,
    firebaseUid: authUser.uid,
    scenario: {
      id: scenario.id,
      slug: scenario.slug,
      title: scenario.title
    },
    contextVersion: session.contextVersion,
    startedAt: session.startedAt,
    createdAt: session.createdAt,
    onboarding: {
      level: parsed.data.level,
      personaStyle: parsed.data.personaStyle,
      nativeLanguage: parsed.data.nativeLanguage,
      timezone: parsed.data.timezone
    }
  });
  }
);

app.post(
  "/v1/messages",
  { preHandler: [verifyFirebaseIdToken, rateLimitMessageWrite] },
  async (request, reply) => {
  if (!request.authUser || !request.authDbUser) {
    return reply.code(401).send({
      error: "UNAUTHORIZED",
      message: "Missing authenticated Firebase user context."
    });
  }

  const authUser = request.authUser;
  const authDbUser = request.authDbUser;

  const parsed = SubmitTurnSchema.safeParse(request.body);

  if (!parsed.success) {
    return reply.code(400).send({
      error: "INVALID_MESSAGE_PAYLOAD",
      issues: parsed.error.flatten()
    });
  }

  const session = await prisma.session.findFirst({
    where: {
      id: parsed.data.sessionId,
      userId: authDbUser.id
    },
    select: {
      id: true,
      status: true,
      contextVersion: true,
      scenario: {
        select: {
          id: true,
          slug: true
        }
      }
    }
  });

  if (!session) {
    return reply.code(404).send({
      error: "SESSION_NOT_FOUND",
      message: "Session was not found for the current user."
    });
  }

  if (session.status !== SessionStatus.ACTIVE) {
    return reply.code(409).send({
      error: "SESSION_NOT_ACTIVE",
      message: "Cannot post new messages to a completed or archived session."
    });
  }

  const redis = request.server.redis;

  if (!redis || !redis.isReady) {
    return reply.code(503).send({
      error: "SESSION_LOCK_UNAVAILABLE",
      message: "Redis is required to lock session writes for turn ingestion."
    });
  }

  const lockKey = `session-turn-lock:${session.id}`;
  const lockToken = randomUUID();
  const lockResult = await redis.set(lockKey, lockToken, {
    NX: true,
    EX: SESSION_TURN_LOCK_TTL_SECONDS
  });

  if (lockResult !== "OK") {
    return reply.code(423).send({
      error: "SESSION_LOCKED",
      message:
        "A turn is already being processed for this session. Retry shortly."
    });
  }

  try {
    const requestHash = buildSubmitTurnRequestHash({
      sessionId: parsed.data.sessionId,
      seq: parsed.data.seq,
      text: parsed.data.message.text
    });

    const idempotencyWhere = {
      userId_scope_key: {
        userId: authDbUser.id,
        scope: MESSAGE_IDEMPOTENCY_SCOPE,
        key: parsed.data.idempotencyKey
      }
    } as const;
    const idempotencyEntityId = buildIdempotencyEntityId({
      userId: authDbUser.id,
      scope: MESSAGE_IDEMPOTENCY_SCOPE,
      key: parsed.data.idempotencyKey
    });

    const loadReplayMessage = async (responseRef: string | null) => {
      if (!responseRef) {
        return null;
      }

      return prisma.message.findFirst({
        where: {
          id: responseRef,
          session: {
            userId: authDbUser.id
          }
        },
        select: {
          id: true,
          sessionId: true,
          seq: true,
          createdAt: true
        }
      });
    };

    const existingIdempotency = await prisma.idempotencyKey.findUnique({
      where: idempotencyWhere,
      select: {
        requestHash: true,
        responseRef: true,
        expiresAt: true
      }
    });

    if (existingIdempotency) {
      const now = new Date();

      if (existingIdempotency.expiresAt <= now) {
        try {
          await prisma.idempotencyKey.delete({
            where: idempotencyWhere
          });

          await prisma.auditLog.create({
            data: {
              userId: authDbUser.id,
              actor: buildActor(authUser.uid),
              action: "IDEMPOTENCY_KEY_EXPIRED_DELETED",
              entityType: "IdempotencyKey",
              entityId: idempotencyEntityId,
              payload: {
                scope: MESSAGE_IDEMPOTENCY_SCOPE,
                key: parsed.data.idempotencyKey
              }
            }
          });
        } catch (error) {
          if (
            !(
              error instanceof Prisma.PrismaClientKnownRequestError &&
              error.code === "P2025"
            )
          ) {
            throw error;
          }
        }
      } else if (existingIdempotency.requestHash !== requestHash) {
        return reply.code(409).send({
          error: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
          message:
            "This idempotencyKey was already used with a different request payload."
        });
      } else {
        const replayMessage = await loadReplayMessage(existingIdempotency.responseRef);

        if (replayMessage) {
          return reply.code(200).send({
            accepted: true,
            replayed: true,
            message: {
              id: replayMessage.id,
              sessionId: replayMessage.sessionId,
              seq: replayMessage.seq,
              createdAt: replayMessage.createdAt,
              idempotencyKey: parsed.data.idempotencyKey
            },
            queue: ROLEPLAY_TURN_QUEUE,
            job: null
          });
        }

        return reply.code(409).send({
          error: "IDEMPOTENCY_KEY_IN_PROGRESS",
          message:
            "This idempotencyKey is currently processing. Retry with the same payload."
        });
      }
    }

    const job = RoleplayTurnJobSchema.parse({
      jobId: `job_${randomUUID()}`,
      type: "ROLEPLAY_TURN",
      requestId: `req_${randomUUID()}`,
      sessionId: parsed.data.sessionId,
      userId: authDbUser.id,
      seq: parsed.data.seq,
      scenarioId: session.scenario.slug,
      inputText: parsed.data.message.text,
      contextVersion: session.contextVersion
    });

    let persistedTurn: {
      message: {
        id: string;
        sessionId: string;
        seq: number;
        createdAt: Date;
      };
      outboxEvent: {
        id: string;
        status: OutboxStatus;
        nextAttemptAt: Date;
        createdAt: Date;
      };
    };

    try {
      persistedTurn = await prisma.$transaction(async (tx) => {
        await tx.idempotencyKey.create({
          data: {
            userId: authDbUser.id,
            scope: MESSAGE_IDEMPOTENCY_SCOPE,
            key: parsed.data.idempotencyKey,
            requestHash,
            expiresAt: new Date(
              Date.now() + MESSAGE_IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000
            )
          }
        });

        await tx.auditLog.create({
          data: {
            userId: authDbUser.id,
            actor: buildActor(authUser.uid),
            action: "IDEMPOTENCY_KEY_CREATED",
            entityType: "IdempotencyKey",
            entityId: idempotencyEntityId,
            payload: {
              scope: MESSAGE_IDEMPOTENCY_SCOPE,
              key: parsed.data.idempotencyKey,
              requestHash
            }
          }
        });

        const createdMessage = await tx.message.create({
          data: {
            sessionId: session.id,
            seq: parsed.data.seq,
            role: MessageRole.USER,
            text: parsed.data.message.text,
            metadata: {
              idempotencyKey: parsed.data.idempotencyKey,
              clientTs: parsed.data.clientTs,
              firebaseUid: authUser.uid
            }
          },
          select: {
            id: true,
            sessionId: true,
            seq: true,
            createdAt: true
          }
        });

        await tx.auditLog.create({
          data: {
            userId: authDbUser.id,
            actor: buildActor(authUser.uid),
            action: "MESSAGE_CREATED",
            entityType: "Message",
            entityId: createdMessage.id,
            payload: {
              sessionId: createdMessage.sessionId,
              seq: createdMessage.seq
            }
          }
        });

        const createdOutboxEvent = await tx.outboxEvent.create({
          data: {
            sessionId: session.id,
            topic: ROLEPLAY_TURN_QUEUE,
            aggregateType: ROLEPLAY_TURN_OUTBOX_AGGREGATE_TYPE,
            aggregateId: createdMessage.id,
            payload: job
          },
          select: {
            id: true,
            status: true,
            nextAttemptAt: true,
            createdAt: true
          }
        });

        await tx.auditLog.create({
          data: {
            userId: authDbUser.id,
            actor: buildActor(authUser.uid),
            action: "OUTBOX_EVENT_CREATED",
            entityType: "OutboxEvent",
            entityId: createdOutboxEvent.id,
            payload: {
              topic: ROLEPLAY_TURN_QUEUE,
              aggregateType: ROLEPLAY_TURN_OUTBOX_AGGREGATE_TYPE,
              aggregateId: createdMessage.id
            }
          }
        });

        await tx.idempotencyKey.update({
          where: idempotencyWhere,
          data: {
            responseRef: createdMessage.id
          }
        });

        await tx.auditLog.create({
          data: {
            userId: authDbUser.id,
            actor: buildActor(authUser.uid),
            action: "IDEMPOTENCY_KEY_COMPLETED",
            entityType: "IdempotencyKey",
            entityId: idempotencyEntityId,
            payload: {
              responseRef: createdMessage.id
            }
          }
        });

        return {
          message: createdMessage,
          outboxEvent: createdOutboxEvent
        };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const existingAfterRace = await prisma.idempotencyKey.findUnique({
          where: idempotencyWhere,
          select: {
            requestHash: true,
            responseRef: true
          }
        });

        if (existingAfterRace) {
          if (existingAfterRace.requestHash !== requestHash) {
            return reply.code(409).send({
              error: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
              message:
                "This idempotencyKey was already used with a different request payload."
            });
          }

          const replayMessage = await loadReplayMessage(existingAfterRace.responseRef);

          if (replayMessage) {
            return reply.code(200).send({
              accepted: true,
              replayed: true,
              message: {
                id: replayMessage.id,
                sessionId: replayMessage.sessionId,
                seq: replayMessage.seq,
                createdAt: replayMessage.createdAt,
                idempotencyKey: parsed.data.idempotencyKey
              },
              queue: ROLEPLAY_TURN_QUEUE,
              job: null
            });
          }

          return reply.code(409).send({
            error: "IDEMPOTENCY_KEY_IN_PROGRESS",
            message:
              "This idempotencyKey is currently processing. Retry with the same payload."
          });
        }

        return reply.code(409).send({
          error: "DUPLICATE_MESSAGE_SEQUENCE",
          message: "A message with this sequence already exists for the session."
        });
      }

      request.log.error(
        {
          err: error,
          sessionId: parsed.data.sessionId,
          seq: parsed.data.seq
        },
        "Failed to persist user message"
      );

      return reply.code(500).send({
        error: "MESSAGE_PERSIST_FAILED",
        message: "Failed to persist user message."
      });
    }

    let published = false;
    let publishMessageId: string | null = null;
    let publishReason: string | null = null;
    let outboxStatus = persistedTurn.outboxEvent.status;
    let outboxNextAttemptAt = persistedTurn.outboxEvent.nextAttemptAt;

    if (request.server.outboxPublisher.isConfigured) {
      try {
        const publishResult = await request.server.outboxPublisher.publishRoleplayTurn({
          outboxEventId: persistedTurn.outboxEvent.id,
          aggregateType: ROLEPLAY_TURN_OUTBOX_AGGREGATE_TYPE,
          aggregateId: persistedTurn.message.id,
          sessionId: persistedTurn.message.sessionId,
          job
        });

        if (publishResult.delivered) {
          published = true;
          publishMessageId = publishResult.messageId;
          outboxStatus = OutboxStatus.SENT;

          await prisma.$transaction(async (tx) => {
            await tx.outboxEvent.update({
              where: { id: persistedTurn.outboxEvent.id },
              data: {
                status: OutboxStatus.SENT,
                attempts: {
                  increment: 1
                },
                errorText: null
              }
            });

            await tx.auditLog.create({
              data: {
                userId: authDbUser.id,
                actor: buildActor(authUser.uid),
                action: "OUTBOX_EVENT_PUBLISHED",
                entityType: "OutboxEvent",
                entityId: persistedTurn.outboxEvent.id,
                payload: {
                  provider: publishResult.provider,
                  topic: publishResult.topic,
                  messageId: publishResult.messageId
                }
              }
            });
          });
        } else {
          const failedAttemptAt = new Date(Date.now() + OUTBOX_PUBLISH_RETRY_DELAY_MS);
          publishReason = publishResult.reason ?? "PUBLISH_FAILED";
          outboxStatus = OutboxStatus.FAILED;
          outboxNextAttemptAt = failedAttemptAt;

          await prisma.$transaction(async (tx) => {
            await tx.outboxEvent.update({
              where: { id: persistedTurn.outboxEvent.id },
              data: {
                status: OutboxStatus.FAILED,
                attempts: {
                  increment: 1
                },
                nextAttemptAt: failedAttemptAt,
                errorText: publishReason
              }
            });

            await tx.auditLog.create({
              data: {
                userId: authDbUser.id,
                actor: buildActor(authUser.uid),
                action: "OUTBOX_EVENT_PUBLISH_FAILED",
                entityType: "OutboxEvent",
                entityId: persistedTurn.outboxEvent.id,
                payload: {
                  provider: publishResult.provider,
                  topic: publishResult.topic,
                  error: publishReason
                }
              }
            });
          });
        }
      } catch (error) {
        const failedAttemptAt = new Date(Date.now() + OUTBOX_PUBLISH_RETRY_DELAY_MS);
        const errorText = buildErrorText(error);
        publishReason = "PUBLISH_FAILED";
        outboxStatus = OutboxStatus.FAILED;
        outboxNextAttemptAt = failedAttemptAt;

        request.log.error(
          {
            err: error,
            outboxEventId: persistedTurn.outboxEvent.id
          },
          "Failed to publish outbox event to Pub/Sub"
        );

        await prisma.$transaction(async (tx) => {
          await tx.outboxEvent.update({
            where: { id: persistedTurn.outboxEvent.id },
            data: {
              status: OutboxStatus.FAILED,
              attempts: {
                increment: 1
              },
              nextAttemptAt: failedAttemptAt,
              errorText: errorText
            }
          });

          await tx.auditLog.create({
            data: {
              userId: authDbUser.id,
              actor: buildActor(authUser.uid),
              action: "OUTBOX_EVENT_PUBLISH_FAILED",
              entityType: "OutboxEvent",
              entityId: persistedTurn.outboxEvent.id,
              payload: {
                provider: request.server.outboxPublisher.provider,
                topic: request.server.outboxPublisher.topicName,
                error: errorText
              }
            }
          });
        });
      }
    } else {
      publishReason = "PUBSUB_NOT_CONFIGURED";

      request.log.warn(
        {
          outboxEventId: persistedTurn.outboxEvent.id
        },
        "Pub/Sub publisher is disabled. Outbox event remains pending."
      );
    }

    return reply.code(202).send({
      accepted: true,
      message: {
        id: persistedTurn.message.id,
        sessionId: persistedTurn.message.sessionId,
        seq: persistedTurn.message.seq,
        createdAt: persistedTurn.message.createdAt,
        idempotencyKey: parsed.data.idempotencyKey
      },
      queue: ROLEPLAY_TURN_QUEUE,
      publish: {
        provider: request.server.outboxPublisher.provider,
        published,
        messageId: publishMessageId,
        reason: publishReason
      },
      outboxEvent: {
        id: persistedTurn.outboxEvent.id,
        status: outboxStatus.toLowerCase(),
        nextAttemptAt: outboxNextAttemptAt,
        createdAt: persistedTurn.outboxEvent.createdAt
      },
      job
    });
  } finally {
    await releaseRedisLock(redis, lockKey, lockToken).catch((error) => {
      request.log.error(
        {
          err: error,
          lockKey
        },
        "Failed to release Redis lock"
      );
    });
  }
  }
);

const port = Number(process.env.PORT ?? 4000);

async function bootstrap() {
  if (app.redis) {
    app.redis.on("error", (error) => {
      app.log.error(
        {
          err: error
        },
        "Redis client error"
      );
    });

    await app.redis.connect();
    app.log.info("Redis connected");
  } else if (!hasRedisConfig) {
    app.log.warn("REDIS_URL is not set. Redis-backed features are disabled.");
  }

  if (app.outboxPublisher.isConfigured) {
    app.log.info(
      {
        provider: app.outboxPublisher.provider,
        topic: app.outboxPublisher.topicName
      },
      "Outbox publisher configured"
    );
  } else {
    app.log.warn(
      "PUBSUB_ROLEPLAY_TURNS_TOPIC is not set. Pub/Sub publishing is disabled."
    );
  }

  await app.listen({
    host: "0.0.0.0",
    port
  });
}

bootstrap().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
