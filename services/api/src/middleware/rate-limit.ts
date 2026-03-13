import type { FastifyReply, FastifyRequest } from "fastify";

type RateLimitRule = {
  bucket: string;
  maxRequests: number;
  windowSeconds: number;
};

const AUTH_ENDPOINT_RULE: RateLimitRule = {
  bucket: "auth",
  maxRequests: Number(process.env.RATE_LIMIT_AUTH_MAX ?? 120),
  windowSeconds: Number(process.env.RATE_LIMIT_AUTH_WINDOW_SEC ?? 60)
};

const SESSION_READ_RULE: RateLimitRule = {
  bucket: "sessions-read",
  maxRequests: Number(process.env.RATE_LIMIT_SESSIONS_READ_MAX ?? 120),
  windowSeconds: Number(process.env.RATE_LIMIT_SESSIONS_READ_WINDOW_SEC ?? 60)
};

const SESSION_WRITE_RULE: RateLimitRule = {
  bucket: "sessions-write",
  maxRequests: Number(process.env.RATE_LIMIT_SESSIONS_WRITE_MAX ?? 30),
  windowSeconds: Number(process.env.RATE_LIMIT_SESSIONS_WRITE_WINDOW_SEC ?? 60)
};

const MESSAGE_WRITE_RULE: RateLimitRule = {
  bucket: "messages-write",
  maxRequests: Number(process.env.RATE_LIMIT_MESSAGES_WRITE_MAX ?? 60),
  windowSeconds: Number(process.env.RATE_LIMIT_MESSAGES_WRITE_WINDOW_SEC ?? 60)
};

function resolveIdentity(request: FastifyRequest) {
  if (request.authDbUser?.id) {
    return `user:${request.authDbUser.id}`;
  }

  if (request.authUser?.uid) {
    return `firebase:${request.authUser.uid}`;
  }

  return `ip:${request.ip}`;
}

async function enforceRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  rule: RateLimitRule
) {
  const redis = request.server.redis;

  if (!redis) {
    return;
  }

  const identity = resolveIdentity(request);
  const key = `rate-limit:${rule.bucket}:${identity}`;

  try {
    const hitCount = await redis.incr(key);

    if (hitCount === 1) {
      await redis.expire(key, rule.windowSeconds);
    }

    const ttlSeconds = await redis.ttl(key);
    const retryAfterSeconds = ttlSeconds > 0 ? ttlSeconds : rule.windowSeconds;
    const remaining = Math.max(0, rule.maxRequests - hitCount);
    const resetUnix = Math.floor(Date.now() / 1000) + retryAfterSeconds;

    reply.header("X-RateLimit-Limit", String(rule.maxRequests));
    reply.header("X-RateLimit-Remaining", String(remaining));
    reply.header("X-RateLimit-Reset", String(resetUnix));

    if (hitCount > rule.maxRequests) {
      reply.header("Retry-After", String(retryAfterSeconds));
      return reply.code(429).send({
        error: "RATE_LIMIT_EXCEEDED",
        bucket: rule.bucket,
        message: "Too many requests. Please retry later.",
        retryAfterSeconds
      });
    }
  } catch (error) {
    request.log.error(
      {
        err: error,
        bucket: rule.bucket
      },
      "Rate limit check failed"
    );
  }
}

export async function rateLimitAuthEndpoint(
  request: FastifyRequest,
  reply: FastifyReply
) {
  return enforceRateLimit(request, reply, AUTH_ENDPOINT_RULE);
}

export async function rateLimitSessionRead(
  request: FastifyRequest,
  reply: FastifyReply
) {
  return enforceRateLimit(request, reply, SESSION_READ_RULE);
}

export async function rateLimitSessionWrite(
  request: FastifyRequest,
  reply: FastifyReply
) {
  return enforceRateLimit(request, reply, SESSION_WRITE_RULE);
}

export async function rateLimitMessageWrite(
  request: FastifyRequest,
  reply: FastifyReply
) {
  return enforceRateLimit(request, reply, MESSAGE_WRITE_RULE);
}
