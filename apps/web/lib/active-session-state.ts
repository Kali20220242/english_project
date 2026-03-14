export const ACTIVE_SESSION_STORAGE_KEY = "neontalk:active-session:v1";

export type ActiveSessionState = {
  sessionId: string;
  state: string;
  startedAt: string;
  scenario: {
    id: string;
    slug: string;
    title: string;
  };
  onboarding?: {
    level: string;
    personaStyle: string;
    nativeLanguage: string;
    timezone: string;
    aiModel?: string;
  };
};

export function loadActiveSessionState() {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<ActiveSessionState>;

    if (
      typeof parsed.sessionId !== "string" ||
      typeof parsed.state !== "string" ||
      typeof parsed.startedAt !== "string" ||
      !parsed.scenario ||
      typeof parsed.scenario.id !== "string" ||
      typeof parsed.scenario.slug !== "string" ||
      typeof parsed.scenario.title !== "string"
    ) {
      return null;
    }

    return {
      sessionId: parsed.sessionId,
      state: parsed.state,
      startedAt: parsed.startedAt,
      scenario: parsed.scenario,
      onboarding: parsed.onboarding
    } satisfies ActiveSessionState;
  } catch {
    return null;
  }
}

export function saveActiveSessionState(input: ActiveSessionState) {
  if (typeof window === "undefined") {
    return;
  }

  localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, JSON.stringify(input));
}

export function clearActiveSessionState() {
  if (typeof window === "undefined") {
    return;
  }

  localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
}
