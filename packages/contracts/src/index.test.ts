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

  test("CreateSessionSchema rejects invalid aiModel format", () => {
    const parsed = CreateSessionSchema.safeParse({
      scenarioId: "scenario_ok",
      level: "B1",
      personaStyle: "confident",
      nativeLanguage: "uk",
      timezone: "Europe/Kiev",
      aiModel: "gpt-4.1-mini;DROP_TABLE"
    });

    assert.equal(parsed.success, false);
  });

  test("CreateSessionSchema accepts claude model id", () => {
    const parsed = CreateSessionSchema.safeParse({
      scenarioId: "scenario_ok",
      level: "B1",
      personaStyle: "confident",
      nativeLanguage: "uk",
      timezone: "Europe/Kiev",
      aiModel: "claude-3-7-sonnet-20250219"
    });

    assert.equal(parsed.success, true);
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
        translationUk: "Я в порядку.",
        why: ["Речення починається з великої літери."]
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
