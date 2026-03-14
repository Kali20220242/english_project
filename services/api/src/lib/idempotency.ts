import { createHash } from "node:crypto";

export type ExistingIdempotencyRecord = {
  requestHash: string;
  responseRef: string | null;
  expiresAt: Date;
};

export type ExistingIdempotencyResolution =
  | {
      type: "expired";
    }
  | {
      type: "conflict";
    }
  | {
      type: "replay";
      responseRef: string;
    }
  | {
      type: "in_progress";
    };

export function buildSubmitTurnRequestHash(input: {
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

export function buildIdempotencyEntityId(input: {
  userId: string;
  scope: string;
  key: string;
}) {
  return `${input.userId}:${input.scope}:${input.key}`;
}

export function resolveExistingIdempotencyRecord(input: {
  existing: ExistingIdempotencyRecord;
  requestHash: string;
  now?: Date;
}): ExistingIdempotencyResolution {
  const now = input.now ?? new Date();

  if (input.existing.expiresAt <= now) {
    return {
      type: "expired"
    };
  }

  if (input.existing.requestHash !== input.requestHash) {
    return {
      type: "conflict"
    };
  }

  if (input.existing.responseRef) {
    return {
      type: "replay",
      responseRef: input.existing.responseRef
    };
  }

  return {
    type: "in_progress"
  };
}
