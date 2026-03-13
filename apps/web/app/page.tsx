import { FeatureCard } from "../components/feature-card";

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
            <h2>Next implementation steps</h2>
            <ul className="meta-list">
              <li>Attach Firebase Auth and session guards.</li>
              <li>Persist roleplay turns with idempotency and audit logging.</li>
              <li>Move AI responses through a strict JSON anti-corruption layer.</li>
              <li>Ship staged deploys through GitHub and Firebase App Hosting.</li>
            </ul>
          </article>
        </div>
      </section>

      <section className="feature-grid">
        {features.map((feature) => (
          <FeatureCard key={feature.title} {...feature} />
        ))}
      </section>
    </main>
  );
}
