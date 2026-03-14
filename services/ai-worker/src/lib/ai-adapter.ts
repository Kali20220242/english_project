import { createHash } from "node:crypto";

import {
  DEFAULT_AI_MODEL,
  RoleplayTurnJobSchema,
  RoleplayTurnResultSchema,
  type RoleplayTurnJob,
  type RoleplayTurnResult
} from "@neontalk/contracts";

const openAiBaseUrl = (
  process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"
).replace(/\/+$/, "");
const openAiApiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
const defaultOpenAiModel = process.env.OPENAI_MODEL?.trim() || DEFAULT_AI_MODEL;
const anthropicBaseUrl = (
  process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1"
).replace(/\/+$/, "");
const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
const configuredAnthropicModel = process.env.ANTHROPIC_MODEL?.trim() ?? "";
const defaultAnthropicModel = configuredAnthropicModel || "claude-sonnet-4-20250514";
const anthropicVersion = process.env.ANTHROPIC_VERSION?.trim() || "2023-06-01";
const parsedAnthropicMaxTokens = Number.parseInt(
  process.env.ANTHROPIC_MAX_TOKENS ?? "1024",
  10
);
const anthropicMaxTokens =
  Number.isFinite(parsedAnthropicMaxTokens) && parsedAnthropicMaxTokens > 0
    ? parsedAnthropicMaxTokens
    : 1024;
const parsedOpenAiTimeoutMs = Number.parseInt(
  process.env.WORKER_AI_TIMEOUT_MS ?? "45000",
  10
);
const openAiTimeoutMs =
  Number.isFinite(parsedOpenAiTimeoutMs) && parsedOpenAiTimeoutMs > 0
    ? parsedOpenAiTimeoutMs
    : 45000;

export class AiAdapterError extends Error {
  readonly code:
    | "OPENAI_HTTP_ERROR"
    | "OPENAI_BAD_RESPONSE"
    | "OPENAI_NETWORK_ERROR"
    | "ANTHROPIC_HTTP_ERROR"
    | "ANTHROPIC_BAD_RESPONSE"
    | "ANTHROPIC_NETWORK_ERROR"
    | "MODEL_PROVIDER_NOT_CONFIGURED"
    | "INVALID_JSON_RESPONSE"
    | "INVALID_JSON_SCHEMA"
    | "INVALID_RESULT_CONTEXT";

  readonly details?: unknown;

  constructor(
    code: AiAdapterError["code"],
    message: string,
    details?: unknown
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export type GenerateRoleplayTurnResult = {
  provider: "openai" | "anthropic" | "mock";
  model: string;
  rawContent: string;
  result: RoleplayTurnResult;
};

type OpenAiChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  error?: {
    message?: string;
  };
};

type AnthropicContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
};

type AnthropicMessagesResponse = {
  content?: AnthropicContentBlock[];
  error?: {
    message?: string;
    type?: string;
  };
};

type JsonRecord = Record<string, unknown>;

function isAnthropicModel(model: string) {
  const normalized = model.trim().toLowerCase();
  return (
    normalized.startsWith("claude-") ||
    normalized.includes("/claude-") ||
    normalized.includes(":claude-")
  );
}

function capitalizeFirstLetter(input: string) {
  if (!input) {
    return input;
  }

  return `${input[0]!.toUpperCase()}${input.slice(1)}`;
}

function normalizeWhitespace(input: string) {
  return input.trim().replace(/\s+/g, " ");
}

function buildPayloadHash(input: {
  sessionId: string;
  seq: number;
  assistantReply: string;
  natural: string;
  translationUk: string;
  why: string[];
  phrases: string[];
  blocked: boolean;
  flags: string[];
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sessionId: input.sessionId,
        seq: input.seq,
        assistantReply: input.assistantReply,
        natural: input.natural,
        translationUk: input.translationUk,
        why: input.why,
        phrases: input.phrases,
        blocked: input.blocked,
        flags: input.flags
      })
    )
    .digest("hex");
}

