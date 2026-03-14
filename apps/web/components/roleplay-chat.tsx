"use client";

import { startTransition, useEffect, useState } from "react";

import {
  loadActiveSessionState,
  type ActiveSessionState
} from "../lib/active-session-state";
import { buildApiHeaders } from "../lib/api-request";
import { useAuth } from "./auth-provider";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";
const pollIntervalMs = 1200;
const maxWhyItems = 6;
const maxWhyLength = 280;
const maxSuggestedPhrases = 8;
const maxPhraseLength = 120;

type ApiMessageCorrection = {
  originalText: string;
  naturalText: string;
  explanation: unknown;
  suggestions: unknown;
} | null;

type ApiSessionMessage = {
  id: string;
  sessionId: string;
  seq: number;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  text: string;
  createdAt: string;
  correction?: ApiMessageCorrection;
};

type SessionMessagesResponse = {
  items: ApiSessionMessage[];
};

type ChatMessage = {
  id: string;
  seq: number;
  role: ApiSessionMessage["role"];
  text: string;
  createdAt: string;
  correction: {
    naturalText: string;
    why: string[];
    suggestions: string[];
  } | null;
  optimistic?: boolean;
};

function sortBySequence(items: ChatMessage[]) {
  return [...items].sort((a, b) => a.seq - b.seq);
}

function mergeMessages(previous: ChatMessage[], incoming: ChatMessage[]) {
  const bySeq = new Map<number, ChatMessage>();

  for (const message of previous) {
    bySeq.set(message.seq, message);
  }

  for (const message of incoming) {
    bySeq.set(message.seq, message);
  }

  return sortBySequence(Array.from(bySeq.values()));
}

function resolveApiError(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object") {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }

    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) {
      return error;
    }
  }

  return fallback;
}

