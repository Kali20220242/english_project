import {
  RoleplayTurnJobSchema,
  RoleplayTurnResultSchema,
  type RoleplayTurnJob,
  type RoleplayTurnResult
} from "@neontalk/contracts";

const MAX_ASSISTANT_TEXT_LENGTH = 2000;
const MAX_CORRECTION_TEXT_LENGTH = 2000;
const MAX_WHY_ITEMS = 5;
const MAX_WHY_ITEM_LENGTH = 280;
const MAX_FLAGS = 10;
const MAX_FLAG_LENGTH = 64;
const MAX_SAVED_PHRASES = 8;
const MAX_PHRASE_LENGTH = 120;
const MIN_PHRASE_LENGTH = 4;
const MIN_PHRASE_WORDS = 2;
const MAX_PHRASE_WORDS = 8;
const CYRILLIC_PATTERN = /[А-Яа-яІіЇїЄєҐґ]/;

export class AntiCorruptionMapperError extends Error {
  readonly code:
    | "INVALID_JOB"
    | "INVALID_AI_PAYLOAD"
    | "CONTEXT_MISMATCH"
    | "INVALID_MAPPED_RESULT";
  readonly details?: unknown;

  constructor(
    code: AntiCorruptionMapperError["code"],
    message: string,
    details?: unknown
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export type DomainRoleplayTurn = {
  sessionId: string;
  userId: string;
  seq: number;
  scenarioId: string;
  contextVersion: number;
  safety: {
    blocked: boolean;
    flags: string[];
  };
  assistantMessage: {
    role: "ASSISTANT";
    text: string;
    payloadHash: string;
    metadata: {
      source: "ai";
      version: number;
      blocked: boolean;
      flags: string[];
    };
  };
  correction: {
    originalText: string;
    naturalText: string;
    explanation: {
      translationUk: string;
      why: string[];
      flags: string[];
      blocked: boolean;
    };
    suggestions: {
      phrases: string[];
    };
  };
  savedPhrases: Array<{
    userId: string;
    sessionId: string;
    phrase: string;
    context: string;
    source: "assistant_correction";
  }>;
};

function normalizeWhitespace(input: string) {
  return input.trim().replace(/\s+/g, " ");
}

function clampText(input: string, maxLength: number) {
  if (input.length <= maxLength) {
    return input;
  }

  return input.slice(0, maxLength).trim();
}

function normalizeText(input: string, maxLength: number) {
  return clampText(normalizeWhitespace(input), maxLength);
}

function uniqueNormalizedList(
  items: string[],
  maxItems: number,
  maxItemLength: number
) {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const item of items) {
    const normalized = normalizeText(item, maxItemLength);

    if (!normalized) {
      continue;
    }

    const dedupeKey = normalized.toLowerCase();

    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    output.push(normalized);

    if (output.length >= maxItems) {
      break;
    }
  }

  return output;
}

function mapEnglishRuleHintToUkrainian(input: string) {
  const normalized = input.toLowerCase();

  if (
    normalized.includes("capital letter") ||
    normalized.includes("uppercase")
  ) {
    return "Речення в англійській мові зазвичай починається з великої літери.";
  }

  if (
    normalized.includes("article") ||
    normalized.includes("a/an/the")
  ) {
    return "Тут потрібно правильно підібрати артикль a/an/the.";
  }

  if (
    normalized.includes("tense") ||
    normalized.includes("past") ||
    normalized.includes("present") ||
    normalized.includes("future")
  ) {
    return "Потрібно узгодити час дієслова з контекстом речення.";
  }

  if (normalized.includes("preposition")) {
    return "Тут потрібен правильний прийменник, щоб фраза звучала природно.";
  }

  if (normalized.includes("word order")) {
    return "У цьому місці важливий правильний порядок слів у реченні.";
  }

  if (normalized.includes("polite")) {
    return "Цей варіант звучить ввічливіше і природніше для розмови.";
  }

  if (
    normalized.includes("natural") ||
    normalized.includes("native")
  ) {
    return "Цей варіант природніше звучить у живому спілкуванні.";
  }

  return "Ця форма граматично правильніша й природніше звучить у цьому контексті.";
}

function localizeWhyLinesToUkrainian(input: string[]) {
  const cleaned = uniqueNormalizedList(
    input,
    MAX_WHY_ITEMS * 3,
    MAX_WHY_ITEM_LENGTH
  );

  return uniqueNormalizedList(
    cleaned.map((line) =>
      CYRILLIC_PATTERN.test(line)
        ? line
        : mapEnglishRuleHintToUkrainian(line)
    ),
    MAX_WHY_ITEMS,
    MAX_WHY_ITEM_LENGTH
  );
}

function countPhraseWords(input: string) {
  const words = input.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  return words?.length ?? 0;
}

function isPhraseCandidate(input: { phrase: string; context: string }) {
  const phrase = input.phrase;
  const context = normalizeWhitespace(input.context);

  if (!phrase || phrase.length < MIN_PHRASE_LENGTH) {
    return false;
  }

  if (phrase.toLowerCase() === context.toLowerCase()) {
    return false;
  }

  const wordCount = countPhraseWords(phrase);

  if (wordCount < MIN_PHRASE_WORDS || wordCount > MAX_PHRASE_WORDS) {
    return false;
  }

  return true;
}

function mapSavedPhrases(input: {
  userId: string;
  sessionId: string;
  naturalText: string;
  phrases: string[];
}) {
  const phrases = uniqueNormalizedList(
    input.phrases,
    MAX_SAVED_PHRASES,
    MAX_PHRASE_LENGTH
  ).filter((phrase) =>
    isPhraseCandidate({
      phrase,
      context: input.naturalText
    })
  );

  return phrases.map((phrase) => ({
    userId: input.userId,
    sessionId: input.sessionId,
    phrase,
    context: input.naturalText,
    source: "assistant_correction" as const
  }));
}

function ensureContextMatch(job: RoleplayTurnJob, aiPayload: RoleplayTurnResult) {
  if (job.sessionId !== aiPayload.sessionId || job.seq !== aiPayload.seq) {
    throw new AntiCorruptionMapperError(
      "CONTEXT_MISMATCH",
      "AI payload does not match job sessionId/seq.",
      {
        expected: {
          sessionId: job.sessionId,
          seq: job.seq
        },
        received: {
          sessionId: aiPayload.sessionId,
          seq: aiPayload.seq
        }
      }
    );
  }
}

function ensureDomainPayload(payload: DomainRoleplayTurn) {
  if (!payload.assistantMessage.text) {
    throw new AntiCorruptionMapperError(
      "INVALID_MAPPED_RESULT",
      "Mapped assistant message is empty."
    );
  }

  if (!payload.correction.naturalText) {
    throw new AntiCorruptionMapperError(
      "INVALID_MAPPED_RESULT",
      "Mapped correction naturalText is empty."
    );
  }

  if (!payload.correction.explanation.translationUk) {
    throw new AntiCorruptionMapperError(
      "INVALID_MAPPED_RESULT",
      "Mapped correction translationUk is empty."
    );
  }

  if (payload.correction.explanation.why.length === 0) {
    throw new AntiCorruptionMapperError(
      "INVALID_MAPPED_RESULT",
      "Mapped correction explanation is empty."
    );
  }
}

export function mapAiPayloadToDomain(input: {
  job: RoleplayTurnJob;
  aiPayload: RoleplayTurnResult;
}): DomainRoleplayTurn {
  const parsedJob = RoleplayTurnJobSchema.safeParse(input.job);

  if (!parsedJob.success) {
    throw new AntiCorruptionMapperError(
      "INVALID_JOB",
      "Worker job is invalid for domain mapping.",
      parsedJob.error.flatten()
    );
  }

  const parsedAiPayload = RoleplayTurnResultSchema.safeParse(input.aiPayload);

  if (!parsedAiPayload.success) {
    throw new AntiCorruptionMapperError(
      "INVALID_AI_PAYLOAD",
      "AI payload is invalid for domain mapping.",
      parsedAiPayload.error.flatten()
    );
  }

  const job = parsedJob.data;
  const aiPayload = parsedAiPayload.data;

  ensureContextMatch(job, aiPayload);

  const originalText = normalizeText(job.inputText, MAX_CORRECTION_TEXT_LENGTH);
  const naturalTextRaw = normalizeText(
    aiPayload.correction.natural,
    MAX_CORRECTION_TEXT_LENGTH
  );
  const naturalText = naturalTextRaw || originalText;
  const translationUkRaw = normalizeText(
    aiPayload.correction.translationUk,
    MAX_CORRECTION_TEXT_LENGTH
  );
  const translationUk = translationUkRaw || naturalText;
  const assistantTextRaw = normalizeText(
    aiPayload.assistantReply,
    MAX_ASSISTANT_TEXT_LENGTH
  );
  const assistantText = assistantTextRaw || naturalText;
  const why = localizeWhyLinesToUkrainian(
    aiPayload.correction.why,
  );
  const explanation =
    why.length > 0
      ? why
      : ["Пояснення було відновлено автоматично через некоректний формат відповіді моделі."];
  const flags = uniqueNormalizedList(
    aiPayload.safety.flags,
    MAX_FLAGS,
    MAX_FLAG_LENGTH
  );
  const savedPhrases = mapSavedPhrases({
    userId: job.userId,
    sessionId: job.sessionId,
    naturalText,
    phrases: aiPayload.phrases
  });

  const mapped: DomainRoleplayTurn = {
    sessionId: job.sessionId,
    userId: job.userId,
    seq: job.seq,
    scenarioId: job.scenarioId,
    contextVersion: job.contextVersion,
    safety: {
      blocked: aiPayload.safety.blocked,
      flags
    },
    assistantMessage: {
      role: "ASSISTANT",
      text: assistantText,
      payloadHash: aiPayload.payloadHash,
      metadata: {
        source: "ai",
        version: aiPayload.version,
        blocked: aiPayload.safety.blocked,
        flags
      }
    },
    correction: {
      originalText,
      naturalText,
      explanation: {
        translationUk,
        why: explanation,
        flags,
        blocked: aiPayload.safety.blocked
      },
      suggestions: {
        phrases: savedPhrases.map((item) => item.phrase)
      }
    },
    savedPhrases
  };

  ensureDomainPayload(mapped);
  return mapped;
}
