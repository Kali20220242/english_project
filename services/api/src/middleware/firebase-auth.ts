import type { DecodedIdToken } from "firebase-admin/auth";
import type { User } from "@prisma/client";
import type { FastifyReply, FastifyRequest } from "fastify";

import { AuthUserBindingError, bindUserFromFirebaseToken } from "../lib/auth-user";
import { firebaseAdminAuth, isFirebaseAdminConfigured } from "../lib/firebase-admin";

const parsedMaxSessionAgeSeconds = Number.parseInt(
  process.env.FIREBASE_MAX_SESSION_AGE_SEC ?? `${30 * 24 * 60 * 60}`,
  10
);
const maxSessionAgeSeconds =
  Number.isFinite(parsedMaxSessionAgeSeconds) && parsedMaxSessionAgeSeconds > 0
    ? parsedMaxSessionAgeSeconds
    : 30 * 24 * 60 * 60;
const isTestAuthBypassEnabled =
  process.env.NODE_ENV === "test" &&
  process.env.ENABLE_TEST_AUTH_BYPASS === "1";

declare module "fastify" {
  interface FastifyRequest {
    authUser: DecodedIdToken | null;
    authDbUser: User | null;
  }
}

function getBearerToken(authorizationHeader?: string) {
  if (!authorizationHeader) {
    return null;
  }

  if (!authorizationHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authorizationHeader.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function isSessionFresh(decodedToken: DecodedIdToken) {
  if (typeof decodedToken.auth_time !== "number") {
    return true;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const ageSeconds = nowSeconds - decodedToken.auth_time;

  return ageSeconds <= maxSessionAgeSeconds;
}

function buildBypassToken(request: FastifyRequest): DecodedIdToken {
  const uidHeader = request.headers["x-test-firebase-uid"];
  const emailHeader = request.headers["x-test-email"];
  const uid =
    (Array.isArray(uidHeader) ? uidHeader[0] : uidHeader)?.trim() ||
    "integration_test_uid";
  const email =
    (Array.isArray(emailHeader) ? emailHeader[0] : emailHeader)?.trim() ||
    `${uid}@integration.test`;
  const nowSeconds = Math.floor(Date.now() / 1000);

  return {
    uid,
    email,
    email_verified: true,
    auth_time: nowSeconds,
    iat: nowSeconds,
    exp: nowSeconds + 60 * 60,
    aud: "integration-tests",
    iss: "integration-tests",
    sub: uid
  } as DecodedIdToken;
}

export async function verifyFirebaseIdToken(
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (isTestAuthBypassEnabled) {
    request.authUser = buildBypassToken(request);

    try {
      request.authDbUser = await bindUserFromFirebaseToken(request.authUser);
      return;
    } catch (error) {
      if (error instanceof AuthUserBindingError) {
        return reply.code(error.statusCode).send({
          error: error.code,
          message: error.message
        });
      }

      request.log.error(
        {
          err: error
        },
        "Unexpected auth user binding error in test bypass mode"
      );

      return reply.code(500).send({
        error: "AUTH_USER_BINDING_FAILED",
        message: "Failed to sync bypass-authenticated user with database."
      });
    }
  }

  if (!isFirebaseAdminConfigured || !firebaseAdminAuth) {
    return reply.code(503).send({
      error: "FIREBASE_AUTH_NOT_CONFIGURED",
      message:
        "Firebase Admin credentials are missing. Set FIREBASE_PROJECT_ID and service account values."
    });
  }

  const token = getBearerToken(request.headers.authorization);

  if (!token) {
    return reply.code(401).send({
      error: "MISSING_BEARER_TOKEN",
      message: "Authorization header must be in format: Bearer <firebase-id-token>."
    });
  }

  try {
    const decodedToken = await firebaseAdminAuth.verifyIdToken(token, true);
    request.authUser = decodedToken;
  } catch (error) {
    request.log.warn(
      {
        err: error
      },
      "Firebase ID token validation failed"
    );

    return reply.code(401).send({
      error: "INVALID_ID_TOKEN",
      message: "Provided Firebase ID token is invalid or revoked."
    });
  }

  if (!request.authUser) {
    return reply.code(401).send({
      error: "INVALID_ID_TOKEN",
      message: "Provided Firebase ID token is invalid."
    });
  }

  if (!isSessionFresh(request.authUser)) {
    return reply.code(401).send({
      error: "STALE_AUTH_SESSION",
      message:
        "Authentication session is too old. Re-authenticate to continue secured operations."
    });
  }

  try {
    request.authDbUser = await bindUserFromFirebaseToken(request.authUser);
  } catch (error) {
    if (error instanceof AuthUserBindingError) {
      return reply.code(error.statusCode).send({
        error: error.code,
        message: error.message
      });
    }

    request.log.error(
      {
        err: error
      },
      "Unexpected auth user binding error"
    );

    return reply.code(500).send({
      error: "AUTH_USER_BINDING_FAILED",
      message: "Failed to sync authenticated user with database."
    });
  }
}
