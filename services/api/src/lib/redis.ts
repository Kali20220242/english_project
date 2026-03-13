import { createClient, type RedisClientType } from "redis";

const redisUrl = process.env.REDIS_URL;

export const hasRedisConfig = Boolean(redisUrl);

export const redisClient: RedisClientType | null = redisUrl
  ? createClient({
      url: redisUrl
    })
  : null;
