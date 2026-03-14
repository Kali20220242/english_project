import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CreateSessionSchema,
  RoleplayTurnResultSchema,
  SubmitTurnSchema
} from "./index";

describe("contracts schemas", () => {
  test("CreateSessionSchema rejects too-short scenario id", () => {
    const parsed = CreateSessionSchema.safeParse({
      scenarioId: "ab",
      level: "B1",
      personaStyle: "confident",
      nativeLanguage: "uk",
      timezone: "Europe/Kiev"
    });

    assert.equal(parsed.success, false);
  });

  test("SubmitTurnSchema rejects non-user role and invalid uuid", () => {
    const parsed = SubmitTurnSchema.safeParse({
      sessionId: "sess_123",
      seq: 1,
      message: {
        role: "assistant",
        text: "hello"
      },
      idempotencyKey: "not-a-uuid",
      clientTs: new Date().toISOString()
    });

    assert.equal(parsed.success, false);
  });

  test("RoleplayTurnResultSchema applies phrases default", () => {
    const parsed = RoleplayTurnResultSchema.parse({
      sessionId: "sess_123",
      seq: 2,
      assistantReply: "Sounds good.",
      correction: {
        original: "i am fine",
        natural: "I am fine.",
        why: ["Capitalize sentence start."]
      },
      safety: {
        blocked: false,
        flags: []
      },
      version: 1,
      payloadHash: "12345678"
    });

    assert.deepEqual(parsed.phrases, []);
  });
});
