import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { type RoleplayTurnJob, type RoleplayTurnResult } from "@neontalk/contracts";

import {
  AntiCorruptionMapperError,
  mapAiPayloadToDomain
} from "./anti-corruption-mapper";

function buildJob(overrides: Partial<RoleplayTurnJob> = {}): RoleplayTurnJob {
  return {
    jobId: "job_123",
    type: "ROLEPLAY_TURN",
    requestId: "req_123",
    sessionId: "session_123",
    userId: "user_123",
    seq: 1,
    scenarioId: "dating",
    inputText: "i want coffee",
    contextVersion: 1,
    ...overrides
  };
}

function buildAiPayload(
  overrides: Partial<RoleplayTurnResult> = {}
): RoleplayTurnResult {
  return {
    sessionId: "session_123",
    seq: 1,
    assistantReply: " Nice choice. ",
    correction: {
      original: "i want coffee",
      natural: " I want coffee. ",
      why: [" Start with a capital letter. "]
    },
    phrases: ["Could I get a coffee?"],
    safety: {
      blocked: false,
      flags: []
    },
    version: 1,
    payloadHash: "payloadhash123",
    ...overrides
  };
}

describe("anti-corruption mapper", () => {
  test("maps payload with normalization and dedupe", () => {
    const mapped = mapAiPayloadToDomain({
      job: buildJob({
        inputText: "  i want coffee   "
      }),
      aiPayload: buildAiPayload({
        assistantReply: "  Nice choice.  ",
        correction: {
          original: "i want coffee",
          natural: "  I want coffee, please. ",
          why: ["  Use polite wording. ", "use polite wording.", "  "]
        },
        phrases: ["Could I get a coffee?", "could i get a coffee?", "Thanks!"],
        safety: {
          blocked: false,
          flags: ["minor", "MINOR"]
        }
      })
    });

    assert.equal(mapped.assistantMessage.text, "Nice choice.");
    assert.equal(mapped.correction.originalText, "i want coffee");
    assert.equal(mapped.correction.naturalText, "I want coffee, please.");
    assert.deepEqual(mapped.correction.explanation.why, ["Use polite wording."]);
    assert.deepEqual(mapped.correction.suggestions.phrases, [
      "Could I get a coffee?",
      "Thanks!"
    ]);
    assert.deepEqual(mapped.safety.flags, ["minor"]);
    assert.equal(mapped.savedPhrases.length, 2);
    assert.equal(mapped.savedPhrases[0]?.context, "I want coffee, please.");
  });

  test("throws CONTEXT_MISMATCH when session/seq differs", () => {
    assert.throws(
      () =>
        mapAiPayloadToDomain({
          job: buildJob({
            sessionId: "session_abc",
            seq: 2
          }),
          aiPayload: buildAiPayload({
            sessionId: "session_xyz",
            seq: 3
          })
        }),
      (error) =>
        error instanceof AntiCorruptionMapperError &&
        error.code === "CONTEXT_MISMATCH"
    );
  });

  test("falls back to safe explanation when why lines normalize to empty", () => {
    const mapped = mapAiPayloadToDomain({
      job: buildJob(),
      aiPayload: buildAiPayload({
        correction: {
          original: "i want coffee",
          natural: "I want coffee.",
          why: ["   ", "   "]
        }
      })
    });

    assert.equal(mapped.correction.explanation.why.length, 1);
    assert.match(
      mapped.correction.explanation.why[0] ?? "",
      /normalized due to invalid explanation/i
    );
  });
});
