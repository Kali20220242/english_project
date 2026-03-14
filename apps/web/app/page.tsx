"use client";

import Link from "next/link";

import { AuthPanel } from "../components/auth-panel";
import { FeatureCard } from "../components/feature-card";
import { useLocale } from "../components/locale-provider";
import { OnboardingPanel } from "../components/onboarding-panel";
import { ProgressDashboard } from "../components/progress-dashboard";
import { RoleplayChat } from "../components/roleplay-chat";
import { ScenarioPicker } from "../components/scenario-picker";

export default function HomePage() {
  const { locale } = useLocale();
  const isUkrainian = locale === "uk";
  const features = isUkrainian
    ? [
        {
          eyebrow: "Рольова практика",
          title: "Живі сцени замість нудних вправ",
          body: "Перемикайся між знайомствами, подорожами, роботою і small talk, а відповіді підлаштовуються під твій рівень впевненості."
        },
        {
          eyebrow: "Корекції",
          title: "Природні перефразування з контекстом",
          body: "Кожна репліка дає більш природний варіант, коротке пояснення і готові фрази без зламу розмовного потоку."
        },
        {
          eyebrow: "Прогрес",
          title: "Слідкуй за слабкими місцями",
          body: "Снепшоти фіксують fluency, vocabulary, consistency і збережені фрази, щоб перетворювати помилки в повторення."
        }
      ]
    : [
        {
          eyebrow: "Roleplay",
          title: "Live scenes instead of boring drills",
          body: "Switch between dating, travel, work, and small-talk scenarios with responses tuned to the learner's confidence level."
        },
        {
          eyebrow: "Corrections",
          title: "Natural rewrites with context",
          body: "Every turn can produce a cleaner native-like version, short explanations, and reusable phrases without breaking flow."
        },
        {
          eyebrow: "Progress",
          title: "Track weak spots that matter",
          body: "Snapshots capture fluency, vocabulary, consistency, and saved phrases so the product can turn mistakes into review loops."
        }
      ];

  return (
    <main className="page-shell">
      <section className="hero">
        <div className="eyebrow">
          {isUkrainian ? "NeonTalk / Рольова англійська" : "NeonTalk / English Roleplay Stack"}
        </div>
        <h1>
          {isUkrainian
            ? "Вчи живу англійську, а не підручникову."
            : "Train real English, not textbook English."}
        </h1>
        <p>
          {isUkrainian
            ? "Цей starter-монорепо поєднує фронтенд на Firebase з окремими API, воркером, PostgreSQL і Redis, щоб будувати якісні AI-діалоги без компромісів у цілісності даних і деплої."
            : "This starter monorepo pairs a Firebase-hosted frontend with a dedicated API, worker, PostgreSQL, and Redis so we can build polished AI conversations without cutting corners on data integrity or deployment structure."}
        </p>
        <div className="hero-grid">
          <article className="panel">
            <h2>{isUkrainian ? "Поточна база" : "Current foundation"}</h2>
            <ul className="meta-list">
              <li>
                {isUkrainian
                  ? "Next.js веб-оболонка для Firebase App Hosting."
                  : "Next.js web shell for Firebase App Hosting."}
              </li>
              <li>
                {isUkrainian
                  ? "Fastify API для створення сесій і прийому реплік."
                  : "Fastify API for session creation and turn intake."}
              </li>
              <li>
                {isUkrainian
                  ? "Окремий воркер для AI-обробки ходів і задач прогресу."
                  : "Worker lane for AI turn processing and progress jobs."}
              </li>
              <li>
                {isUkrainian
                  ? "Prisma-схема для сесій, повідомлень, фраз і outbox-подій."
                  : "Prisma schema for sessions, messages, phrases, and outbox events."}
              </li>
            </ul>
          </article>
          <article className="panel secondary">
            <h2>{isUkrainian ? "Контроль доступу" : "Access control"}</h2>
            <AuthPanel />
          </article>
        </div>
      </section>

      <section className="feature-grid">
        {features.map((feature) => (
          <FeatureCard key={feature.title} {...feature} />
        ))}
      </section>

      <section className="onboarding-shell">
        <article className="panel onboarding-card">
          <h2>{isUkrainian ? "Онбординг" : "Onboarding"}</h2>
          <OnboardingPanel />
        </article>
      </section>

      <section className="scenario-shell">
        <article className="panel scenario-card-shell">
          <h2>{isUkrainian ? "Вибір сценарію" : "Scenario Picker"}</h2>
          <ScenarioPicker />
        </article>
      </section>

      <section className="chat-shell">
        <article className="panel chat-card-shell">
          <h2>{isUkrainian ? "Рольовий чат" : "Roleplay Chat"}</h2>
          <RoleplayChat />
          <div className="chat-actions">
            <Link href="/phrases" className="auth-button secondary">
              {isUkrainian ? "Відкрити Phrase Vault" : "Open Phrase Vault"}
            </Link>
          </div>
        </article>
      </section>

      <section className="progress-shell">
        <article className="panel progress-card-shell">
          <h2>{isUkrainian ? "Панель прогресу" : "Progress Dashboard"}</h2>
          <ProgressDashboard />
        </article>
      </section>
    </main>
  );
}
