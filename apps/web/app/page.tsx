import { AuthPanel } from "../components/auth-panel";
import { FeatureCard } from "../components/feature-card";
import { OnboardingPanel } from "../components/onboarding-panel";
import { RoleplayChat } from "../components/roleplay-chat";
import { ScenarioPicker } from "../components/scenario-picker";

const features = [
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

export default function HomePage() {
  return (
    <main className="page-shell">
      <section className="hero">
        <div className="eyebrow">NeonTalk / English Roleplay Stack</div>
        <h1>Train real English, not textbook English.</h1>
        <p>
          This starter monorepo pairs a Firebase-hosted frontend with a dedicated API,
          worker, PostgreSQL, and Redis so we can build polished AI conversations without
          cutting corners on data integrity or deployment structure.
        </p>
        <div className="hero-grid">
          <article className="panel">
            <h2>Current foundation</h2>
            <ul className="meta-list">
              <li>Next.js web shell for Firebase App Hosting.</li>
              <li>Fastify API for session creation and turn intake.</li>
              <li>Worker lane for AI turn processing and progress jobs.</li>
              <li>Prisma schema for sessions, messages, phrases, and outbox events.</li>
            </ul>
          </article>
          <article className="panel secondary">
            <h2>Access control</h2>
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
          <h2>Onboarding</h2>
          <OnboardingPanel />
        </article>
      </section>

      <section className="scenario-shell">
        <article className="panel scenario-card-shell">
          <h2>Scenario Picker</h2>
          <ScenarioPicker />
        </article>
      </section>

      <section className="chat-shell">
        <article className="panel chat-card-shell">
          <h2>Roleplay Chat</h2>
          <RoleplayChat />
        </article>
      </section>
    </main>
  );
}
