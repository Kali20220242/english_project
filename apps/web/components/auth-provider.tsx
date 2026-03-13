"use client";

import { startTransition, createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { onIdTokenChanged, signInWithPopup, signOut, type User } from "firebase/auth";

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

  async function signInWithGoogle() {
    if (!firebaseAuth || !googleProvider) {
      setError("Firebase Auth is not configured in environment variables.");
      return;
    }

    try {
      setError(null);
      await signInWithPopup(firebaseAuth, googleProvider);
    } catch (authError) {
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
