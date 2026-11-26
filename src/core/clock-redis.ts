import Redis from "ioredis";
import type { OffsetStore } from "./clock";

const KEY = "demo:clock:offsetMs";

export function createRedisOffsetStore(url = process.env.REDIS_URL ?? "redis://localhost:6379"): OffsetStore {
  const redis = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 });

  return {
    async get() {
      const raw = await redis.get(KEY);
      return raw === null ? null : Number(raw);
    },
    async setIfAbsent(value) {
      await redis.set(KEY, String(value), "NX");
      const raw = await redis.get(KEY);
      return raw === null ? value : Number(raw);
    },
    async set(value) {
      await redis.set(KEY, String(value));
    },
  };
}
