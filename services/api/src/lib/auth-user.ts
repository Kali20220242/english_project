import { prisma } from "@neontalk/db";
import { Prisma, type User } from "@prisma/client";
import type { DecodedIdToken } from "firebase-admin/auth";

type AuthUserBindingErrorCode =
  | "EMAIL_ALREADY_LINKED"
  | "FIREBASE_UID_CONFLICT"
  | "AUTH_USER_BINDING_FAILED";

export class AuthUserBindingError extends Error {
  readonly code: AuthUserBindingErrorCode;
  readonly statusCode: number;

  constructor(
    code: AuthUserBindingErrorCode,
    message: string,
    statusCode = 500
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function resolveUserEmail(decodedToken: DecodedIdToken) {
  const normalizedEmail = decodedToken.email?.trim().toLowerCase();
  if (normalizedEmail) {
    return normalizedEmail;
  }

  return `${decodedToken.uid}@firebase.local`;
}

function buildAuthActor(firebaseUid: string) {
  return `firebase:${firebaseUid}`;
}

async function writeUserAuditLog(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    firebaseUid: string;
    action: string;
    payload?: Prisma.InputJsonObject;
  }
) {
  await tx.auditLog.create({
    data: {
      userId: input.userId,
      actor: buildAuthActor(input.firebaseUid),
      action: input.action,
      entityType: "User",
      entityId: input.userId,
      payload: input.payload
    }
  });
}

async function updateEmailIfNeeded(
  existingUser: User,
  desiredEmail: string,
  firebaseUid: string
) {
  if (existingUser.email === desiredEmail) {
    return existingUser;
  }

  const emailOwner = await prisma.user.findUnique({
    where: { email: desiredEmail }
  });

  if (emailOwner && emailOwner.id !== existingUser.id) {
    throw new AuthUserBindingError(
      "EMAIL_ALREADY_LINKED",
      "This email is already linked to another account.",
      409
    );
  }

  return prisma.$transaction(async (tx) => {
    const updatedUser = await tx.user.update({
      where: { id: existingUser.id },
      data: {
        email: desiredEmail,
        firebaseUid
      }
    });

    await writeUserAuditLog(tx, {
      userId: updatedUser.id,
      firebaseUid,
      action: "AUTH_USER_EMAIL_UPDATED",
      payload: {
        previousEmail: existingUser.email,
        nextEmail: desiredEmail
      }
    });

    return updatedUser;
  });
}

async function bindAfterRace(firebaseUid: string, email: string) {
  const existingByUid = await prisma.user.findUnique({
    where: { firebaseUid }
  });

  if (existingByUid) {
    return updateEmailIfNeeded(existingByUid, email, firebaseUid);
  }

  const existingByEmail = await prisma.user.findUnique({
    where: { email }
  });

  if (!existingByEmail) {
    throw new AuthUserBindingError(
      "AUTH_USER_BINDING_FAILED",
      "User binding failed after retry."
    );
  }

  if (
    existingByEmail.firebaseUid &&
    existingByEmail.firebaseUid !== firebaseUid
  ) {
    throw new AuthUserBindingError(
      "FIREBASE_UID_CONFLICT",
      "This email is already attached to a different Firebase account.",
      409
    );
  }

  return prisma.$transaction(async (tx) => {
    const updatedUser = await tx.user.update({
      where: { id: existingByEmail.id },
      data: { firebaseUid }
    });

    await writeUserAuditLog(tx, {
      userId: updatedUser.id,
      firebaseUid,
      action: "AUTH_USER_FIREBASE_LINKED",
      payload: {
        email
      }
    });

    return updatedUser;
  });
}

export async function bindUserFromFirebaseToken(decodedToken: DecodedIdToken) {
  const firebaseUid = decodedToken.uid;
  const resolvedEmail = resolveUserEmail(decodedToken);

  const existingByUid = await prisma.user.findUnique({
    where: { firebaseUid }
  });

  if (existingByUid) {
    return updateEmailIfNeeded(existingByUid, resolvedEmail, firebaseUid);
  }

  const existingByEmail = await prisma.user.findUnique({
    where: { email: resolvedEmail }
  });

  if (existingByEmail) {
    if (
      existingByEmail.firebaseUid &&
      existingByEmail.firebaseUid !== firebaseUid
    ) {
      throw new AuthUserBindingError(
        "FIREBASE_UID_CONFLICT",
        "This email is already attached to a different Firebase account.",
        409
      );
    }

    return prisma.$transaction(async (tx) => {
      const updatedUser = await tx.user.update({
        where: { id: existingByEmail.id },
        data: { firebaseUid }
      });

      await writeUserAuditLog(tx, {
        userId: updatedUser.id,
        firebaseUid,
        action: "AUTH_USER_FIREBASE_LINKED",
        payload: {
          email: resolvedEmail
        }
      });

      return updatedUser;
    });
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: {
          email: resolvedEmail,
          firebaseUid
        }
      });

      await writeUserAuditLog(tx, {
        userId: createdUser.id,
        firebaseUid,
        action: "AUTH_USER_CREATED",
        payload: {
          email: createdUser.email
        }
      });

      return createdUser;
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return bindAfterRace(firebaseUid, resolvedEmail);
    }

    throw new AuthUserBindingError(
      "AUTH_USER_BINDING_FAILED",
      "Unexpected error while binding Firebase user to database."
    );
  }
}
