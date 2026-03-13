import { PubSub } from "@google-cloud/pubsub";
import { RoleplayTurnJobSchema, type RoleplayTurnJob } from "@neontalk/contracts";

const roleplayTopicName = process.env.PUBSUB_ROLEPLAY_TURNS_TOPIC ?? null;
const googleCloudProjectId =
  process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? null;

const pubsubClient =
  roleplayTopicName !== null
    ? new PubSub(
        googleCloudProjectId ? { projectId: googleCloudProjectId } : undefined
      )
    : null;

export type PublishRoleplayTurnInput = {
  outboxEventId: string;
  aggregateType: string;
  aggregateId: string;
  sessionId: string;
  job: RoleplayTurnJob;
};

export type PublishRoleplayTurnResult = {
  delivered: boolean;
  provider: "pubsub";
  topic: string | null;
  messageId: string | null;
  reason: string | null;
};

export type RoleplayTurnPublisher = {
  isConfigured: boolean;
  provider: "pubsub";
  topicName: string | null;
  publishRoleplayTurn: (
    input: PublishRoleplayTurnInput
  ) => Promise<PublishRoleplayTurnResult>;
};

export const roleplayTurnPublisher: RoleplayTurnPublisher = {
  isConfigured: roleplayTopicName !== null,
  provider: "pubsub",
  topicName: roleplayTopicName,
  async publishRoleplayTurn(
    input: PublishRoleplayTurnInput
  ): Promise<PublishRoleplayTurnResult> {
    if (!roleplayTopicName || !pubsubClient) {
      return {
        delivered: false,
        provider: "pubsub",
        topic: null,
        messageId: null,
        reason: "PUBSUB_NOT_CONFIGURED"
      };
    }

    const validJob = RoleplayTurnJobSchema.parse(input.job);

    const messageId = await pubsubClient.topic(roleplayTopicName).publishMessage({
      data: Buffer.from(JSON.stringify(validJob), "utf8"),
      attributes: {
        type: validJob.type,
        outboxEventId: input.outboxEventId,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        sessionId: input.sessionId
      }
    });

    return {
      delivered: true,
      provider: "pubsub",
      topic: roleplayTopicName,
      messageId,
      reason: null
    };
  }
};
