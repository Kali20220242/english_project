"use client";

import { useDeferredValue, useEffect, useState } from "react";

import { loadActiveSessionState } from "../lib/active-session-state";
import { buildApiHeaders } from "../lib/api-request";
import { useAuth } from "./auth-provider";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

type PhraseVaultItem = {
  id: string;
  phrase: string;
  context: string | null;
  mastery: number;
  nextReviewAt: string | null;
  sourceMessageId: string | null;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
  session: {
    id: string;
    scenario: {
      id: string;
      slug: string;
      title: string;
    };
  } | null;
};

type PhraseVaultResponse = {
  items: PhraseVaultItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

function formatDateTime(input: string | null) {
  if (!input) {
    return "n/a";
  }

  const date = new Date(input);

  if (Number.isNaN(date.getTime())) {
    return "n/a";
  }

  return date.toLocaleString();
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

export function PhraseVaultPanel() {
  const { user, getIdToken } = useAuth();
  const [items, setItems] = useState<PhraseVaultItem[]>([]);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [sort, setSort] = useState<"recent" | "mastery">("recent");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionOnly, setSessionOnly] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [statusKind, setStatusKind] = useState<"idle" | "ok" | "error">("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    const activeSession = loadActiveSessionState();
    setActiveSessionId(activeSession?.sessionId ?? null);
  }, []);

  async function fetchPhrases(nextPage: number) {
    if (!user) {
      return;
    }

    const token = await getIdToken();

    if (!token) {
      setStatusKind("error");
      setStatusMessage("Could not get Firebase ID token.");
      return;
    }

    setIsLoading(true);

    try {
      const params = new URLSearchParams({
        page: String(nextPage),
        limit: "24",
        sort
      });

      if (deferredQuery.trim()) {
        params.set("q", deferredQuery.trim());
      }

      if (sessionOnly && activeSessionId) {
        params.set("sessionId", activeSessionId);
      }

      const response = await fetch(`${apiBaseUrl}/v1/phrases?${params.toString()}`, {
        method: "GET",
        headers: buildApiHeaders({
          token
        })
      });

      let payload: unknown = null;

      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok) {
        throw new Error(
          resolveApiError(payload, `Failed to load phrase vault (${response.status}).`)
        );
      }

      const result = payload as PhraseVaultResponse;
      setItems(result.items);
      setPage(result.pagination.page);
      setTotalPages(result.pagination.totalPages);
      setStatusKind("ok");
      setStatusMessage(`Loaded ${result.items.length} phrase(s).`);
    } catch (error) {
      setStatusKind("error");
      setStatusMessage(
        error instanceof Error ? error.message : "Failed to load phrase vault."
      );
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    if (!user) {
      setItems([]);
      return;
    }

    void fetchPhrases(1);
  }, [user, deferredQuery, sort, sessionOnly, activeSessionId]);

  if (!user) {
    return (
      <div className="vault-panel">
        <p className="vault-status">Sign in first to view your Phrase Vault.</p>
      </div>
    );
  }

  const canFilterBySession = Boolean(activeSessionId);

  return (
    <div className="vault-panel">
      <div className="vault-controls">
        <label className="vault-field">
          <span>Search phrase</span>
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="smooth way to say..."
          />
        </label>

        <label className="vault-field">
          <span>Sort</span>
          <select
            value={sort}
            onChange={(event) =>
              setSort(event.target.value === "mastery" ? "mastery" : "recent")
            }
          >
            <option value="recent">Most recent</option>
            <option value="mastery">Highest mastery</option>
          </select>
        </label>

        <button
          type="button"
          className={`auth-button secondary ${sessionOnly ? "vault-filter-active" : ""}`}
          onClick={() => setSessionOnly((previous) => !previous)}
          disabled={!canFilterBySession}
        >
          {sessionOnly ? "Session filter: on" : "Session filter: off"}
        </button>
      </div>

      {statusMessage ? (
        <p className={`vault-status ${statusKind === "error" ? "error" : "ok"}`}>
          {statusMessage}
        </p>
      ) : null}

      <div className="vault-list">
        {isLoading && items.length === 0 ? (
          <p className="vault-empty">Loading phrase vault...</p>
        ) : items.length === 0 ? (
          <p className="vault-empty">
            No saved phrases yet. Save phrases from assistant replies in roleplay chat.
          </p>
        ) : (
          items.map((item) => (
            <article key={item.id} className="vault-item">
              <header>
                <h3>{item.phrase}</h3>
                <small>Mastery: {item.mastery}</small>
              </header>

              {item.context ? <p>{item.context}</p> : null}

              <div className="vault-meta">
                <span>Saved: {formatDateTime(item.createdAt)}</span>
                <span>Next review: {formatDateTime(item.nextReviewAt)}</span>
                {item.session?.scenario ? (
                  <span>Scenario: {item.session.scenario.title}</span>
                ) : null}
              </div>
            </article>
          ))
        )}
      </div>

      <div className="vault-pagination">
        <button
          type="button"
          className="auth-button secondary"
          onClick={() => {
            void fetchPhrases(page - 1);
          }}
          disabled={isLoading || page <= 1}
        >
          Previous
        </button>

        <p>
          Page {page} / {totalPages}
        </p>

        <button
          type="button"
          className="auth-button secondary"
          onClick={() => {
            void fetchPhrases(page + 1);
          }}
          disabled={isLoading || page >= totalPages}
        >
          Next
        </button>
      </div>
    </div>
  );
}