function buildMockModelOutput(job: RoleplayTurnJob) {
  const original = normalizeWhitespace(job.inputText);
  const natural = capitalizeFirstLetter(original);
  const translationUk = "Я хочу попрактикувати англійську в діалозі.";
  const assistantReply = `Nice turn. A smoother phrasing is: "${natural}"`;
  const why =
    natural === original
      ? ["Речення вже звучить природно англійською."]
      : [
          "На початку англійського речення ставимо велику літеру.",
          "Перефразування зберігає зміст і робить фразу більш природною."
        ];
  const phrases = [
    "That sounds natural.",
    "A smoother way to say it is ..."
  ];
  const blocked = false;
  const flags: string[] = [];
  const payloadHash = buildPayloadHash({
    sessionId: job.sessionId,
    seq: job.seq,
    assistantReply,
    natural,
    translationUk,
    why,
    phrases,
    blocked,
    flags
  });

  return JSON.stringify({
    sessionId: job.sessionId,
    seq: job.seq,
    assistantReply,
    correction: {
      original,
      natural,
      translationUk,
      why
    },
    phrases,
    safety: {
      blocked,
      flags
    },
    version: 1,
    payloadHash
  });
}

function buildSystemPrompt() {
  return [
    "You are an English speaking coach for roleplay practice.",
    "Return exactly one valid JSON object.",
    "Do not use markdown.",
    "Do not wrap output in code fences.",
    "JSON must have keys: sessionId, seq, assistantReply, correction, phrases, safety, version, payloadHash.",
    "correction must include: original, natural, translationUk, why (array with at least 1 item).",
    "correction.translationUk must be a Ukrainian translation of correction.natural.",
    "Every item in correction.why must be written in Ukrainian and explain grammar/usage rule clearly.",
    "safety must include: blocked (boolean), flags (string array).",
    "Keep assistantReply concise (max 80 words).",
    "phrases must be short reusable chunks (2-8 words), not full sentences, and not equal to correction.natural.",
    "Keep phrases array short (0-5 items)."
  ].join(" ");
}

function buildUserPrompt(job: RoleplayTurnJob) {
  return JSON.stringify({
    task: "Generate assistant reply and correction for the learner turn.",
    explanationLanguage: "uk",
    translationLanguage: "uk",
    job
  });
}

function stripMarkdownCodeFences(input: string) {
  const fenced = input
    .trim()
    .match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];

  return fenced ? fenced.trim() : input.trim();
}

function extractJsonObject(input: string) {
  const start = input.indexOf("{");
  const end = input.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  return input.slice(start, end + 1);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getNestedRecord(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }

  return value;
}

function takeFirstString(candidates: unknown[]) {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }

    const normalized = normalizeWhitespace(candidate);

    if (normalized.length > 0) {
      return normalized;
    }
  }

  return null;
}

function toStringList(input: unknown) {
  if (Array.isArray(input)) {
    return input
      .flatMap((item) => (typeof item === "string" ? [item] : []))
      .map((item) => normalizeWhitespace(item))
      .filter((item) => item.length > 0);
  }

  if (typeof input !== "string") {
    return [];
  }

  return input
    .split(/\n|,/g)
    .map((item) => normalizeWhitespace(item))
    .filter((item) => item.length > 0);
}

function toPositiveInteger(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed > 0 ? parsed : null;
}

function toBoolean(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "true") {
    return true;
  }

  if (normalized === "false") {
    return false;
  }

  return null;
}

function uniqueList(items: string[]) {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const item of items) {
    const dedupeKey = item.toLowerCase();

    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    output.push(item);
  }

  return output;
}

