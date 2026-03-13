import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

const hasServiceAccountCredentials = Boolean(
  projectId && clientEmail && privateKey
);

const canUseApplicationDefaultCredentials = Boolean(projectId);

export const isFirebaseAdminConfigured =
  hasServiceAccountCredentials || canUseApplicationDefaultCredentials;

const firebaseAdminApp = isFirebaseAdminConfigured
  ? getApps()[0] ??
    initializeApp(
      hasServiceAccountCredentials
        ? {
            credential: cert({
              projectId: projectId as string,
              clientEmail: clientEmail as string,
              privateKey: privateKey as string
            }),
            projectId
          }
        : {
            credential: applicationDefault(),
            projectId
          }
    )
  : null;

export const firebaseAdminAuth = firebaseAdminApp
  ? getAuth(firebaseAdminApp)
  : null;
