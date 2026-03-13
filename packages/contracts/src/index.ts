import { z } from "zod";

export const EnglishLevelSchema = z.enum(["A1", "A2", "B1", "B2", "C1", "C2"]);

export const PersonaStyleSchema = z.enum([
  "soft",
  "confident",
  "playful",
  "professional"
]);

export const CreateSessionSchema = z.object({
  scenarioId: z.string().min(3),
  level: EnglishLevelSchema,
  personaStyle: PersonaStyleSchema,
  nativeLanguage: z.string().min(2).max(10),
  timezone: z.string().min(3)
});

export const SubmitTurnSchema = z.object({
  sessionId: z.string().min(3),
  seq: z.number().int().positive(),
  message: z.object({
    role: z.literal("user"),
    text: z.string().min(1).max(2000)
  }),
  idempotencyKey: z.string().uuid(),
  clientTs: z.string().datetime()
});

export const SavePhraseSchema = z.object({
  phrase: z.string().min(1).max(120),
  context: z.string().max(2000).optional(),
  sessionId: z.string().min(3).optional(),
  sourceMessageId: z.string().min(3).optional()
});

export const RoleplayTurnJobSchema = z.object({
  jobId: z.string().min(3),
  type: z.literal("ROLEPLAY_TURN"),
  requestId: z.string().min(3),
  sessionId: z.string().min(3),
  userId: z.string().min(3),
  seq: z.number().int().positive(),
  scenarioId: z.string().min(3),
  inputText: z.string().min(1),
  contextVersion: z.number().int().positive()
});

export const RoleplayTurnResultSchema = z.object({
  sessionId: z.string().min(3),
  seq: z.number().int().positive(),
  assistantReply: z.string().min(1),
  correction: z.object({
    original: z.string().min(1),
    natural: z.string().min(1),
    why: z.array(z.string().min(1)).min(1)
  }),
  phrases: z.array(z.string().min(1)).default([]),
  safety: z.object({
    blocked: z.boolean(),
    flags: z.array(z.string())
  }),
  version: z.number().int().positive(),
  payloadHash: z.string().min(8)
});

export type CreateSessionInput = z.infer<typeof CreateSessionSchema>;
export type SubmitTurnInput = z.infer<typeof SubmitTurnSchema>;
export type SavePhraseInput = z.infer<typeof SavePhraseSchema>;
export type RoleplayTurnJob = z.infer<typeof RoleplayTurnJobSchema>;
export type RoleplayTurnResult = z.infer<typeof RoleplayTurnResultSchema>;
