"use client";

import { useEffect, useState } from "react";

import { useAuth } from "./auth-provider";
import {
  defaultOnboardingState,
  englishLevels,
  goalOptions,
  loadOnboardingStateFromStorage,
  type OnboardingState,
  personaStyles,
  saveOnboardingStateToStorage
} from "../lib/onboarding-state";

export function OnboardingPanel() {
  const { user } = useAuth();
  const [state, setState] = useState<OnboardingState>(defaultOnboardingState);
  const [isHydrated, setIsHydrated] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusKind, setStatusKind] = useState<"idle" | "ok" | "error">("idle");

  useEffect(() => {
    try {
      const onboardingState = loadOnboardingStateFromStorage();

      setState(onboardingState.state);

      if (onboardingState.loaded) {
        setStatusKind("ok");
        setStatusMessage("Loaded your previous onboarding choices.");
      }
    } catch {
      setStatusKind("error");
      setStatusMessage("Could not read local onboarding data.");
    } finally {
      setIsHydrated(true);
    }
  }, []);

  function toggleGoal(goalId: string) {
    setState((previous) => {
      const isActive = previous.goals.includes(goalId);
      const nextGoals = isActive
        ? previous.goals.filter((item) => item !== goalId)
        : [...previous.goals, goalId];

      return {
        ...previous,
        goals: nextGoals
      };
    });
  }

  function updateNativeLanguage(value: string) {
    setState((previous) => ({
      ...previous,
      nativeLanguage: value.slice(0, 10)
    }));
  }

  function saveOnboarding() {
    if (state.goals.length === 0) {
      setStatusKind("error");
      setStatusMessage("Choose at least one goal.");
      return;
    }

    if (!state.nativeLanguage.trim()) {
      setStatusKind("error");
      setStatusMessage("Native language is required.");
      return;
    }

    try {
      saveOnboardingStateToStorage(state);

      setStatusKind("ok");
      setStatusMessage("Onboarding saved locally. You can continue to scenarios.");
    } catch {
      setStatusKind("error");
      setStatusMessage("Could not save onboarding data.");
    }
  }

  if (!isHydrated) {
    return (
      <div className="onboarding-panel">
        <p className="onboarding-status">Loading onboarding preferences...</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="onboarding-panel">
        <p className="onboarding-status">
          Sign in first to unlock onboarding and session setup.
        </p>
      </div>
    );
  }

  return (
    <div className="onboarding-panel">
      <p className="onboarding-copy">
        Set your baseline so the roleplay tone and correction style fit your
        learning goals.
      </p>

      <div className="onboarding-grid">
        <label className="onboarding-field">
          <span>English level</span>
          <select
            value={state.level}
            onChange={(event) =>
              setState((previous) => ({
                ...previous,
                level: event.target.value as OnboardingState["level"]
              }))
            }
          >
            {englishLevels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>

        <label className="onboarding-field">
          <span>Persona style</span>
          <select
            value={state.personaStyle}
            onChange={(event) =>
              setState((previous) => ({
                ...previous,
                personaStyle: event.target.value as OnboardingState["personaStyle"]
              }))
            }
          >
            {personaStyles.map((style) => (
              <option key={style} value={style}>
                {style}
              </option>
            ))}
          </select>
        </label>

        <label className="onboarding-field">
          <span>Native language</span>
          <input
            type="text"
            value={state.nativeLanguage}
            onChange={(event) => updateNativeLanguage(event.target.value)}
            placeholder="uk"
          />
        </label>

        <label className="onboarding-field">
          <span>Timezone</span>
          <input
            type="text"
            value={state.timezone}
            onChange={(event) =>
              setState((previous) => ({
                ...previous,
                timezone: event.target.value.slice(0, 64)
              }))
            }
            placeholder="Europe/Kiev"
          />
        </label>
      </div>

      <div className="goal-picker">
        <p>Learning goals</p>
        <div className="goal-chips">
          {goalOptions.map((goal) => {
            const active = state.goals.includes(goal.id);

            return (
              <button
                key={goal.id}
                className={`goal-chip${active ? " active" : ""}`}
                type="button"
                onClick={() => toggleGoal(goal.id)}
              >
                {goal.label}
              </button>
            );
          })}
        </div>
      </div>

      <button className="auth-button" type="button" onClick={saveOnboarding}>
        Save onboarding
      </button>

      {statusMessage ? (
        <p className={`onboarding-status ${statusKind === "error" ? "error" : "ok"}`}>
          {statusMessage}
        </p>
      ) : null}
    </div>
  );
}
