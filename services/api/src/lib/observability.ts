import { randomUUID } from "node:crypto";

import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyServerOptions
} from "fastify";

const serviceName = "api";

const parsedTrackingTimeoutMs = Number.parseInt(
  process.env.ERROR_TRACKING_TIMEOUT_MS ?? "2500",
  10
);
const errorTrackingTimeoutMs =
  Number.isFinite(parsedTrackingTimeoutMs) && parsedTrackingTimeoutMs > 0
    ? parsedTrackingTimeoutMs
    : 2500;
const errorTrackingWebhookUrl =
  process.env.ERROR_TRACKING_WEBHOOK_URL?.trim() || null;
const errorTrackingApiKey = process.env.ERROR_TRACKING_API_KEY?.trim() || null;

const allowedLogLevels = new Set(["trace", "debug", "info", "warn", "error"]);
const rawLogLevel = (process.env.LOG_LEVEL ?? "info").trim().toLowerCase();
const logLevel = allowedLogLevels.has(rawLogLevel) ? rawLogLevel : "info";

const redactedFieldPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers.x-csrf-token",
  "req.headers.x-api-key",
  "req.headers.x-forwarded-for",
  "headers.authorization",
  "headers.cookie",
  "authorization",
  "cookie",
  "x-csrf-token",
  "apiKey",
  "token",
  "idToken",
  "refreshToken",
  "password",
  "firebasePrivateKey"
];

type TrackedErrorInput = {
  event: string;
  error: unknown;
  logger?: FastifyBaseLogger | null;
  context?: Record<string, unknown>;
};

function buildErrorMeta(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null
    };
  }

  if (typeof error === "string") {
    return {
      name: "Error",
      message: error
    };
  }

  return {
    name: "UnknownError",
    message: "Unexpected error value."
  };
}

async function sendTrackedError(payload: Record<string, unknown>) {
  if (!errorTrackingWebhookUrl) {
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), errorTrackingTimeoutMs);

  try {
    const response = await fetch(errorTrackingWebhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(errorTrackingApiKey
          ? {
              authorization: `Bearer ${errorTrackingApiKey}`
            }
          : {})
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Tracking webhook returned ${response.status}.`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function buildApiLoggerConfig(): FastifyServerOptions["logger"] {
  return {
    level: logLevel,
    base: {
      service: serviceName,
      env: process.env.NODE_ENV ?? "development"
    },
    redact: {
      paths: redactedFieldPaths,
      censor: "[REDACTED]"
    }
  };
}

export async function trackApiError(input: TrackedErrorInput) {
  const eventId = randomUUID();
  const errorMeta = buildErrorMeta(input.error);
  const payload = {
    eventId,
    service: serviceName,
    environment: process.env.NODE_ENV ?? "development",
    event: input.event,
    occurredAt: new Date().toISOString(),
    error: errorMeta,
    context: input.context ?? null
  };

  if (input.logger) {
    input.logger.error(payload, "Tracked error event");
  } else {
    console.error(JSON.stringify(payload));
  }

  try {
    await sendTrackedError(payload);
  } catch (trackingError) {
    const meta = buildErrorMeta(trackingError);

    if (input.logger) {
      input.logger.error(
        {
          event: "error_tracking.dispatch_failed",
          eventId,
          trackingError: meta
        },
        "Failed to dispatch tracked error"
      );
    } else {
      console.error(
        JSON.stringify({
          service: serviceName,
          event: "error_tracking.dispatch_failed",
          eventId,
          trackingError: meta
        })
      );
    }
  }
}

let processHandlersRegistered = false;

export function registerApiProcessErrorHandlers(app: FastifyInstance) {
  if (processHandlersRegistered) {
    return;
  }

  processHandlersRegistered = true;

  process.on("unhandledRejection", (reason) => {
    void trackApiError({
      event: "process.unhandled_rejection",
      error: reason,
      logger: app.log,
      context: {
        origin: "node-process"
      }
    });
  });

  process.on("uncaughtException", (error) => {
    void trackApiError({
      event: "process.uncaught_exception",
      error,
      logger: app.log,
      context: {
        origin: "node-process"
      }
    }).finally(() => {
      app.log.fatal(
        {
          err: error
        },
        "Uncaught exception. Exiting process."
      );
      process.exit(1);
    });
  });
}
