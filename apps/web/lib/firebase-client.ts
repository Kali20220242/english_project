import { getApps, initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

const rawFirebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID
};

const requiredKeys = ["apiKey", "authDomain", "projectId", "appId"] as const;

export const missingFirebaseKeys = requiredKeys.filter(
  (key) => !rawFirebaseConfig[key]
);

export const hasRequiredFirebaseConfig = missingFirebaseKeys.length === 0;

const firebaseConfig = hasRequiredFirebaseConfig
  ? {
      apiKey: rawFirebaseConfig.apiKey as string,
      authDomain: rawFirebaseConfig.authDomain as string,
      projectId: rawFirebaseConfig.projectId as string,
      appId: rawFirebaseConfig.appId as string
    }
  : null;

const firebaseApp =
  firebaseConfig !== null
    ? (getApps()[0] ?? initializeApp(firebaseConfig))
    : null;

export const firebaseAuth = firebaseApp ? getAuth(firebaseApp) : null;

export const googleProvider = firebaseApp ? new GoogleAuthProvider() : null;
