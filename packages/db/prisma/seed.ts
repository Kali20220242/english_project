import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";

const envFiles = [
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../../.env")
];

for (const envFile of envFiles) {
  if (existsSync(envFile)) {
    config({ path: envFile, override: false });
  }
}

const connectionString =
  process.env.DATABASE_URL ?? process.env.DIRECT_DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required to run the seed script.");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString })
});

const scenarios = [
  {
    id: "scenario_dating_confident_v1",
    slug: "dating_confident_v1",
    title: "Dating Chat - Confident Vibe",
    theme: "dating",
    difficulty: "B1" as const,
    description:
      "Practice modern dating conversation with natural confidence, playful tone, and smooth transitions.",
    systemPrompt:
      "You are a roleplay partner in a dating chat. Keep responses natural, concise, and emotionally intelligent for B1 learners."
  },
  {
    id: "scenario_travel_airport_v1",
    slug: "travel_airport_v1",
    title: "Travel - Airport and Hotel",
    theme: "travel",
    difficulty: "A2" as const,
    description:
      "Train practical travel English for airport check-in, immigration, and hotel communication.",
    systemPrompt:
      "You are a travel roleplay assistant. Simulate airport and hotel interactions with realistic but learner-friendly language."
  },
  {
    id: "scenario_work_standup_v1",
    slug: "work_standup_v1",
    title: "Work - Daily Standup",
    theme: "work",
    difficulty: "B2" as const,
    description:
      "Practice concise updates, blockers, and priorities in a professional team standup.",
    systemPrompt:
      "You are a teammate in a daily standup. Ask focused follow-up questions and model clear professional phrasing."
  },
  {
    id: "scenario_smalltalk_party_v1",
    slug: "smalltalk_party_v1",
    title: "Small Talk - Social Event",
    theme: "smalltalk",
    difficulty: "A2" as const,
    description:
      "Build comfort with opening conversations, asking simple follow-ups, and ending chats naturally.",
    systemPrompt:
      "You are a friendly person at a social event. Keep the tone warm and casual, helping learners practice natural small talk."
  },
  {
    id: "scenario_interview_backend_v1",
    slug: "interview_backend_v1",
    title: "Interview - Backend Engineer",
    theme: "interview",
    difficulty: "C1" as const,
    description:
      "Practice technical interview communication: architecture tradeoffs, debugging approach, and clear reasoning.",
    systemPrompt:
      "You are a technical interviewer. Ask realistic backend engineering questions and evaluate clarity, structure, and precision."
  }
];

async function main() {
  for (const scenario of scenarios) {
    await prisma.scenario.upsert({
      where: { id: scenario.id },
      create: {
        ...scenario,
        isActive: true
      },
      update: {
        slug: scenario.slug,
        title: scenario.title,
        theme: scenario.theme,
        difficulty: scenario.difficulty,
        description: scenario.description,
        systemPrompt: scenario.systemPrompt,
        isActive: true
      }
    });
  }

  const count = await prisma.scenario.count();
  console.log(`[seed] scenarios upserted, total scenarios: ${count}`);
}

main()
  .catch((error) => {
    console.error("[seed] failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
