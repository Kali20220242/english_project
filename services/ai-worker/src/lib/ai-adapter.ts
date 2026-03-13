import { createHash } from "node:crypto";

import {
  RoleplayTurnJobSchema,
  RoleplayTurnResultSchema,
  type RoleplayTurnJob,
  type RoleplayTurnResult
} from "@neontalk/contracts";

const openAiBaseUrl = (
  process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"
).replace(/\/+$/, "");
const openAiApiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
const openAiModel = process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini";
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
  provider: "openai" | "mock";
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
  const assistantReply = `Nice turn. A smoother phrasing is: "${natural}"`;
  const why =
    natural === original
      ? ["Your sentence is already clear and natural."]
      : [
          "English sentence openings usually start with a capital letter.",
          "The rewrite keeps your meaning and makes it sound more native-like."
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
    "correction must include: original, natural, why (array with at least 1 item).",
    "safety must include: blocked (boolean), flags (string array).",
    "Keep assistantReply concise (max 80 words).",
    "Keep phrases array short (0-5 items)."
  ].join(" ");
}

function buildUserPrompt(job: RoleplayTurnJob) {
  return JSON.stringify({
    task: "Generate assistant reply and correction for the learner turn.",
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

  const validated = RoleplayTurnResultSchema.safeParse(parsed);

  if (!validated.success) {
    throw new AiAdapterError(
      "INVALID_JSON_SCHEMA",
      "Model response failed contract validation.",
      {
        issues: validated.error.issues,
        rawPreview: rawContent.slice(0, 1200)
      }
    );
  }

  if (
    validated.data.sessionId !== job.sessionId ||
    validated.data.seq !== job.seq
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
          sessionId: validated.data.sessionId,
          seq: validated.data.seq
        }
      }
    );
  }

  return validated.data;
}

async function callOpenAi(job: RoleplayTurnJob) {
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
        model: openAiModel,
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

export async function generateRoleplayTurn(input: RoleplayTurnJob) {
  const job = RoleplayTurnJobSchema.parse(input);
  const useOpenAi = openAiApiKey.length > 0;
  const rawContent = useOpenAi
    ? await callOpenAi(job)
    : buildMockModelOutput(job);
  const result = parseStrictResult(rawContent, job);

  return {
    provider: useOpenAi ? "openai" : "mock",
    model: useOpenAi ? openAiModel : "mock-roleplay-v1",
    rawContent,
    result
  } satisfies GenerateRoleplayTurnResult;
}
