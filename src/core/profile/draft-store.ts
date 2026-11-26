import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { z } from "zod";
import { ProfileDraftSchema } from "./index";

/** Черновики импорта ждут подтверждения в вебе (SPEC 4.6: черновик → diff → подтверждение → запись). */
const StoredSchema = z.object({ leaderId: z.string(), markdown: z.string(), draft: ProfileDraftSchema });
export type StoredDraft = z.infer<typeof StoredSchema>;

const TTL_SECONDS = 3600;
const g = globalThis as unknown as { __draftRedis?: Redis };
const redis = () => (g.__draftRedis ??= new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 2 }));
const key = (id: string) => `profile-draft:${id}`;

export async function saveDraft(value: StoredDraft): Promise<string> {
  const id = randomUUID();
  await redis().set(key(id), JSON.stringify(StoredSchema.parse(value)), "EX", TTL_SECONDS);
  return id;
}

export async function takeDraft(id: string): Promise<StoredDraft | null> {
  const raw = await redis().get(key(id));
  if (!raw) return null;
  const parsed = StoredSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

export async function deleteDraft(id: string): Promise<void> {
  await redis().del(key(id));
}