function normalizeLine(input: unknown, maxLength: number) {
  if (typeof input !== "string") {
    return "";
  }

  return input.trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function normalizeUniqueLines(input: unknown, options: {
  maxItems: number;
  maxLength: number;
}) {
  if (!Array.isArray(input)) {
    return [];
  }

  const seen = new Set<string>();
  const output: string[] = [];

  for (const item of input) {
    const normalized = normalizeLine(item, options.maxLength);

    if (!normalized) {
      continue;
    }

    const dedupeKey = normalized.toLowerCase();

    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    output.push(normalized);

    if (output.length >= options.maxItems) {
      break;
    }
  }

  return output;
}

function normalizeCorrection(input: ApiMessageCorrection) {
  if (!input) {
    return null;
  }

  const naturalText = normalizeLine(input.naturalText, 2000);
  const explanationSource =
    input.explanation &&
    typeof input.explanation === "object" &&
    "why" in input.explanation
      ? (input.explanation as { why?: unknown }).why
      : input.explanation;
  const why = normalizeUniqueLines(explanationSource, {
    maxItems: maxWhyItems,
    maxLength: maxWhyLength
  });
  const suggestionsSource =
    input.suggestions &&
    typeof input.suggestions === "object" &&
    "phrases" in input.suggestions
      ? (input.suggestions as { phrases?: unknown }).phrases
      : input.suggestions;
  const suggestions = normalizeUniqueLines(suggestionsSource, {
    maxItems: maxSuggestedPhrases,
    maxLength: maxPhraseLength
  });

  if (!naturalText && why.length === 0 && suggestions.length === 0) {
    return null;
  }

  return {
    naturalText,
    why,
    suggestions
  };
}

function buildSavedPhraseKey(messageId: string, phrase: string) {
  return `${messageId}:${phrase.trim().toLowerCase()}`;
}

function collectSaveCandidates(message: ChatMessage) {
  if (!message.correction) {
    return [];
  }

  const candidates = [
    message.correction.naturalText,
    ...message.correction.suggestions
  ]
    .map((item) => item.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const output: string[] = [];

  for (const phrase of candidates) {
    const dedupeKey = phrase.toLowerCase();

    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    output.push(phrase);
  }

  return output;
}

function mapApiMessagesToChat(items: ApiSessionMessage[]) {
  return sortBySequence(
    items.map((item) => ({
      id: item.id,
      seq: item.seq,
      role: item.role,
      text: item.text,
      createdAt: item.createdAt,
      correction: normalizeCorrection(item.correction ?? null)
    }))
  );
}

function buildPendingPlaceholder(nextSeq: number): ChatMessage {
  return {
    id: `pending-${nextSeq}`,
    seq: nextSeq,
    role: "ASSISTANT",
    text: "Assistant is thinking...",
    createdAt: new Date().toISOString(),
    correction: null,
    optimistic: true
  };
}

export function RoleplayChat() {
  const { user, getIdToken } = useAuth();
  const [activeSession, setActiveSession] = useState<ActiveSessionState | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [pendingUserSeq, setPendingUserSeq] = useState<number | null>(null);
  const [statusKind, setStatusKind] = useState<"idle" | "ok" | "error">("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [savingPhraseKey, setSavingPhraseKey] = useState<string | null>(null);
  const [savedPhraseKeys, setSavedPhraseKeys] = useState<string[]>([]);

  function refreshActiveSession() {
    setActiveSession(loadActiveSessionState());
  }

  useEffect(() => {
    refreshActiveSession();
  }, []);

  useEffect(() => {
    setSavedPhraseKeys([]);
  }, [activeSession?.sessionId]);

  async function fetchSessionMessages(input: {
    sessionId: string;
    silent?: boolean;
  }) {
    if (!user) {
      return [];
    }

    const token = await getIdToken();

    if (!token) {
      throw new Error("Could not get Firebase ID token.");
    }

    if (!input.silent) {
      setIsLoading(true);
    }

    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/sessions/${input.sessionId}/messages?limit=300`,
        {
          method: "GET",
          headers: buildApiHeaders({
            token
          })
        }
      );

      let payload: unknown = null;

      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok) {
        throw new Error(
          resolveApiError(payload, `Failed to load messages (${response.status}).`)
        );
      }

      const result = payload as SessionMessagesResponse;
      const incoming = mapApiMessagesToChat(result.items);
      setMessages((previous) => mergeMessages(previous, incoming));
      return incoming;
    } finally {
      if (!input.silent) {
        setIsLoading(false);
      }
    }
  }

  useEffect(() => {
    if (!user || !activeSession?.sessionId) {
      return;
    }

    void fetchSessionMessages({
      sessionId: activeSession.sessionId
    }).catch((error) => {
      setStatusKind("error");
      setStatusMessage(
        error instanceof Error ? error.message : "Failed to load chat messages."
      );
    });
  }, [user, activeSession?.sessionId]);

  useEffect(() => {
    if (!user || !activeSession?.sessionId || pendingUserSeq === null) {
      return;
    }

    let cancelled = false;

    const tick = async () => {
      try {
        const incoming = await fetchSessionMessages({
          sessionId: activeSession.sessionId,
          silent: true
        });

        if (cancelled) {
          return;
        }

        const assistantReady = incoming.some(
          (message) => message.role === "ASSISTANT" && message.seq > pendingUserSeq
        );

        if (assistantReady) {
          startTransition(() => {
            setPendingUserSeq(null);
            setIsSending(false);
            setStatusKind("ok");
            setStatusMessage("Assistant answered.");
          });
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        startTransition(() => {
          setStatusKind("error");
          setStatusMessage(
            error instanceof Error
              ? error.message
              : "Polling failed while waiting for assistant turn."
          );
        });
      }
    };

    void tick();
    const interval = setInterval(() => {
      void tick();
    }, pollIntervalMs);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [user, activeSession?.sessionId, pendingUserSeq]);

  async function submitTurn() {
    if (!activeSession?.sessionId) {
      setStatusKind("error");
      setStatusMessage("Start a scenario session first.");
      return;
    }

    if (!draft.trim()) {
      setStatusKind("error");
      setStatusMessage("Type your turn first.");
      return;
    }

    if (pendingUserSeq !== null || isSending) {
      setStatusKind("error");
      setStatusMessage("Wait for the assistant response before sending next turn.");
      return;
    }

    const token = await getIdToken();

    if (!token) {
      setStatusKind("error");
      setStatusMessage("Could not get Firebase ID token.");
      return;
    }

    const text = draft.trim();
    const nextSeq = (messages.at(-1)?.seq ?? 0) + 1;
    const idempotencyKey =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `fallback-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    setIsSending(true);
    setDraft("");
    setPendingUserSeq(nextSeq);
    setStatusKind("idle");
    setStatusMessage("Sending turn...");
    setMessages((previous) =>
      mergeMessages(previous, [
        {
          id: `optimistic-${idempotencyKey}`,
          seq: nextSeq,
          role: "USER",
          text,
          createdAt: new Date().toISOString(),
          correction: null,
          optimistic: true
        }
      ])
    );

    try {
      const response = await fetch(`${apiBaseUrl}/v1/messages`, {
        method: "POST",
        headers: buildApiHeaders({
          token,
          json: true
        }),
        body: JSON.stringify({
          sessionId: activeSession.sessionId,
          seq: nextSeq,
          message: {
            role: "user",
            text
          },
          idempotencyKey,
          clientTs: new Date().toISOString()
        })
      });

      let payload: unknown = null;

      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok) {
        setMessages((previous) =>
          previous.filter((item) => item.seq !== nextSeq || !item.optimistic)
        );
        setPendingUserSeq(null);
        setIsSending(false);
        setStatusKind("error");
        setStatusMessage(
          resolveApiError(payload, `Failed to submit message (${response.status}).`)
        );
        return;
      }

      await fetchSessionMessages({
        sessionId: activeSession.sessionId,
        silent: true
      });
      setStatusKind("ok");
      setStatusMessage("Turn accepted. Waiting for assistant...");
    } catch (error) {
      setMessages((previous) =>
        previous.filter((item) => item.seq !== nextSeq || !item.optimistic)
      );
      setPendingUserSeq(null);
      setIsSending(false);
      setStatusKind("error");
      setStatusMessage(
        error instanceof Error ? error.message : "Network error while sending turn."
      );
    }
  }

  async function savePhrase(input: { message: ChatMessage; phrase: string }) {
    if (!activeSession?.sessionId) {
      setStatusKind("error");
      setStatusMessage("Start a scenario session first.");
      return;
    }

    if (!user) {
      setStatusKind("error");
      setStatusMessage("Sign in first to save phrases.");
      return;
    }

    const phrase = input.phrase.trim();

    if (!phrase) {
      setStatusKind("error");
      setStatusMessage("Phrase text is empty.");
      return;
    }

    const phraseKey = buildSavedPhraseKey(input.message.id, phrase);

    if (savedPhraseKeys.includes(phraseKey)) {
      setStatusKind("ok");
      setStatusMessage("Phrase already saved in this chat.");
      return;
    }

    const token = await getIdToken();

    if (!token) {
      setStatusKind("error");
      setStatusMessage("Could not get Firebase ID token.");
      return;
    }

    setSavingPhraseKey(phraseKey);

    try {
      const response = await fetch(`${apiBaseUrl}/v1/phrases`, {
        method: "POST",
        headers: buildApiHeaders({
          token,
          json: true
        }),
        body: JSON.stringify({
          phrase,
          context: input.message.correction?.naturalText || input.message.text,
          sessionId: activeSession.sessionId,
          sourceMessageId: input.message.id
        })
      });

      let payload: unknown = null;

      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok) {
        setStatusKind("error");
        setStatusMessage(
          resolveApiError(payload, `Failed to save phrase (${response.status}).`)
        );
        return;
      }

      setSavedPhraseKeys((previous) =>
        previous.includes(phraseKey) ? previous : [...previous, phraseKey]
      );
      setStatusKind("ok");
      setStatusMessage("Phrase saved to Phrase Vault.");
    } catch (error) {
      setStatusKind("error");
      setStatusMessage(
        error instanceof Error ? error.message : "Network error while saving phrase."
      );
    } finally {
      setSavingPhraseKey(null);
    }
  }

  const showPendingAssistant =
    pendingUserSeq !== null &&
    !messages.some(
      (message) => message.role === "ASSISTANT" && message.seq > pendingUserSeq
    );
  const displayedMessages = showPendingAssistant
    ? [...messages, buildPendingPlaceholder(pendingUserSeq + 1)]
    : messages;

  if (!user) {
    return (
      <div className="chat-panel">
        <p className="chat-status">Sign in first to open the roleplay chat.</p>
      </div>
    );
  }

  if (!activeSession) {
    return (
      <div className="chat-panel">
        <p className="chat-status">
          Start a scenario session in Scenario Picker to unlock the chat screen.
        </p>
      </div>
    );
  }

  return (
    <div className="chat-panel">
      <div className="chat-meta">
        <p>
          <strong>Session:</strong> <code>{activeSession.sessionId}</code>
        </p>
        <p>
          <strong>Scenario:</strong> {activeSession.scenario.title}
        </p>
        <button
          className="auth-button secondary"
          type="button"
          onClick={refreshActiveSession}
        >
          Refresh active session
        </button>
      </div>

      <div className="chat-window" aria-live="polite">
        {isLoading && messages.length === 0 ? (
          <p className="chat-empty">Loading chat history...</p>
        ) : displayedMessages.length === 0 ? (
          <p className="chat-empty">
            Send your first turn. Assistant response will appear here.
          </p>
        ) : (
          displayedMessages.map((message) => (
            <article
              key={message.id}
              className={`chat-bubble ${
                message.role === "USER" ? "user" : "assistant"
              }${message.optimistic ? " pending" : ""}`}
            >
              <header>
                <span>{message.role === "USER" ? "You" : "Assistant"}</span>
                <small>#{message.seq}</small>
              </header>
              <p>{message.text}</p>
              {message.role === "ASSISTANT" && message.correction ? (
                <section className="chat-rewrite" aria-label="Natural rewrite and why">
                  {message.correction.naturalText ? (
                    <>
                      <p className="chat-rewrite-title">Natural rewrite</p>
                      <p className="chat-rewrite-text">
                        {message.correction.naturalText}
                      </p>
                    </>
                  ) : null}

                  {message.correction.why.length > 0 ? (
                    <>
                      <p className="chat-rewrite-title">Why</p>
                      <ul className="chat-why-list">
                        {message.correction.why.map((item) => (
                          <li key={`${message.id}-${item}`}>{item}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}

                  {collectSaveCandidates(message).length > 0 ? (
                    <>
                      <p className="chat-rewrite-title">Save phrase</p>
                      <div className="chat-save-phrase-grid">
                        {collectSaveCandidates(message).map((phrase) => {
                          const phraseKey = buildSavedPhraseKey(message.id, phrase);
                          const isSaving = savingPhraseKey === phraseKey;
                          const isSaved = savedPhraseKeys.includes(phraseKey);

                          return (
                            <button
                              key={phraseKey}
                              type="button"
                              className={`chat-save-phrase${isSaved ? " saved" : ""}`}
                              onClick={() => {
                                void savePhrase({
                                  message,
                                  phrase
                                });
                              }}
                              disabled={isSaving || isSaved}
                            >
                              <strong>{isSaved ? "Saved" : isSaving ? "Saving..." : "Save"}</strong>{" "}
                              <span>{phrase}</span>
                            </button>
                          );
                        })}
                      </div>
                    </>
                  ) : null}
                </section>
              ) : null}
            </article>
          ))
        )}
      </div>

      <div className="chat-compose">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Write your turn here..."
          rows={3}
          disabled={isSending}
        />
        <button
          className="auth-button"
          type="button"
          onClick={submitTurn}
          disabled={isSending || !draft.trim()}
        >
          {isSending ? "Sending..." : "Send turn"}
        </button>
      </div>

      {statusMessage ? (
        <p className={`chat-status ${statusKind === "error" ? "error" : "ok"}`}>
          {statusMessage}
        </p>
      ) : null}
    </div>
  );
}
