"use client";

import { useEffect, useState } from "react";

import { useAuth } from "./auth-provider";

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
  const [windowDays, setWindowDays] = useState(30);
  const [data, setData] = useState<ProgressResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [statusKind, setStatusKind] = useState<"idle" | "ok" | "error">("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  async function fetchProgress() {
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
      const response = await fetch(
        `${apiBaseUrl}/v1/progress?windowDays=${windowDays}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`
          }
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
          resolveApiError(payload, `Failed to load progress (${response.status}).`)
        );
      }

      const result = payload as ProgressResponse;
      setData(result);
      setStatusKind("ok");
      setStatusMessage("Progress dashboard updated.");
    } catch (error) {
      setStatusKind("error");
      setStatusMessage(
        error instanceof Error ? error.message : "Failed to load progress dashboard."
      );
    } finally {
      setIsLoading(false);
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
        <p className="progress-status">Sign in first to view progress insights.</p>
      </div>
    );
  }

  return (
    <div className="progress-panel">
      <div className="progress-controls">
        <label className="progress-field">
          <span>Window</span>
          <select
            value={String(windowDays)}
            onChange={(event) => {
              setWindowDays(Number.parseInt(event.target.value, 10) || 30);
            }}
          >
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="60">60 days</option>
            <option value="90">90 days</option>
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
          {isLoading ? "Refreshing..." : "Refresh progress"}
        </button>
      </div>

      {statusMessage ? (
        <p className={`progress-status ${statusKind === "error" ? "error" : "ok"}`}>
          {statusMessage}
        </p>
      ) : null}

      {!data ? (
        <p className="progress-status">Loading progress data...</p>
      ) : (
        <>
          <div className="progress-top-grid">
            <article className="progress-stat-card">
              <small>Current streak</small>
              <strong>{data.overview.streakDays} day(s)</strong>
              <p>Based on your recent speaking activity.</p>
            </article>

            <article className="progress-stat-card">
              <small>Activity ({data.overview.windowDays}d)</small>
              <strong>
                {data.overview.activity.userTurns} turns / {data.overview.activity.sessions} sessions
              </strong>
              <p>
                {data.overview.activity.savedPhrases} saved phrases across{" "}
                {data.overview.activity.activeDays} active day(s).
              </p>
            </article>
          </div>

          <div className="progress-scores">
            {[
              { id: "fluency", label: "Fluency", value: data.overview.scores.fluencyScore },
              {
                id: "vocabulary",
                label: "Vocabulary",
                value: data.overview.scores.vocabularyScore
              },
              {
                id: "consistency",
                label: "Consistency",
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
            <h3>Weak Areas</h3>
            <div className="progress-weak-list">
              {data.overview.weakAreas.length > 0 ? (
                data.overview.weakAreas.map((item) => (
                  <span key={item} className="progress-weak-chip">
                    {item}
                  </span>
                ))
              ) : (
                <p>No weak areas detected yet.</p>
              )}
            </div>
          </article>

          <article className="progress-trend-card">
            <h3>Recent Trend</h3>
            {data.trend.length === 0 ? (
              <p>No snapshot trend yet.</p>
            ) : (
              <ul className="progress-trend-list">
                {data.trend.map((item) => (
                  <li key={`${item.capturedAt}-${item.streakDays}`}>
                    <span>{formatShortDate(item.capturedAt)}</span>
                    <span>
                      F:{clampScore(item.fluencyScore)} V:{clampScore(item.vocabularyScore)} C:
                      {clampScore(item.consistencyScore)}
                    </span>
                    <span>Streak: {item.streakDays}</span>
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
