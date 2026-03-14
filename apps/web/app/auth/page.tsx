"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AuthPanel } from "../../components/auth-panel";
import { useAuth } from "../../components/auth-provider";
import { useLocale } from "../../components/locale-provider";

export default function AuthPage() {
  const [popupMode, setPopupMode] = useState(false);
  const { user } = useAuth();
  const { locale } = useLocale();
  const isUkrainian = locale === "uk";

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    setPopupMode(params.get("popup") === "1");
  }, []);

  useEffect(() => {
    if (!popupMode || !user || typeof window === "undefined") {
      return;
    }

    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ type: "neontalk-auth-success" }, window.location.origin);
      window.close();
    }
  }, [popupMode, user]);

  return (
    <main className="page-shell">
      <section className="hero auth-hero">
        <div className="eyebrow">
          {isUkrainian ? "NeonTalk / Авторизація" : "NeonTalk / Authentication"}
        </div>
        <h1>{isUkrainian ? "Вхід до акаунта" : "Sign in to your account"}</h1>
        <p>
          {isUkrainian
            ? "Цей окремий ендпойнт /auth відповідає лише за авторизацію, щоб головний екран лишався чистим."
            : "This dedicated /auth endpoint handles authentication so the main screen stays focused on learning."}
        </p>
        <div className="auth-endpoint-card">
          <AuthPanel mode="auth-page" />
        </div>
        <div className="vault-hero-actions">
          <Link href="/" className="auth-button secondary">
            {isUkrainian ? "Повернутися на головну" : "Back to main page"}
          </Link>
        </div>
      </section>
    </main>
  );
}
