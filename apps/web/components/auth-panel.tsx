"use client";

import Link from "next/link";

import { useLocale } from "./locale-provider";
import { useAuth } from "./auth-provider";

const envKeyMap: Record<string, string> = {
  apiKey: "NEXT_PUBLIC_FIREBASE_API_KEY",
  authDomain: "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  projectId: "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  appId: "NEXT_PUBLIC_FIREBASE_APP_ID"
};

type AuthPanelProps = {
  mode?: "dashboard" | "auth-page";
};

export function AuthPanel({ mode = "dashboard" }: AuthPanelProps) {
  const {
    user,
    isLoading,
    error,
    isConfigured,
    missingKeys,
    signInWithGoogle,
    signOutUser
  } = useAuth();
  const { locale } = useLocale();
  const isUkrainian = locale === "uk";

  function openAuthWindow() {
    if (typeof window === "undefined") {
      return;
    }

    const width = 520;
    const height = 760;
    const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
    const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));
    const targetUrl = new URL("/auth?popup=1", window.location.origin);

    const popup = window.open(
      targetUrl.toString(),
      "neontalk-auth",
      `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable,scrollbars`
    );

    popup?.focus();
  }

  if (!isConfigured) {
    return (
      <div className="auth-panel">
        <p className="auth-state warn">
          {isUkrainian
            ? "Firebase Auth ще не налаштовано."
            : "Firebase Auth is not configured yet."}
        </p>
        <p className="auth-copy">
          {isUkrainian ? "Заповни ці змінні в " : "Fill these variables in "}
          <code>apps/web/.env.local</code>:
        </p>
        <ul className="auth-config-list">
          {missingKeys.map((key) => (
            <li key={key}>{envKeyMap[key] ?? key}</li>
          ))}
        </ul>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="auth-panel">
        <p className="auth-state">
          {isUkrainian ? "Перевіряємо сесію авторизації..." : "Checking auth session..."}
        </p>
      </div>
    );
  }

  if (!user) {
    if (mode === "auth-page") {
      return (
        <div className="auth-panel">
          <p className="auth-state">
            {isUkrainian
              ? "Увійди через Google, щоб активувати сценарії та API."
              : "Sign in with Google to unlock scenarios and secured API calls."}
          </p>
          <button className="auth-button" type="button" onClick={signInWithGoogle}>
            {isUkrainian ? "Увійти через Google" : "Continue with Google"}
          </button>
          <p className="auth-copy">
            {isUkrainian
              ? "Ендпойнт авторизації: /auth"
              : "Authentication endpoint: /auth"}
          </p>
          {error ? <p className="auth-error">{error}</p> : null}
        </div>
      );
    }

    return (
      <div className="auth-panel">
        <p className="auth-state">
          {isUkrainian
            ? "Авторизація винесена в окреме вікно /auth."
            : "Authentication is handled in a dedicated /auth window."}
        </p>
        <button className="auth-button" type="button" onClick={openAuthWindow}>
          {isUkrainian ? "Відкрити вікно авторизації" : "Open auth window"}
        </button>
        <Link href="/auth" className="auth-link-inline">
          {isUkrainian
            ? "Або відкрити /auth в цій вкладці"
            : "Or open /auth in this tab"}
        </Link>
        {error ? <p className="auth-error">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="auth-panel">
      <p className="auth-state ok">
        {isUkrainian
          ? "Вхід виконано. Захищені API-виклики доступні."
          : "Signed in and ready for secured API calls."}
      </p>
      <p className="auth-meta">
        <strong>{isUkrainian ? "Користувач:" : "User:"}</strong> {user.email ?? user.uid}
      </p>
      <p className="auth-meta">
        <strong>UID:</strong> {user.uid}
      </p>
      <button className="auth-button secondary" type="button" onClick={signOutUser}>
        {isUkrainian ? "Вийти" : "Sign out"}
      </button>
      {mode === "dashboard" ? (
        <Link href="/auth" className="auth-link-inline">
          {isUkrainian ? "Керування входом: /auth" : "Manage login: /auth"}
        </Link>
      ) : null}
      {error ? <p className="auth-error">{error}</p> : null}
    </div>
  );
}
