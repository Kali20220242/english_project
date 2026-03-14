import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildIdempotencyEntityId,
  buildSubmitTurnRequestHash,
  resolveExistingIdempotencyRecord
} from "./idempotency";

describe("idempotency logic", () => {
  test("buildSubmitTurnRequestHash is deterministic for same payload", () => {
    const left = buildSubmitTurnRequestHash({
      sessionId: "session_1",
      seq: 2,
      text: "Hello there"
    });
    const right = buildSubmitTurnRequestHash({
      sessionId: "session_1",
      seq: 2,
      text: "Hello there"
    });

    assert.equal(left, right);
    assert.equal(left.length, 64);
  });

  test("buildSubmitTurnRequestHash changes for different text", () => {
    const left = buildSubmitTurnRequestHash({
      sessionId: "session_1",
      seq: 2,
      text: "Hello there"
    });
    const right = buildSubmitTurnRequestHash({
      sessionId: "session_1",
      seq: 2,
      text: "Hello there!"
    });

    assert.notEqual(left, right);
  });

  test("buildIdempotencyEntityId returns stable scoped id", () => {
    const value = buildIdempotencyEntityId({
      userId: "user_1",
      scope: "submit_turn",
      key: "uuid_123"
    });

    assert.equal(value, "user_1:submit_turn:uuid_123");
  });

  test("resolveExistingIdempotencyRecord classifies record state", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const requestHash = "abc123";

    assert.deepEqual(
      resolveExistingIdempotencyRecord({
        existing: {
          requestHash,
          responseRef: null,
          expiresAt: new Date("2025-12-31T23:59:59.000Z")
        },
        requestHash,
        now
      }),
      { type: "expired" }
    );

    assert.deepEqual(
      resolveExistingIdempotencyRecord({
        existing: {
          requestHash: "different",
          responseRef: null,
          expiresAt: new Date("2026-01-01T00:10:00.000Z")
        },
        requestHash,
        now
      }),
      { type: "conflict" }
    );

    assert.deepEqual(
      resolveExistingIdempotencyRecord({
        existing: {
          requestHash,
          responseRef: "msg_123",
          expiresAt: new Date("2026-01-01T00:10:00.000Z")
        },
        requestHash,
        now
      }),
      {
        type: "replay",
        responseRef: "msg_123"
      }
    );

    assert.deepEqual(
      resolveExistingIdempotencyRecord({
        existing: {
          requestHash,
          responseRef: null,
          expiresAt: new Date("2026-01-01T00:10:00.000Z")
        },
        requestHash,
        now
      }),
      { type: "in_progress" }
    );
  });
});
