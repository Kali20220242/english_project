import { createHash, randomUUID } from "node:crypto";

import Fastify from "fastify";
import cors from "@fastify/cors";
import type { RedisClientType } from "redis";

import { prisma } from "@neontalk/db";
import { MessageRole, OutboxStatus, Prisma, SessionStatus } from "@prisma/client";
import {
  CreateSessionSchema,
  SavePhraseSchema,
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
const allowedCorsOrigins = (
  process.env.API_CORS_ORIGIN ?? "http://localhost:3000"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const savedPhraseSelect = {
  id: true,
  phrase: true,
  context: true,
  mastery: true,
  nextReviewAt: true,
  sourceMessageId: true,
  sessionId: true,
  createdAt: true,
  updatedAt: true,
  session: {
    select: {
      id: true,
      scenario: {
        select: {
          id: true,
          slug: true,
          title: true
        }
      }
    }
  }
} as const;

function isCorsOriginAllowed(origin: string | undefined) {
  if (!origin) {
    return true;
  }

  if (allowedCorsOrigins.includes("*")) {
    return true;
  }

  return allowedCorsOrigins.includes(origin);
}

app.register(cors, {
  credentials: true,
  origin(origin, callback) {
    callback(null, isCorsOriginAllowed(origin));
  }
});

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

function normalizePhraseText(input: string) {
  return input.trim().replace(/\s+/g, " ").slice(0, 120);
}

function normalizeOptionalPhraseContext(input: string | undefined) {
  if (typeof input !== "string") {
    return null;
  }

  const normalized = input.trim().replace(/\s+/g, " ").slice(0, 2000);
  return normalized.length > 0 ? normalized : null;
}

function clampScore(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeWeakAreaLabel(input: string) {
  return input.trim().replace(/\s+/g, " ").slice(0, 64);
}

function normalizeWeakAreas(input: unknown, maxItems = 6) {
  if (!Array.isArray(input)) {
    return [];
  }

  const seen = new Set<string>();
  const output: string[] = [];

  for (const item of input) {
    if (typeof item !== "string") {
      continue;
    }

    const label = normalizeWeakAreaLabel(item);

    if (!label) {
      continue;
    }

    const dedupeKey = label.toLowerCase();

    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    output.push(label);

    if (output.length >= maxItems) {
      break;
    }
  }

  return output;
}

function extractWhyLines(explanation: unknown) {
  if (Array.isArray(explanation)) {
    return explanation
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (explanation && typeof explanation === "object") {
    const why = (explanation as { why?: unknown }).why;

    if (Array.isArray(why)) {
      return why
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }

  return [];
}

const weakAreaMatchers = [
  { pattern: /\b(article|a\/an|the)\b/i, label: "Articles" },
  { pattern: /\b(tense|past|present|future)\b/i, label: "Verb Tenses" },
  { pattern: /\b(preposition|in|on|at)\b/i, label: "Prepositions" },
  { pattern: /\b(word order|order)\b/i, label: "Word Order" },
  { pattern: /\b(vocabulary|word choice)\b/i, label: "Vocabulary Range" },
  { pattern: /\b(clarity|clear|natural)\b/i, label: "Natural Phrasing" },
  { pattern: /\b(question form|question)\b/i, label: "Question Forms" },
  { pattern: /\b(confidence|hesitat|flow)\b/i, label: "Speaking Confidence" },
  { pattern: /\b(grammar|grammatical)\b/i, label: "Grammar Accuracy" }
] as const;

function inferWeakAreasFromExplanations(explanations: unknown[]) {
  const scored = new Map<string, number>();

  for (const explanation of explanations) {
    const whyLines = extractWhyLines(explanation);

    for (const line of whyLines) {
      for (const matcher of weakAreaMatchers) {
        if (matcher.pattern.test(line)) {
          scored.set(matcher.label, (scored.get(matcher.label) ?? 0) + 1);
        }
      }
    }
  }

  return Array.from(scored.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6)
    .map(([label]) => label);
}

function buildFallbackWeakAreas(input: {
  userTurnCount: number;
  savedPhraseCount: number;
  sessionsCount: number;
}) {
  const fallback: string[] = [];

  if (input.userTurnCount < 8) {
    fallback.push("Speaking Confidence");
  }

  if (input.savedPhraseCount < 5) {
    fallback.push("Vocabulary Range");
  }

  if (input.sessionsCount < 4) {
    fallback.push("Consistency");
  }

  fallback.push("Natural Phrasing");

  return normalizeWeakAreas(fallback, 4);
}

function toUtcDayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function shiftUtcDayKey(dayKey: string, offsetDays: number) {
  const date = new Date(`${dayKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return toUtcDayKey(date);
}

function computeStreakDays(dayKeys: Set<string>) {
  if (dayKeys.size === 0) {
    return 0;
  }

  const today = toUtcDayKey(new Date());
  let cursor = dayKeys.has(today) ? today : shiftUtcDayKey(today, -1);

  if (!dayKeys.has(cursor)) {
    return 0;
  }

  let streak = 0;

  while (dayKeys.has(cursor)) {
    streak += 1;
    cursor = shiftUtcDayKey(cursor, -1);
  }

  return streak;
}

function buildFallbackScores(input: {
  userTurnCount: number;
  savedPhraseCount: number;
  sessionsCount: number;
  activeDaysCount: number;
}) {
  const fluencyScore =
    30 +
    Math.min(35, input.userTurnCount * 2) +
    Math.min(20, input.activeDaysCount * 3);
  const vocabularyScore =
    25 +
    Math.min(45, input.savedPhraseCount * 4) +
    Math.min(20, Math.floor(input.userTurnCount / 3) * 3);
  const consistencyScore =
    20 +
    Math.min(55, input.activeDaysCount * 5) +
    Math.min(20, input.sessionsCount * 2);

  return {
    fluencyScore: clampScore(fluencyScore),
    vocabularyScore: clampScore(vocabularyScore),
    consistencyScore: clampScore(consistencyScore)
  };
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
  "/v1/progress",
  { preHandler: [verifyFirebaseIdToken, rateLimitSessionRead] },
  async (request, reply) => {
  if (!request.authDbUser) {
    return reply.code(401).send({
      error: "UNAUTHORIZED",
      message: "Missing authenticated database user context."
    });
  }

  const query = request.query as {
    windowDays?: string;
  };
  const parsedWindowDays = Number.parseInt(query.windowDays ?? "30", 10);
  const windowDays =
    Number.isFinite(parsedWindowDays) && parsedWindowDays > 0
      ? Math.min(parsedWindowDays, 180)
      : 30;
  const windowStartAt = new Date(
    Date.now() - windowDays * 24 * 60 * 60 * 1000
  );
  const streakWindowStartAt = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

  const [
    snapshots,
    sessions,
    practiceTurns,
    userTurnCount,
    savedPhraseCount,
    recentCorrections
  ] = await Promise.all([
    prisma.progressSnapshot.findMany({
      where: {
        userId: request.authDbUser.id,
        capturedAt: {
          gte: windowStartAt
        }
      },
      orderBy: {
        capturedAt: "desc"
      },
      take: 60,
      select: {
        id: true,
        fluencyScore: true,
        vocabularyScore: true,
        consistencyScore: true,
        streakDays: true,
        weakAreas: true,
        capturedAt: true
      }
    }),
    prisma.session.findMany({
      where: {
        userId: request.authDbUser.id,
        startedAt: {
          gte: streakWindowStartAt
        }
      },
      orderBy: {
        startedAt: "desc"
      },
      take: 2000,
      select: {
        startedAt: true
      }
    }),
    prisma.message.findMany({
      where: {
        role: MessageRole.USER,
        session: {
          userId: request.authDbUser.id
        },
        createdAt: {
          gte: streakWindowStartAt
        }
      },
      select: {
        createdAt: true
      },
      orderBy: {
        createdAt: "desc"
      },
      take: 2000
    }),
    prisma.message.count({
      where: {
        role: MessageRole.USER,
        session: {
          userId: request.authDbUser.id
        },
        createdAt: {
          gte: windowStartAt
        }
      }
    }),
    prisma.savedPhrase.count({
      where: {
        userId: request.authDbUser.id,
        createdAt: {
          gte: windowStartAt
        }
      }
    }),
    prisma.correction.findMany({
      where: {
        createdAt: {
          gte: windowStartAt
        },
        message: {
          session: {
            userId: request.authDbUser.id
          }
        }
      },
      orderBy: {
        createdAt: "desc"
      },
      take: 120,
      select: {
        explanation: true
      }
    })
  ]);

  const allPracticeDayKeys = new Set<string>();

  for (const session of sessions) {
    allPracticeDayKeys.add(toUtcDayKey(session.startedAt));
  }

  for (const turn of practiceTurns) {
    allPracticeDayKeys.add(toUtcDayKey(turn.createdAt));
  }

  const windowPracticeDayKeys = new Set<string>();

  for (const session of sessions) {
    if (session.startedAt >= windowStartAt) {
      windowPracticeDayKeys.add(toUtcDayKey(session.startedAt));
    }
  }

  for (const turn of practiceTurns) {
    if (turn.createdAt >= windowStartAt) {
      windowPracticeDayKeys.add(toUtcDayKey(turn.createdAt));
    }
  }

  const streakDays = computeStreakDays(allPracticeDayKeys);
  const sessionsCount = sessions.filter(
    (session) => session.startedAt >= windowStartAt
  ).length;
  const latestSnapshot = snapshots[0] ?? null;
  const snapshotWeakAreas = normalizeWeakAreas(latestSnapshot?.weakAreas);
  const inferredWeakAreas = inferWeakAreasFromExplanations(
    recentCorrections.map((item) => item.explanation)
  );
  const weakAreas =
    snapshotWeakAreas.length > 0
      ? snapshotWeakAreas
      : inferredWeakAreas.length > 0
        ? inferredWeakAreas
        : buildFallbackWeakAreas({
            userTurnCount,
            savedPhraseCount,
            sessionsCount
          });
  const scores = latestSnapshot
    ? {
        fluencyScore: clampScore(latestSnapshot.fluencyScore),
        vocabularyScore: clampScore(latestSnapshot.vocabularyScore),
        consistencyScore: clampScore(latestSnapshot.consistencyScore)
      }
    : buildFallbackScores({
        userTurnCount,
        savedPhraseCount,
        sessionsCount,
        activeDaysCount: windowPracticeDayKeys.size
      });
  const trendSource =
    snapshots.length > 0
      ? [...snapshots]
          .reverse()
          .slice(-14)
          .map((item) => ({
            capturedAt: item.capturedAt,
            fluencyScore: clampScore(item.fluencyScore),
            vocabularyScore: clampScore(item.vocabularyScore),
            consistencyScore: clampScore(item.consistencyScore),
            streakDays: item.streakDays
          }))
      : [
          {
            capturedAt: new Date(),
            fluencyScore: scores.fluencyScore,
            vocabularyScore: scores.vocabularyScore,
            consistencyScore: scores.consistencyScore,
            streakDays
          }
        ];

  return reply.code(200).send({
    overview: {
      windowDays,
      generatedAt: new Date().toISOString(),
      source: latestSnapshot ? "snapshot+activity" : "activity-fallback",
      streakDays,
      lastCapturedAt: latestSnapshot?.capturedAt ?? null,
      scores,
      weakAreas,
      activity: {
        sessions: sessionsCount,
        userTurns: userTurnCount,
        savedPhrases: savedPhraseCount,
        activeDays: windowPracticeDayKeys.size
      }
    },
    trend: trendSource
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
  "/v1/sessions/:id/messages",
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

  const query = request.query as {
    limit?: string;
    sinceSeq?: string;
  };
  const parsedLimit = Number.parseInt(query.limit ?? "200", 10);
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 500)
      : 200;
  const parsedSinceSeq = Number.parseInt(query.sinceSeq ?? "0", 10);
  const sinceSeq =
    Number.isFinite(parsedSinceSeq) && parsedSinceSeq >= 0
      ? parsedSinceSeq
      : 0;

  const session = await prisma.session.findFirst({
    where: {
      id,
      userId: request.authDbUser.id
    },
    select: {
      id: true,
      status: true,
      contextVersion: true
    }
  });

  if (!session) {
    return reply.code(404).send({
      error: "SESSION_NOT_FOUND",
      message: "Session was not found for the current user."
    });
  }

  const items = await prisma.message.findMany({
    where: {
      sessionId: id,
      seq: {
        gt: sinceSeq
      }
    },
    orderBy: {
      seq: "asc"
    },
    take: limit,
    select: {
      id: true,
      sessionId: true,
      seq: true,
      role: true,
      text: true,
      payloadHash: true,
      metadata: true,
      createdAt: true,
      correction: {
        select: {
          originalText: true,
          naturalText: true,
          explanation: true,
          suggestions: true
        }
      }
    }
  });

  const nextSinceSeq = items.at(-1)?.seq ?? sinceSeq;

  return reply.code(200).send({
    session: {
      id: session.id,
      status: session.status,
      contextVersion: session.contextVersion
    },
    items,
    cursor: {
      sinceSeq,
      nextSinceSeq,
      limit,
      hasMore: items.length === limit
    }
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

app.get(
  "/v1/phrases",
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
    q?: string;
    sessionId?: string;
    sort?: string;
  };

  const parsedPage = Number.parseInt(query.page ?? "1", 10);
  const parsedLimit = Number.parseInt(query.limit ?? "25", 10);
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 100)
      : 25;
  const phraseSearch = typeof query.q === "string" ? query.q.trim() : "";
  const sessionIdFilter =
    typeof query.sessionId === "string" && query.sessionId.trim().length > 0
      ? query.sessionId.trim()
      : null;
  const sort = query.sort === "mastery" ? "mastery" : "recent";

  if (sessionIdFilter) {
    const session = await prisma.session.findFirst({
      where: {
        id: sessionIdFilter,
        userId: request.authDbUser.id
      },
      select: {
        id: true
      }
    });

    if (!session) {
      return reply.code(404).send({
        error: "SESSION_NOT_FOUND",
        message: "Session was not found for the current user."
      });
    }
  }

  const whereClause: Prisma.SavedPhraseWhereInput = {
    userId: request.authDbUser.id
  };

  if (sessionIdFilter) {
    whereClause.sessionId = sessionIdFilter;
  }

  if (phraseSearch.length > 0) {
    whereClause.phrase = {
      contains: phraseSearch.slice(0, 120),
      mode: "insensitive"
    };
  }

  const [items, total] = await Promise.all([
    prisma.savedPhrase.findMany({
      where: whereClause,
      orderBy:
        sort === "mastery"
          ? [{ mastery: "desc" }, { updatedAt: "desc" }, { createdAt: "desc" }]
          : [{ createdAt: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
      select: savedPhraseSelect
    }),
    prisma.savedPhrase.count({
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
      q: phraseSearch || null,
      sessionId: sessionIdFilter,
      sort
    }
  });
  }
);

app.post(
  "/v1/phrases",
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
  const parsed = SavePhraseSchema.safeParse(request.body);

  if (!parsed.success) {
    return reply.code(400).send({
      error: "INVALID_SAVE_PHRASE_PAYLOAD",
      issues: parsed.error.flatten()
    });
  }

  const phrase = normalizePhraseText(parsed.data.phrase);

  if (!phrase) {
    return reply.code(400).send({
      error: "INVALID_PHRASE_TEXT",
      message: "phrase must include at least one non-space character."
    });
  }

  let resolvedSessionId =
    typeof parsed.data.sessionId === "string" ? parsed.data.sessionId : null;
  let resolvedSourceMessageId =
    typeof parsed.data.sourceMessageId === "string"
      ? parsed.data.sourceMessageId
      : null;
  let resolvedContext = normalizeOptionalPhraseContext(parsed.data.context);

  if (resolvedSessionId) {
    const session = await prisma.session.findFirst({
      where: {
        id: resolvedSessionId,
        userId: authDbUser.id
      },
      select: {
        id: true
      }
    });

    if (!session) {
      return reply.code(404).send({
        error: "SESSION_NOT_FOUND",
        message: "Session was not found for the current user."
      });
    }
  }

  if (resolvedSourceMessageId) {
    const sourceMessage = await prisma.message.findFirst({
      where: {
        id: resolvedSourceMessageId,
        session: {
          userId: authDbUser.id
        }
      },
      select: {
        id: true,
        sessionId: true,
        role: true,
        text: true
      }
    });

    if (!sourceMessage) {
      return reply.code(404).send({
        error: "SOURCE_MESSAGE_NOT_FOUND",
        message: "Source message was not found for the current user."
      });
    }

    if (sourceMessage.role !== MessageRole.ASSISTANT) {
      return reply.code(409).send({
        error: "INVALID_SOURCE_MESSAGE_ROLE",
        message: "Only assistant messages can be used as source for saved phrases."
      });
    }

    if (resolvedSessionId && resolvedSessionId !== sourceMessage.sessionId) {
      return reply.code(409).send({
        error: "SOURCE_MESSAGE_SESSION_MISMATCH",
        message: "sourceMessageId belongs to a different session."
      });
    }

    resolvedSessionId = resolvedSessionId ?? sourceMessage.sessionId;
    resolvedSourceMessageId = sourceMessage.id;
    resolvedContext =
      resolvedContext ?? normalizeOptionalPhraseContext(sourceMessage.text);
  }

  const existing = await prisma.savedPhrase.findFirst({
    where: {
      userId: authDbUser.id,
      phrase: {
        equals: phrase,
        mode: "insensitive"
      }
    },
    select: savedPhraseSelect
  });

  if (existing) {
    const shouldUpdateRecord =
      (!existing.sessionId && resolvedSessionId) ||
      (!existing.sourceMessageId && resolvedSourceMessageId) ||
      (!existing.context && resolvedContext);

    const replayed = shouldUpdateRecord
      ? await prisma.savedPhrase.update({
          where: {
            id: existing.id
          },
          data: {
            sessionId: existing.sessionId ?? resolvedSessionId,
            sourceMessageId: existing.sourceMessageId ?? resolvedSourceMessageId,
            context: existing.context ?? resolvedContext
          },
          select: savedPhraseSelect
        })
      : existing;

    await prisma.auditLog.create({
      data: {
        userId: authDbUser.id,
        actor: buildActor(authUser.uid),
        action: "SAVED_PHRASE_REPLAYED",
        entityType: "SavedPhrase",
        entityId: replayed.id,
        payload: {
          phrase: replayed.phrase,
          updatedMetadata: shouldUpdateRecord
        }
      }
    });

    return reply.code(200).send({
      saved: true,
      replayed: true,
      item: replayed
    });
  }

  const created = await prisma.$transaction(async (tx) => {
    const savedPhrase = await tx.savedPhrase.create({
      data: {
        userId: authDbUser.id,
        phrase,
        context: resolvedContext,
        sessionId: resolvedSessionId,
        sourceMessageId: resolvedSourceMessageId
      },
      select: savedPhraseSelect
    });

    await tx.auditLog.create({
      data: {
        userId: authDbUser.id,
        actor: buildActor(authUser.uid),
        action: "SAVED_PHRASE_CREATED",
        entityType: "SavedPhrase",
        entityId: savedPhrase.id,
        payload: {
          phrase: savedPhrase.phrase,
          sessionId: savedPhrase.sessionId,
          sourceMessageId: savedPhrase.sourceMessageId
        }
      }
    });

    return savedPhrase;
  });

  return reply.code(201).send({
    saved: true,
    replayed: false,
    item: created
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
