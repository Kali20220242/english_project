import { prisma } from "@neontalk/db";
import { MessageRole } from "@prisma/client";

import type { DomainRoleplayTurn } from "./anti-corruption-mapper";

export class PersistDomainTurnError extends Error {
  readonly code:
    | "SOURCE_USER_MESSAGE_NOT_FOUND"
    | "SOURCE_MESSAGE_MISMATCH"
    | "INVALID_DOMAIN_INPUT";
  readonly details?: unknown;

  constructor(
    code: PersistDomainTurnError["code"],
    message: string,
    details?: unknown
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export type PersistDomainTurnInput = {
  domainTurn: DomainRoleplayTurn;
  sourceUserMessageId?: string | null;
  pubsubMessageId: string;
  outboxEventId?: string | null;
  aiProvider: string;
  aiModel: string;
};

export type PersistDomainTurnResult = {
  replayed: boolean;
  sourceUserMessageId: string;
  assistantMessageId: string;
  assistantSeq: number;
  correctionId: string | null;
  savedPhraseCount: number;
};

function ensureDomainTurnInput(input: DomainRoleplayTurn) {
  if (!input.sessionId || !input.userId || !input.assistantMessage.text) {
    throw new PersistDomainTurnError(
      "INVALID_DOMAIN_INPUT",
      "Domain turn payload is incomplete."
    );
  }
}

export async function persistDomainTurn(
  input: PersistDomainTurnInput
): Promise<PersistDomainTurnResult> {
  ensureDomainTurnInput(input.domainTurn);

  return prisma.$transaction(async (tx) => {
    const sourceUserMessage = await tx.message.findFirst({
      where: {
        sessionId: input.domainTurn.sessionId,
        seq: input.domainTurn.seq,
        role: MessageRole.USER
      },
      select: {
        id: true,
        seq: true
      }
    });

    if (!sourceUserMessage) {
      throw new PersistDomainTurnError(
        "SOURCE_USER_MESSAGE_NOT_FOUND",
        "Source user message was not found for this turn.",
        {
          sessionId: input.domainTurn.sessionId,
          seq: input.domainTurn.seq
        }
      );
    }

    if (
      input.sourceUserMessageId &&
      input.sourceUserMessageId !== sourceUserMessage.id
    ) {
      throw new PersistDomainTurnError(
        "SOURCE_MESSAGE_MISMATCH",
        "Source message id from Pub/Sub does not match stored user message.",
        {
          expected: input.sourceUserMessageId,
          actual: sourceUserMessage.id
        }
      );
    }

    const existingAssistant = await tx.message.findFirst({
      where: {
        sessionId: input.domainTurn.sessionId,
        role: MessageRole.ASSISTANT,
        metadata: {
          path: ["sourceUserMessageId"],
          equals: sourceUserMessage.id
        }
      },
      select: {
        id: true,
        seq: true,
        correction: {
          select: {
            id: true
          }
        }
      }
    });

    if (existingAssistant) {
      const savedPhraseCount = await tx.savedPhrase.count({
        where: {
          userId: input.domainTurn.userId,
          sourceMessageId: existingAssistant.id
        }
      });

      return {
        replayed: true,
        sourceUserMessageId: sourceUserMessage.id,
        assistantMessageId: existingAssistant.id,
        assistantSeq: existingAssistant.seq,
        correctionId: existingAssistant.correction?.id ?? null,
        savedPhraseCount
      };
    }

    const latestMessage = await tx.message.findFirst({
      where: {
        sessionId: input.domainTurn.sessionId
      },
      orderBy: {
        seq: "desc"
      },
      select: {
        seq: true
      }
    });

    const assistantSeq = (latestMessage?.seq ?? 0) + 1;

    const assistantMessage = await tx.message.create({
      data: {
        sessionId: input.domainTurn.sessionId,
        seq: assistantSeq,
        role: MessageRole.ASSISTANT,
        text: input.domainTurn.assistantMessage.text,
        payloadHash: input.domainTurn.assistantMessage.payloadHash,
        metadata: {
          ...input.domainTurn.assistantMessage.metadata,
          sourceUserMessageId: sourceUserMessage.id,
          sourceUserSeq: sourceUserMessage.seq,
          aiProvider: input.aiProvider,
          aiModel: input.aiModel,
          mapper: "anti-corruption-v1",
          contextVersion: input.domainTurn.contextVersion,
          scenarioId: input.domainTurn.scenarioId,
          outboxEventId: input.outboxEventId ?? null,
          pubsubMessageId: input.pubsubMessageId
        }
      },
      select: {
        id: true,
        seq: true
      }
    });

    const correction = await tx.correction.create({
      data: {
        messageId: assistantMessage.id,
        originalText: input.domainTurn.correction.originalText,
        naturalText: input.domainTurn.correction.naturalText,
        explanation: input.domainTurn.correction.explanation,
        suggestions: input.domainTurn.correction.suggestions
      },
      select: {
        id: true
      }
    });

    let savedPhraseCount = 0;

    if (input.domainTurn.savedPhrases.length > 0) {
      const inserted = await tx.savedPhrase.createMany({
        data: input.domainTurn.savedPhrases.map((phrase) => ({
          userId: phrase.userId,
          sessionId: phrase.sessionId,
          phrase: phrase.phrase,
          context: phrase.context,
          sourceMessageId: assistantMessage.id
        }))
      });

      savedPhraseCount = inserted.count;
    }

    await tx.eventLog.create({
      data: {
        messageId: assistantMessage.id,
        stream: "session.turn",
        streamId: input.domainTurn.sessionId,
        eventType: "ROLEPLAY_TURN_PERSISTED",
        payload: {
          sourceUserMessageId: sourceUserMessage.id,
          sourceUserSeq: sourceUserMessage.seq,
          assistantMessageId: assistantMessage.id,
          assistantSeq: assistantMessage.seq,
          correctionId: correction.id,
          savedPhraseCount,
          aiProvider: input.aiProvider,
          aiModel: input.aiModel,
          outboxEventId: input.outboxEventId ?? null,
          pubsubMessageId: input.pubsubMessageId
        }
      }
    });

    return {
      replayed: false,
      sourceUserMessageId: sourceUserMessage.id,
      assistantMessageId: assistantMessage.id,
      assistantSeq: assistantMessage.seq,
      correctionId: correction.id,
      savedPhraseCount
    };
  });
}
