"use client";

import { useDeferredValue, useEffect, useState } from "react";

import { scenarioCatalog } from "../lib/scenario-catalog";
import { saveActiveSessionState } from "../lib/active-session-state";
import {
  loadOnboardingStateFromStorage,
  type OnboardingState
} from "../lib/onboarding-state";
import { useAuth } from "./auth-provider";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

type CreateSessionResponse = {
  sessionId: string;
  state: string;
  scenario: {
    id: string;
    slug: string;
    title: string;
  };
  startedAt: string;
  onboarding: {
    level: string;
    personaStyle: string;
    nativeLanguage: string;
    timezone: string;
  };
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

function formatGoals(goals: string[]) {
  return goals.map((goal) => goal.replace(/_/g, " ")).join(", ");
}

export function ScenarioPicker() {
  const { user, getIdToken } = useAuth();
  const [selectedScenarioSlug, setSelectedScenarioSlug] = useState(
    scenarioCatalog[0]?.slug ?? ""
  );
  const deferredSelectedScenarioSlug = useDeferredValue(selectedScenarioSlug);
  const [onboardingSnapshot, setOnboardingSnapshot] = useState<OnboardingState | null>(
    null
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusKind, setStatusKind] = useState<"idle" | "ok" | "error">("idle");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const selectedScenario =
    scenarioCatalog.find((item) => item.slug === deferredSelectedScenarioSlug) ??
    scenarioCatalog[0] ??
    null;

  function refreshOnboardingSnapshot() {
    const onboarding = loadOnboardingStateFromStorage();
    setOnboardingSnapshot(onboarding.state);
  }

  useEffect(() => {
    refreshOnboardingSnapshot();
  }, []);

  async function createSession() {
    if (!selectedScenario) {
      setStatusKind("error");
      setStatusMessage("Pick a scenario first.");
      return;
    }

    if (!user) {
      setStatusKind("error");
      setStatusMessage("Sign in first to start a scenario session.");
      return;
    }

    const token = await getIdToken();

    if (!token) {
      setStatusKind("error");
      setStatusMessage("Could not get Firebase ID token.");
      return;
    }

    const onboarding = loadOnboardingStateFromStorage().state;
    setOnboardingSnapshot(onboarding);

    if (onboarding.goals.length === 0) {
      setStatusKind("error");
      setStatusMessage("Save onboarding with at least one learning goal.");
      return;
    }

    setIsSubmitting(true);
    setStatusKind("idle");
    setStatusMessage("Creating session...");

    try {
      const response = await fetch(`${apiBaseUrl}/v1/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          scenarioId: selectedScenario.slug,
          level: onboarding.level,
          personaStyle: onboarding.personaStyle,
          nativeLanguage: onboarding.nativeLanguage,
          timezone: onboarding.timezone
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
          resolveApiError(payload, `Session create failed (${response.status}).`)
        );
        return;
      }

      const result = payload as CreateSessionResponse;
      setActiveSessionId(result.sessionId);
      saveActiveSessionState({
          sessionId: result.sessionId,
          state: result.state,
          startedAt: result.startedAt,
          scenario: result.scenario,
          onboarding: result.onboarding
        });
      setStatusKind("ok");
      setStatusMessage(
        `Session ${result.sessionId} started for ${result.scenario.title}.`
      );
    } catch (error) {
      setStatusKind("error");
      setStatusMessage(
        error instanceof Error
          ? error.message
          : "Network error while creating session."
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!user) {
    return (
      <div className="scenario-picker">
        <p className="scenario-status">
          Sign in first, then choose a scenario to start a session.
        </p>
      </div>
    );
  }

  return (
    <div className="scenario-picker">
      <p className="scenario-copy">
        Pick a live scenario. We will create a new session using your onboarding
        settings.
      </p>

      <div className="scenario-grid">
        {scenarioCatalog.map((scenario) => (
          <button
            key={scenario.id}
            type="button"
            className={`scenario-card${
              selectedScenario?.slug === scenario.slug ? " active" : ""
            }`}
            onClick={() => setSelectedScenarioSlug(scenario.slug)}
          >
            <span>{scenario.theme}</span>
            <h3>{scenario.title}</h3>
            <p>{scenario.description}</p>
            <div className="scenario-meta">
              <small>Difficulty: {scenario.difficulty}</small>
              <small>{scenario.mood}</small>
            </div>
          </button>
        ))}
      </div>

      {onboardingSnapshot ? (
        <div className="scenario-onboarding">
          <p>
            <strong>Onboarding snapshot:</strong> {onboardingSnapshot.level},{" "}
            {onboardingSnapshot.personaStyle}, {onboardingSnapshot.nativeLanguage},{" "}
            {onboardingSnapshot.timezone}
          </p>
          <p>
            <strong>Goals:</strong> {formatGoals(onboardingSnapshot.goals)}
          </p>
          <button className="auth-button secondary" type="button" onClick={refreshOnboardingSnapshot}>
            Refresh onboarding data
          </button>
        </div>
      ) : null}

      <button
        className="auth-button"
        type="button"
        onClick={createSession}
        disabled={isSubmitting || !selectedScenario}
      >
        {isSubmitting ? "Starting session..." : "Start scenario session"}
      </button>

      {statusMessage ? (
        <p className={`scenario-status ${statusKind === "error" ? "error" : "ok"}`}>
          {statusMessage}
        </p>
      ) : null}

      {activeSessionId ? (
        <p className="scenario-session">
          Active session id: <code>{activeSessionId}</code>
        </p>
      ) : null}
    </div>
  );
}
