"use client";

import { useAuth } from "./auth-provider";

const envKeyMap: Record<string, string> = {
  apiKey: "NEXT_PUBLIC_FIREBASE_API_KEY",
  authDomain: "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  projectId: "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  appId: "NEXT_PUBLIC_FIREBASE_APP_ID"
};

export function AuthPanel() {
  const {
    user,
    isLoading,
    error,
    isConfigured,
    missingKeys,
    signInWithGoogle,
    signOutUser
  } = useAuth();

  if (!isConfigured) {
    return (
      <div className="auth-panel">
        <p className="auth-state warn">Firebase Auth is not configured yet.</p>
        <p className="auth-copy">
          Fill these variables in <code>apps/web/.env.local</code>:
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
        <p className="auth-state">Checking auth session...</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="auth-panel">
        <p className="auth-state">Sign in to unlock scenario sessions.</p>
        <button className="auth-button" type="button" onClick={signInWithGoogle}>
          Continue with Google
        </button>
        {error ? <p className="auth-error">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="auth-panel">
      <p className="auth-state ok">Signed in and ready for secured API calls.</p>
      <p className="auth-meta">
        <strong>User:</strong> {user.email ?? user.uid}
      </p>
      <p className="auth-meta">
        <strong>UID:</strong> {user.uid}
      </p>
      <button className="auth-button secondary" type="button" onClick={signOutUser}>
        Sign out
      </button>
      {error ? <p className="auth-error">{error}</p> : null}
    </div>
  );
}