function repairModelResult(raw: unknown, job: RoleplayTurnJob): RoleplayTurnResult {
  const root = getNestedRecord(raw) ?? {};
  const correction = getNestedRecord(root["correction"]);
  const safety = getNestedRecord(root["safety"]);
  const original =
    takeFirstString([
      correction?.["original"],
      root["original"],
      root["originalText"],
      job.inputText
    ]) ?? normalizeWhitespace(job.inputText);
  const assistantReply =
    takeFirstString([
      root["assistantReply"],
      root["assistant_response"],
      root["reply"],
      root["response"],
      root["answer"],
      root["text"],
      correction?.["natural"],
      correction?.["rewrite"]
    ]) ??
    `Nice try. A smoother way to say it is: "${capitalizeFirstLetter(original)}".`;
  const natural =
    takeFirstString([
      correction?.["natural"],
      correction?.["rewrite"],
      root["natural"],
      root["rewrite"],
      root["corrected"],
      assistantReply
    ]) ?? original;
  const translationUk =
    takeFirstString([
      correction?.["translationUk"],
      correction?.["translation_uk"],
      correction?.["ukrainianTranslation"],
      root["translationUk"],
      root["translation_uk"],
      root["ukrainianTranslation"]
    ]) ?? natural;
  const why = uniqueList(
    [
      ...toStringList(correction?.["why"]),
      ...toStringList(correction?.["whyUk"]),
      ...toStringList(correction?.["explanation"]),
      ...toStringList(correction?.["explanationUk"]),
      ...toStringList(root["why"]),
      ...toStringList(root["whyUk"]),
      ...toStringList(root["explanation"]),
      ...toStringList(root["explanationUk"]),
      ...toStringList(root["reasons"])
    ].filter(Boolean)
  );
  const explanation =
    why.length > 0
      ? why
      : ["Цей варіант природніший для розмовної англійської в цьому контексті."];
  const phrases = uniqueList(
    [
      ...toStringList(root["phrases"]),
      ...toStringList(root["savedPhrases"]),
      ...toStringList(root["vocabulary"])
    ]
  ).slice(0, 8);
  const blocked =
    toBoolean(safety?.["blocked"]) ?? toBoolean(root["blocked"]) ?? false;
  const flags = uniqueList(
    [...toStringList(safety?.["flags"]), ...toStringList(root["flags"])].slice(0, 10)
  );
  const sessionId =
    takeFirstString([root["sessionId"], root["session_id"]]) ?? job.sessionId;
  const seq = toPositiveInteger(root["seq"]) ?? job.seq;
  const version = toPositiveInteger(root["version"]) ?? 1;
  const payloadHashCandidate = takeFirstString([
    root["payloadHash"],
    root["payload_hash"]
  ]);
  const payloadHash =
    payloadHashCandidate && payloadHashCandidate.length >= 8
      ? payloadHashCandidate
      : buildPayloadHash({
          sessionId,
          seq,
          assistantReply,
          natural,
          translationUk,
          why: explanation,
          phrases,
          blocked,
          flags
        });

  return {
    sessionId,
    seq,
    assistantReply,
    correction: {
      original,
      natural,
      translationUk,
      why: explanation
    },
    phrases,
    safety: {
      blocked,
      flags
    },
    version,
    payloadHash
  };
}

function parseStrictResult(rawContent: string, job: RoleplayTurnJob) {
  const normalized = stripMarkdownCodeFences(rawContent);
  const candidates = [normalized, extractJsonObject(normalized)].filter(
    (candidate): candidate is string => Boolean(candidate)
  );

  let parsed: unknown = null;
  let parseError: unknown = null;

  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate);
      parseError = null;
      break;
    } catch (error) {
      parseError = error;
    }
  }

  if (parseError) {
    throw new AiAdapterError(
      "INVALID_JSON_RESPONSE",
      "Model response is not valid JSON.",
      {
        error: parseError instanceof Error ? parseError.message : String(parseError),
        rawPreview: rawContent.slice(0, 1200)
      }
    );
  }

  const strictValidated = RoleplayTurnResultSchema.safeParse(parsed);

  if (strictValidated.success) {
    if (
      strictValidated.data.sessionId !== job.sessionId ||
      strictValidated.data.seq !== job.seq
    ) {
      throw new AiAdapterError(
        "INVALID_RESULT_CONTEXT",
        "Model response has mismatched sessionId/seq.",
        {
          expected: {
            sessionId: job.sessionId,
            seq: job.seq
          },
          received: {
            sessionId: strictValidated.data.sessionId,
            seq: strictValidated.data.seq
          }
        }
      );
    }

    return strictValidated.data;
  }

  const repaired = repairModelResult(parsed, job);
  const repairedValidated = RoleplayTurnResultSchema.safeParse(repaired);

  if (!repairedValidated.success) {
    throw new AiAdapterError(
      "INVALID_JSON_SCHEMA",
      "Model response failed contract validation.",
      {
        issues: strictValidated.error.issues,
        repairedIssues: repairedValidated.error.issues,
        rawPreview: rawContent.slice(0, 1200)
      }
    );
  }

  return repairedValidated.data;
}

