import type { OnboardingState } from "./onboarding-state";

type ScenarioCatalogItem = {
  id: string;
  slug: string;
  title: string;
  theme: string;
  difficulty: OnboardingState["level"];
  description: string;
  mood: string;
};

export const scenarioCatalog: ScenarioCatalogItem[] = [
  {
    id: "scenario_dating_confident_v1",
    slug: "dating_confident_v1",
    title: "Dating Chat - Confident Vibe",
    theme: "dating",
    difficulty: "B1",
    mood: "Flirty, natural, emotionally smart",
    description:
      "Practice playful dating dialogue, openers, transitions, and confidence without sounding scripted."
  },
  {
    id: "scenario_travel_airport_v1",
    slug: "travel_airport_v1",
    title: "Travel - Airport and Hotel",
    theme: "travel",
    difficulty: "A2",
    mood: "Practical, polite, fast responses",
    description:
      "Train real travel English for check-in, immigration, transport, and hotel requests."
  },
  {
    id: "scenario_work_standup_v1",
    slug: "work_standup_v1",
    title: "Work - Daily Standup",
    theme: "work",
    difficulty: "B2",
    mood: "Clear, concise, professional",
    description:
      "Practice updates, blockers, priorities, and follow-up questions for team standups."
  },
  {
    id: "scenario_smalltalk_party_v1",
    slug: "smalltalk_party_v1",
    title: "Small Talk - Social Event",
    theme: "smalltalk",
    difficulty: "A2",
    mood: "Friendly, easy-going, natural exits",
    description:
      "Build comfort with opening conversation, keeping it flowing, and ending politely."
  },
  {
    id: "scenario_interview_backend_v1",
    slug: "interview_backend_v1",
    title: "Interview - Backend Engineer",
    theme: "interview",
    difficulty: "C1",
    mood: "Structured, technical, precise",
    description:
      "Practice interview answers around architecture tradeoffs, debugging, and technical storytelling."
  }
];
