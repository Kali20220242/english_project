import { randomUUID } from "node:crypto";

const serviceName = "ai-worker";
const environment = process.env.NODE_ENV ?? "development";

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

const levelOrder = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50
} as const;

type WorkerLogLevel = keyof typeof levelOrder;

const rawLogLevel = (process.env.LOG_LEVEL ?? "info").trim().toLowerCase();
const logLevel = (rawLogLevel in levelOrder
  ? rawLogLevel
  : "info") as WorkerLogLevel;

type WorkerLogPayload = Record<string, unknown> | undefined;

type WorkerTrackErrorInput = {
  event: string;
  error: unknown;
  context?: Record<string, unknown>;
};

function shouldLog(level: WorkerLogLevel) {
  return levelOrder[level] >= levelOrder[logLevel];
}

function toErrorMeta(error: unknown) {
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

export function logWorker(
  level: WorkerLogLevel,
  event: string,
  payload?: WorkerLogPayload
) {
  if (!shouldLog(level)) {
    return;
  }

  const entry = {
    level,
    service: serviceName,
    env: environment,
    event,
    timestamp: new Date().toISOString(),
    ...(payload ?? {})
  };
  const serialized = JSON.stringify(entry);

  if (level === "error") {
    console.error(serialized);
    return;
  }

  if (level === "warn") {
    console.warn(serialized);
    return;
  }

  console.log(serialized);
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

export async function trackWorkerError(input: WorkerTrackErrorInput) {
  const payload = {
    eventId: randomUUID(),
    service: serviceName,
    environment,
    event: input.event,
    occurredAt: new Date().toISOString(),
    error: toErrorMeta(input.error),
    context: input.context ?? null
  };

  logWorker("error", "error.tracked", payload);

  try {
    await sendTrackedError(payload);
  } catch (dispatchError) {
    logWorker("error", "error_tracking.dispatch_failed", {
      error: toErrorMeta(dispatchError),
      sourceEvent: input.event
    });
  }
}

let processHandlersRegistered = false;

export function registerWorkerProcessErrorHandlers(input: {
  onFatal: () => Promise<void> | void;
}) {
  if (processHandlersRegistered) {
    return;
  }

  processHandlersRegistered = true;

  process.on("unhandledRejection", (reason) => {
    void trackWorkerError({
      event: "process.unhandled_rejection",
      error: reason,
      context: {
        origin: "node-process"
      }
    });
  });

  process.on("uncaughtException", (error) => {
    void trackWorkerError({
      event: "process.uncaught_exception",
      error,
      context: {
        origin: "node-process"
      }
    }).finally(() => {
      Promise.resolve(input.onFatal()).finally(() => process.exit(1));
    });
  });
}
