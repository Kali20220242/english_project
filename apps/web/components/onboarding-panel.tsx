"use client";

import { useEffect, useState } from "react";

import { useAuth } from "./auth-provider";
import { useLocale } from "./locale-provider";
import {
  DEFAULT_AI_MODEL,
  defaultOnboardingState,
  englishLevels,
  goalOptions,
  loadOnboardingStateFromStorage,
  type OnboardingState,
  personaStyles,
  saveOnboardingStateToStorage,
  suggestedAiModels
} from "../lib/onboarding-state";

export function OnboardingPanel() {
  const { user } = useAuth();
  const { locale } = useLocale();
  const isUkrainian = locale === "uk";
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
        setStatusMessage(
          isUkrainian
            ? "Попередні параметри онбордингу завантажено."
            : "Loaded your previous onboarding choices."
        );
      }
    } catch {
      setStatusKind("error");
      setStatusMessage(
        isUkrainian
          ? "Не вдалося прочитати локальні дані онбордингу."
          : "Could not read local onboarding data."
      );
    } finally {
      setIsHydrated(true);
    }
  }, [isUkrainian]);

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

  function updateAiModel(value: string) {
    setState((previous) => ({
      ...previous,
      aiModel: value.slice(0, 80)
    }));
  }

  function saveOnboarding() {
    if (state.goals.length === 0) {
      setStatusKind("error");
      setStatusMessage(
        isUkrainian ? "Обери хоча б одну навчальну ціль." : "Choose at least one goal."
      );
      return;
    }

    if (!state.nativeLanguage.trim()) {
      setStatusKind("error");
      setStatusMessage(
        isUkrainian ? "Вкажи рідну мову." : "Native language is required."
      );
      return;
    }

    if (!state.aiModel.trim()) {
      setStatusKind("error");
      setStatusMessage(isUkrainian ? "Вкажи AI-модель." : "AI model is required.");
      return;
    }

    try {
      saveOnboardingStateToStorage(state);

      setStatusKind("ok");
      setStatusMessage(
        isUkrainian
          ? "Онбординг збережено локально. Можна переходити до сценаріїв."
          : "Onboarding saved locally. You can continue to scenarios."
      );
    } catch {
      setStatusKind("error");
      setStatusMessage(
        isUkrainian
          ? "Не вдалося зберегти дані онбордингу."
          : "Could not save onboarding data."
      );
    }
  }

  if (!isHydrated) {
    return (
      <div className="onboarding-panel">
        <p className="onboarding-status">
          {isUkrainian
            ? "Завантажуємо параметри онбордингу..."
            : "Loading onboarding preferences..."}
        </p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="onboarding-panel">
        <p className="onboarding-status">
          {isUkrainian
            ? "Спочатку увійди в акаунт, щоб відкрити онбординг і створення сесій."
            : "Sign in first to unlock onboarding and session setup."}
        </p>
      </div>
    );
  }

  return (
    <div className="onboarding-panel">
      <p className="onboarding-copy">
        {isUkrainian
          ? "Налаштуй базові параметри, щоб тон рольової практики і стиль корекцій відповідали твоїм цілям."
          : "Set your baseline so the roleplay tone and correction style fit your learning goals."}
      </p>

      <div className="onboarding-grid">
        <label className="onboarding-field">
          <span>{isUkrainian ? "Рівень англійської" : "English level"}</span>
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
          <span>{isUkrainian ? "Стиль персонажа" : "Persona style"}</span>
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
                {isUkrainian
                  ? {
                      soft: "м'який",
                      confident: "впевнений",
                      playful: "грайливий",
                      professional: "професійний"
                    }[style]
                  : style}
              </option>
            ))}
          </select>
        </label>

        <label className="onboarding-field">
          <span>{isUkrainian ? "Рідна мова" : "Native language"}</span>
          <input
            type="text"
            value={state.nativeLanguage}
            onChange={(event) => updateNativeLanguage(event.target.value)}
            placeholder="uk"
          />
        </label>

        <label className="onboarding-field">
          <span>{isUkrainian ? "Часовий пояс" : "Timezone"}</span>
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

        <label className="onboarding-field">
          <span>{isUkrainian ? "AI-модель" : "AI model"}</span>
          <input
            type="text"
            list="onboarding-openai-models"
            value={state.aiModel}
            onChange={(event) => updateAiModel(event.target.value)}
            placeholder={DEFAULT_AI_MODEL}
          />
        </label>
      </div>

      <datalist id="onboarding-openai-models">
        {suggestedAiModels.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>

      <div className="goal-picker">
        <p>{isUkrainian ? "Навчальні цілі" : "Learning goals"}</p>
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
                {isUkrainian
                  ? {
                      dating: "Знайомства",
                      travel: "Подорожі",
                      work: "Робота",
                      smalltalk: "Small talk",
                      interview: "Співбесіда",
                      grammar: "Граматика і ясність"
                    }[goal.id] ?? goal.label
                  : goal.label}
              </button>
            );
          })}
        </div>
      </div>

      <button className="auth-button" type="button" onClick={saveOnboarding}>
        {isUkrainian ? "Зберегти онбординг" : "Save onboarding"}
      </button>

      {statusMessage ? (
        <p className={`onboarding-status ${statusKind === "error" ? "error" : "ok"}`}>
          {statusMessage}
        </p>
      ) : null}
    </div>
  );
}