async function callOpenAi(job: RoleplayTurnJob, model: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), openAiTimeoutMs);

  try {
    const response = await fetch(`${openAiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openAiApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: {
          type: "json_object"
        },
        messages: [
          {
            role: "system",
            content: buildSystemPrompt()
          },
          {
            role: "user",
            content: buildUserPrompt(job)
          }
        ]
      }),
      signal: controller.signal
    });

    const responseText = await response.text();
    let parsedResponse: OpenAiChatCompletionResponse | null = null;

    try {
      parsedResponse = JSON.parse(responseText) as OpenAiChatCompletionResponse;
    } catch (error) {
      if (!response.ok) {
        throw new AiAdapterError(
          "OPENAI_HTTP_ERROR",
          `OpenAI request failed with status ${response.status}.`,
          {
            status: response.status,
            bodyPreview: responseText.slice(0, 1500)
          }
        );
      }

      throw new AiAdapterError(
        "OPENAI_BAD_RESPONSE",
        "OpenAI response is not JSON.",
        {
          bodyPreview: responseText.slice(0, 1500),
          error: error instanceof Error ? error.message : String(error)
        }
      );
    }

    if (!response.ok) {
      throw new AiAdapterError(
        "OPENAI_HTTP_ERROR",
        `OpenAI request failed with status ${response.status}.`,
        {
          status: response.status,
          apiError: parsedResponse?.error?.message ?? null
        }
      );
    }

    const content = parsedResponse?.choices?.[0]?.message?.content;

    if (typeof content !== "string" || content.trim().length === 0) {
      throw new AiAdapterError(
        "OPENAI_BAD_RESPONSE",
        "OpenAI response does not contain assistant content.",
        {
          responsePreview: responseText.slice(0, 1500)
        }
      );
    }

    return content;
  } catch (error) {
    if (error instanceof AiAdapterError) {
      throw error;
    }

    throw new AiAdapterError(
      "OPENAI_NETWORK_ERROR",
      "OpenAI request failed due to network/runtime error.",
      {
        error: error instanceof Error ? error.message : String(error)
      }
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function callAnthropic(job: RoleplayTurnJob, model: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), openAiTimeoutMs);

  try {
    const response = await fetch(`${anthropicBaseUrl}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": anthropicApiKey,
        "anthropic-version": anthropicVersion,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        max_tokens: anthropicMaxTokens,
        temperature: 0.2,
        system: buildSystemPrompt(),
        tools: [
          {
            name: "submit_roleplay_turn",
            description: "Submit exactly one roleplay turn JSON payload.",
            input_schema: {
              type: "object",
              properties: {
                sessionId: { type: "string" },
                seq: { type: "integer" },
                assistantReply: { type: "string" },
                correction: {
                  type: "object",
                  properties: {
                    original: { type: "string" },
                    natural: { type: "string" },
                    translationUk: { type: "string" },
                    why: {
                      type: "array",
                      items: { type: "string" }
                    }
                  },
                  required: ["original", "natural", "translationUk", "why"]
                },
                phrases: {
                  type: "array",
                  items: { type: "string" }
                },
                safety: {
                  type: "object",
                  properties: {
                    blocked: { type: "boolean" },
                    flags: {
                      type: "array",
                      items: { type: "string" }
                    }
                  },
                  required: ["blocked", "flags"]
                },
                version: { type: "integer" },
                payloadHash: { type: "string" }
              },
              required: [
                "sessionId",
                "seq",
                "assistantReply",
                "correction",
                "phrases",
                "safety",
                "version",
                "payloadHash"
              ]
            }
          }
        ],
        tool_choice: {
          type: "tool",
          name: "submit_roleplay_turn"
        },
        messages: [
          {
            role: "user",
            content: buildUserPrompt(job)
          }
        ]
      }),
      signal: controller.signal
    });

    const responseText = await response.text();
    let parsedResponse: AnthropicMessagesResponse | null = null;

    try {
      parsedResponse = JSON.parse(responseText) as AnthropicMessagesResponse;
    } catch (error) {
      if (!response.ok) {
        throw new AiAdapterError(
          "ANTHROPIC_HTTP_ERROR",
          `Anthropic request failed with status ${response.status}.`,
          {
            status: response.status,
            bodyPreview: responseText.slice(0, 1500)
          }
        );
      }

      throw new AiAdapterError(
        "ANTHROPIC_BAD_RESPONSE",
        "Anthropic response is not JSON.",
        {
          bodyPreview: responseText.slice(0, 1500),
          error: error instanceof Error ? error.message : String(error)
        }
      );
    }

    if (!response.ok) {
      throw new AiAdapterError(
        "ANTHROPIC_HTTP_ERROR",
        `Anthropic request failed with status ${response.status}.`,
        {
          status: response.status,
          apiError: parsedResponse?.error?.message ?? null,
          apiErrorType: parsedResponse?.error?.type ?? null
        }
      );
    }

    const toolUseBlock = (parsedResponse?.content ?? []).find(
      (
        block
      ): block is {
        type: "tool_use";
        name?: string;
        input?: unknown;
      } =>
        block.type === "tool_use" &&
        block.name === "submit_roleplay_turn" &&
        typeof block.input !== "undefined"
    );

    if (toolUseBlock) {
      return JSON.stringify(toolUseBlock.input);
    }

    const textContent = (parsedResponse?.content ?? [])
      .map((block) =>
        block.type === "text" && typeof block.text === "string"
          ? block.text.trim()
          : ""
      )
      .filter(Boolean)
      .join("\n")
      .trim();

    if (!textContent) {
      throw new AiAdapterError(
        "ANTHROPIC_BAD_RESPONSE",
        "Anthropic response does not contain text content.",
        {
          responsePreview: responseText.slice(0, 1500)
        }
      );
    }

    return textContent;
  } catch (error) {
    if (error instanceof AiAdapterError) {
      throw error;
    }

    throw new AiAdapterError(
      "ANTHROPIC_NETWORK_ERROR",
      "Anthropic request failed due to network/runtime error.",
      {
        error: error instanceof Error ? error.message : String(error)
      }
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateRoleplayTurn(input: RoleplayTurnJob) {
  const job = RoleplayTurnJobSchema.parse(input);
  const requestedModel = job.aiModel?.trim() || defaultOpenAiModel;
  const requiresAnthropic = isAnthropicModel(requestedModel);

  let provider: GenerateRoleplayTurnResult["provider"] = "mock";
  let model = "mock-roleplay-v1";
  let rawContent = "";

  if (requiresAnthropic) {
    if (anthropicApiKey.length === 0) {
      throw new AiAdapterError(
        "MODEL_PROVIDER_NOT_CONFIGURED",
        `Model "${requestedModel}" requires Anthropic credentials. Set ANTHROPIC_API_KEY.`,
        {
          model: requestedModel
        }
      );
    }

    provider = "anthropic";
    model = requestedModel;
    rawContent = await callAnthropic(job, requestedModel);
  } else if (openAiApiKey.length > 0) {
    provider = "openai";
    model = requestedModel;
    rawContent = await callOpenAi(job, requestedModel);
  } else if (anthropicApiKey.length > 0) {
    provider = "anthropic";
    model = defaultAnthropicModel;
    rawContent = await callAnthropic(job, model);
  } else {
    provider = "mock";
    model = "mock-roleplay-v1";
    rawContent = buildMockModelOutput(job);
  }

  const result = parseStrictResult(rawContent, job);

  return {
    provider,
    model,
    rawContent,
    result
  } satisfies GenerateRoleplayTurnResult;
}
