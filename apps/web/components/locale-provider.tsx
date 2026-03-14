"use client";

import {
  createContext,
  startTransition,
  useContext,
  useEffect,
  useState,
  type ReactNode
} from "react";

export const LOCALE_STORAGE_KEY = "neontalk:locale:v1";

export type Locale = "uk" | "en";

type LocaleContextValue = {
  locale: Locale;
  setLocale: (value: Locale) => void;
};

const LocaleContext = createContext<LocaleContextValue | undefined>(undefined);

type LocaleProviderProps = {
  children: ReactNode;
};

function normalizeLocale(input: string | null): Locale {
  return input === "en" ? "en" : "uk";
}

export function LocaleProvider({ children }: LocaleProviderProps) {
  const [locale, setLocaleState] = useState<Locale>("uk");

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      const persisted = normalizeLocale(localStorage.getItem(LOCALE_STORAGE_KEY));
      setLocaleState(persisted);
      document.documentElement.lang = persisted;
    } catch {
      document.documentElement.lang = "uk";
    }
  }, []);

  function setLocale(value: Locale) {
    startTransition(() => {
      setLocaleState(value);
    });

    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, value);
    } catch {
      // Ignore storage write issues and keep in-memory locale.
    }

    if (typeof document !== "undefined") {
      document.documentElement.lang = value;
    }
  }

  return (
    <LocaleContext.Provider
      value={{
        locale,
        setLocale
      }}
    >
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  const context = useContext(LocaleContext);

  if (!context) {
    throw new Error("useLocale must be used inside <LocaleProvider>.");
  }

  return context;
}
