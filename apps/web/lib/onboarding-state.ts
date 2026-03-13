export const ONBOARDING_STORAGE_KEY = "neontalk:onboarding:v1";

export const englishLevels = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
export const personaStyles = [
  "soft",
  "confident",
  "playful",
  "professional"
] as const;

export const goalOptions = [
  { id: "dating", label: "Dating chat" },
  { id: "travel", label: "Travel situations" },
  { id: "work", label: "Work communication" },
  { id: "smalltalk", label: "Small talk confidence" },
  { id: "interview", label: "Interview prep" },
  { id: "grammar", label: "Grammar and clarity" }
] as const;

export type OnboardingState = {
  level: (typeof englishLevels)[number];
  personaStyle: (typeof personaStyles)[number];
  goals: string[];
  nativeLanguage: string;
  timezone: string;
};

export const defaultOnboardingState: OnboardingState = {
  level: "B1",
  personaStyle: "confident",
  goals: ["smalltalk"],
  nativeLanguage: "uk",
  timezone: "Europe/Kiev"
};

export function getBrowserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Kiev";
  } catch {
    return "Europe/Kiev";
  }
}

function normalizeGoals(value: unknown) {
  if (!Array.isArray(value)) {
    return defaultOnboardingState.goals;
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const item of value) {
    const goal = String(item).trim().toLowerCase();

    if (!goal || seen.has(goal)) {
      continue;
    }

    seen.add(goal);
    normalized.push(goal);

    if (normalized.length >= 8) {
      break;
    }
  }

  return normalized.length > 0 ? normalized : defaultOnboardingState.goals;
}

export function normalizeOnboardingState(input: Partial<OnboardingState>) {
  const fallbackTimezone = getBrowserTimezone();

  return {
    level:
      typeof input.level === "string" &&
      englishLevels.includes(input.level as OnboardingState["level"])
        ? (input.level as OnboardingState["level"])
        : defaultOnboardingState.level,
    personaStyle:
      typeof input.personaStyle === "string" &&
      personaStyles.includes(input.personaStyle as OnboardingState["personaStyle"])
        ? (input.personaStyle as OnboardingState["personaStyle"])
        : defaultOnboardingState.personaStyle,
    goals: normalizeGoals(input.goals),
    nativeLanguage:
      typeof input.nativeLanguage === "string" && input.nativeLanguage.trim()
        ? input.nativeLanguage.trim().toLowerCase().slice(0, 10)
        : defaultOnboardingState.nativeLanguage,
    timezone:
      typeof input.timezone === "string" && input.timezone.trim()
        ? input.timezone.trim().slice(0, 64)
        : fallbackTimezone
  } satisfies OnboardingState;
}

export function loadOnboardingStateFromStorage() {
  if (typeof window === "undefined") {
    return {
      loaded: false,
      state: normalizeOnboardingState(defaultOnboardingState)
    };
  }

  try {
    const raw = localStorage.getItem(ONBOARDING_STORAGE_KEY);

    if (!raw) {
      return {
        loaded: false,
        state: normalizeOnboardingState(defaultOnboardingState)
      };
    }

    return {
      loaded: true,
      state: normalizeOnboardingState(
        JSON.parse(raw) as Partial<OnboardingState>
      )
    };
  } catch {
    return {
      loaded: false,
      state: normalizeOnboardingState(defaultOnboardingState)
    };
  }
}

export function saveOnboardingStateToStorage(state: OnboardingState) {
  if (typeof window === "undefined") {
    return;
  }

  localStorage.setItem(
    ONBOARDING_STORAGE_KEY,
    JSON.stringify(normalizeOnboardingState(state))
  );
}
