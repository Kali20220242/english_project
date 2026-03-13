import Link from "next/link";

import { PhraseVaultPanel } from "../../components/phrase-vault-panel";

export default function PhraseVaultPage() {
  return (
    <main className="page-shell">
      <section className="hero">
        <div className="eyebrow">NeonTalk / Phrase Vault</div>
        <h1>Phrase Vault</h1>
        <p>
          Save useful expressions from assistant corrections and keep them ready for
          next practice sessions.
        </p>
        <div className="vault-hero-actions">
          <Link href="/" className="auth-button secondary">
            Back to Roleplay
          </Link>
        </div>
      </section>

      <section className="vault-shell">
        <article className="panel vault-card-shell">
          <h2>Your Saved Phrases</h2>
          <PhraseVaultPanel />
        </article>
      </section>
    </main>
  );
}
