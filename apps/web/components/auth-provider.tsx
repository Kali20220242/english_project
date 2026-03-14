"use client";

import { startTransition, createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

import {
  getRedirectResult,
  onIdTokenChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User
} from "firebase/auth";

import {
  firebaseAuth,
  googleProvider,
  hasRequiredFirebaseConfig,
  missingFirebaseKeys
} from "../lib/firebase-client";

type AuthContextValue = {
  user: User | null;
  isLoading: boolean;
  error: string | null;
  isConfigured: boolean;
  missingKeys: string[];
  signInWithGoogle: () => Promise<void>;
  signOutUser: () => Promise<void>;
  getIdToken: () => Promise<string | null>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

type AuthProviderProps = {
  children: ReactNode;
};

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!firebaseAuth) {
      setIsLoading(false);
      return;
    }

    void getRedirectResult(firebaseAuth).catch((redirectError) => {
      const message =
        redirectError instanceof Error
          ? redirectError.message
          : "Failed to complete redirect sign in.";
      startTransition(() => {
        setError(message);
      });
    });

    const unsubscribe = onIdTokenChanged(
      firebaseAuth,
      (nextUser) => {
        startTransition(() => {
          setUser(nextUser);
          setIsLoading(false);
        });
      },
      (authError) => {
        startTransition(() => {
          setError(authError.message);
          setIsLoading(false);
        });
      }
    );

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!firebaseAuth || typeof window === "undefined") {
      return;
    }

    const auth = firebaseAuth;

    function handleAuthWindowMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) {
        return;
      }

      if (
        event.data &&
        typeof event.data === "object" &&
        (event.data as { type?: unknown }).type === "neontalk-auth-success"
      ) {
        startTransition(() => {
          setUser(auth.currentUser);
          setError(null);
          setIsLoading(false);
        });
      }
    }

    window.addEventListener("message", handleAuthWindowMessage);

    return () => {
      window.removeEventListener("message", handleAuthWindowMessage);
    };
  }, []);

  async function signInWithGoogle() {
    if (!firebaseAuth || !googleProvider) {
      setError("Firebase Auth is not configured in environment variables.");
      return;
    }

    try {
      setError(null);
      await signInWithPopup(firebaseAuth, googleProvider);
    } catch (authError) {
      const errorCode =
        authError && typeof authError === "object" && "code" in authError
          ? String((authError as { code?: unknown }).code ?? "")
          : "";

      if (
        errorCode === "auth/internal-error" ||
        errorCode === "auth/popup-blocked"
      ) {
        try {
          await signInWithRedirect(firebaseAuth, googleProvider);
          return;
        } catch (redirectError) {
          const message =
            redirectError instanceof Error
              ? redirectError.message
              : "Failed to start redirect sign in.";
          setError(message);
          return;
        }
      }

      const message =
        authError instanceof Error ? authError.message : "Failed to sign in.";
      setError(message);
    }
  }

  async function signOutUser() {
    if (!firebaseAuth) {
      return;
    }

    try {
      setError(null);
      await signOut(firebaseAuth);
    } catch (authError) {
      const message =
        authError instanceof Error ? authError.message : "Failed to sign out.";
      setError(message);
    }
  }

  async function getIdToken() {
    if (!user) {
      return null;
    }

    return user.getIdToken();
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        error,
        isConfigured: hasRequiredFirebaseConfig,
        missingKeys: missingFirebaseKeys,
        signInWithGoogle,
        signOutUser,
        getIdToken
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error("useAuth must be used inside <AuthProvider>.");
  }

  return context;
}
