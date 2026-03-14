"use client";

import { useEffect, useState } from "react";

import { clearActiveSessionState } from "../lib/active-session-state";
import { buildApiHeaders } from "../lib/api-request";
import { useAuth } from "./auth-provider";
import { useLocale } from "./locale-provider";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

type ProgressResponse = {
  overview: {
    windowDays: number;
    generatedAt: string;
    source: string;
    streakDays: number;
    lastCapturedAt: string | null;
    scores: {
      fluencyScore: number;
      vocabularyScore: number;
      consistencyScore: number;
    };
    weakAreas: string[];
    activity: {
      sessions: number;
      userTurns: number;
      savedPhrases: number;
      activeDays: number;
    };
  };
  trend: Array<{
    capturedAt: string;
    fluencyScore: number;
    vocabularyScore: number;
    consistencyScore: number;
    streakDays: number;
  }>;
};

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

function formatShortDate(input: string) {
  const date = new Date(input);

  if (Number.isNaN(date.getTime())) {
    return "n/a";
  }

  return date.toLocaleDateString();
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function ProgressDashboard() {
  const { user, getIdToken } = useAuth();
  const { locale } = useLocale();
  const isUkrainian = locale === "uk";
  const [windowDays, setWindowDays] = useState(30);
  const [data, setData] = useState<ProgressResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [statusKind, setStatusKind] = useState<"idle" | "ok" | "error">("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  async function fetchProgress() {
    if (!user) {
      return;
    }

    const token = await getIdToken();

    if (!token) {
      setStatusKind("error");
      setStatusMessage(
        isUkrainian ? "Не вдалося отримати Firebase ID token." : "Could not get Firebase ID token."
      );
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/progress?windowDays=${windowDays}`,
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
          resolveApiError(
            payload,
            isUkrainian
              ? `Не вдалося завантажити прогрес (${response.status}).`
              : `Failed to load progress (${response.status}).`
          )
        );
      }

      const result = payload as ProgressResponse;
      setData(result);
      setStatusKind("ok");
      setStatusMessage(
        isUkrainian ? "Панель прогресу оновлено." : "Progress dashboard updated."
      );
    } catch (error) {
      setStatusKind("error");
      setStatusMessage(
        error instanceof Error
          ? error.message
          : isUkrainian
            ? "Не вдалося завантажити панель прогресу."
            : "Failed to load progress dashboard."
      );
    } finally {
      setIsLoading(false);
    }
  }

  async function resetProgress() {
    if (!user) {
      return;
    }

    if (
      typeof window !== "undefined" &&
      !window.confirm(
        isUkrainian
          ? "Скинути весь прогрес, сесії та збережені фрази?"
          : "Reset all progress, sessions, and saved phrases?"
      )
    ) {
      return;
    }

    const token = await getIdToken();

    if (!token) {
      setStatusKind("error");
      setStatusMessage(
        isUkrainian ? "Не вдалося отримати Firebase ID token." : "Could not get Firebase ID token."
      );
      return;
    }

    setIsResetting(true);

    try {
      const response = await fetch(`${apiBaseUrl}/v1/progress/reset`, {
        method: "DELETE",
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
          resolveApiError(
            payload,
            isUkrainian
              ? `Не вдалося скинути прогрес (${response.status}).`
              : `Failed to reset progress (${response.status}).`
          )
        );
      }

      clearActiveSessionState();
      setData(null);
      setStatusKind("ok");
      setStatusMessage(
        isUkrainian
          ? "Прогрес скинуто. Дані оновлено."
          : "Progress reset completed."
      );
      await fetchProgress();
    } catch (error) {
      setStatusKind("error");
      setStatusMessage(
        error instanceof Error
          ? error.message
          : isUkrainian
            ? "Не вдалося скинути прогрес."
            : "Failed to reset progress."
      );
    } finally {
      setIsResetting(false);
    }
  }

  useEffect(() => {
    if (!user) {
      setData(null);
      return;
    }

    void fetchProgress();
  }, [user, windowDays]);

  if (!user) {
    return (
      <div className="progress-panel">
        <p className="progress-status">
          {isUkrainian
            ? "Спочатку увійди в акаунт, щоб переглянути прогрес."
            : "Sign in first to view progress insights."}
        </p>
      </div>
    );
  }

  return (
    <div className="progress-panel">
      <div className="progress-controls">
        <label className="progress-field">
          <span>{isUkrainian ? "Період" : "Window"}</span>
          <select
            value={String(windowDays)}
            onChange={(event) => {
              setWindowDays(Number.parseInt(event.target.value, 10) || 30);
            }}
          >
            <option value="7">{isUkrainian ? "7 днів" : "7 days"}</option>
            <option value="30">{isUkrainian ? "30 днів" : "30 days"}</option>
            <option value="60">{isUkrainian ? "60 днів" : "60 days"}</option>
            <option value="90">{isUkrainian ? "90 днів" : "90 days"}</option>
          </select>
        </label>

        <button
          type="button"
          className="auth-button secondary"
          onClick={() => {
            void fetchProgress();
          }}
          disabled={isLoading}
        >
          {isLoading
            ? isUkrainian
              ? "Оновлюємо..."
              : "Refreshing..."
            : isUkrainian
              ? "Оновити прогрес"
              : "Refresh progress"}
        </button>

        <button
          type="button"
          className="auth-button secondary"
          onClick={() => {
            void resetProgress();
          }}
          disabled={isLoading || isResetting}
        >
          {isResetting
            ? isUkrainian
              ? "Скидання..."
              : "Resetting..."
            : isUkrainian
              ? "Скинути прогрес"
              : "Reset progress"}
        </button>
      </div>

      {statusMessage ? (
        <p className={`progress-status ${statusKind === "error" ? "error" : "ok"}`}>
          {statusMessage}
        </p>
      ) : null}

      {!data ? (
        <p className="progress-status">
          {isUkrainian ? "Завантаження даних прогресу..." : "Loading progress data..."}
        </p>
      ) : (
        <>
          <div className="progress-top-grid">
            <article className="progress-stat-card">
              <small>{isUkrainian ? "Поточний streak" : "Current streak"}</small>
              <strong>
                {data.overview.streakDays} {isUkrainian ? "дн." : "day(s)"}
              </strong>
              <p>
                {isUkrainian
                  ? "Розраховано за твоєю останньою активністю у розмовній практиці."
                  : "Based on your recent speaking activity."}
              </p>
            </article>

            <article className="progress-stat-card">
              <small>{isUkrainian ? "Активність" : "Activity"} ({data.overview.windowDays}d)</small>
              <strong>
                {data.overview.activity.userTurns} {isUkrainian ? "ходів" : "turns"} /{" "}
                {data.overview.activity.sessions} {isUkrainian ? "сесій" : "sessions"}
              </strong>
              <p>
                {data.overview.activity.savedPhrases}{" "}
                {isUkrainian ? "збережених фраз за" : "saved phrases across"}{" "}
                {data.overview.activity.activeDays} {isUkrainian ? "активних днів." : "active day(s)."}
              </p>
            </article>
          </div>

          <div className="progress-scores">
            {[
              {
                id: "fluency",
                label: isUkrainian ? "Плавність" : "Fluency",
                value: data.overview.scores.fluencyScore
              },
              {
                id: "vocabulary",
                label: isUkrainian ? "Словниковий запас" : "Vocabulary",
                value: data.overview.scores.vocabularyScore
              },
              {
                id: "consistency",
                label: isUkrainian ? "Стабільність" : "Consistency",
                value: data.overview.scores.consistencyScore
              }
            ].map((score) => (
              <article key={score.id} className="progress-score-card">
                <header>
                  <span>{score.label}</span>
                  <strong>{clampScore(score.value)}%</strong>
                </header>
                <div className="progress-meter" aria-hidden="true">
                  <span style={{ width: `${clampScore(score.value)}%` }} />
                </div>
              </article>
            ))}
          </div>

          <article className="progress-weak-card">
            <h3>{isUkrainian ? "Слабкі місця" : "Weak Areas"}</h3>
            <div className="progress-weak-list">
              {data.overview.weakAreas.length > 0 ? (
                data.overview.weakAreas.map((item) => (
                  <span key={item} className="progress-weak-chip">
                    {item}
                  </span>
                ))
              ) : (
                <p>{isUkrainian ? "Слабкі місця поки не виявлені." : "No weak areas detected yet."}</p>
              )}
            </div>
          </article>

          <article className="progress-trend-card">
            <h3>{isUkrainian ? "Останній тренд" : "Recent Trend"}</h3>
            {data.trend.length === 0 ? (
              <p>{isUkrainian ? "Поки немає історії снепшотів." : "No snapshot trend yet."}</p>
            ) : (
              <ul className="progress-trend-list">
                {data.trend.map((item) => (
                  <li key={`${item.capturedAt}-${item.streakDays}`}>
                    <span>{formatShortDate(item.capturedAt)}</span>
                    <span>
                      F:{clampScore(item.fluencyScore)} V:{clampScore(item.vocabularyScore)} C:
                      {clampScore(item.consistencyScore)}
                    </span>
                    <span>{isUkrainian ? "Streak" : "Streak"}: {item.streakDays}</span>
                  </li>
                ))}
              </ul>
            )}
          </article>
        </>
      )}
    </div>
  );
}
