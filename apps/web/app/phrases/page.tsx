"use client";

import Link from "next/link";

import { useLocale } from "../../components/locale-provider";
import { PhraseVaultPanel } from "../../components/phrase-vault-panel";

export default function PhraseVaultPage() {
  const { locale } = useLocale();
  const isUkrainian = locale === "uk";

  return (
    <main className="page-shell">
      <section className="hero">
        <div className="eyebrow">
          {isUkrainian ? "NeonTalk / Сховище фраз" : "NeonTalk / Phrase Vault"}
        </div>
        <h1>{isUkrainian ? "Сховище фраз" : "Phrase Vault"}</h1>
        <p>
          {isUkrainian
            ? "Зберігай корисні вирази з корекцій асистента, щоб мати їх під рукою для наступних практик."
            : "Save useful expressions from assistant corrections and keep them ready for next practice sessions."}
        </p>
        <div className="vault-hero-actions">
          <Link href="/" className="auth-button secondary">
            {isUkrainian ? "Назад до рольової практики" : "Back to Roleplay"}
          </Link>
        </div>
      </section>

      <section className="vault-shell">
        <article className="panel vault-card-shell">
          <h2>{isUkrainian ? "Твої збережені фрази" : "Your Saved Phrases"}</h2>
          <PhraseVaultPanel />
        </article>
      </section>
    </main>
  );
}
