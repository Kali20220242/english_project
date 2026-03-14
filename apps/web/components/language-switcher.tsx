"use client";

import { useLocale } from "./locale-provider";

export function LanguageSwitcher() {
  const { locale, setLocale } = useLocale();

  return (
    <div className="locale-switcher" aria-label="Language switcher">
      <button
        type="button"
        className={`locale-switcher-button${locale === "uk" ? " active" : ""}`}
        onClick={() => setLocale("uk")}
      >
        Українська
      </button>
      <button
        type="button"
        className={`locale-switcher-button${locale === "en" ? " active" : ""}`}
        onClick={() => setLocale("en")}
      >
        English
      </button>
    </div>
  );
}
