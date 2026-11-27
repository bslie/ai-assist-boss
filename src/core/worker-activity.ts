/**
 * Чем занят воркер: короткая фраза для маскота («Проверяю почту»). Воркер оборачивает свои задачи в `runActivity`,
 * фраза уходит руководителю событием `worker.activity` и лежит в Redis, чтобы только что открытая страница её увидела.
 * Быстрые задачи не показываем: фраза появляется, только если задача идёт дольше `delayMs` (иначе мигало бы каждые пару минут).
 * Это только индикатор: ничего во внешнем мире он не меняет и в бизнес-логике не участвует.
 */
import Redis from "ioredis";
import { channelFor, publishEvent } from "./events";

/** Если воркер упал посреди задачи, фраза сама исчезнет из Redis. */
const STATE_TTL_SEC = 180;
const DEFAULT_DELAY_MS = 700;

export type PublishActivity = (leaderId: string, label: string | null) => Promise<void>;

interface Entry {
  label: string;
  shown: boolean;
}

/** Учёт параллельных задач: показываем самую свежую из тех, что идут дольше задержки; пусто, когда таких нет. */
export function createActivityTracker(publish: PublishActivity, delayMs = DEFAULT_DELAY_MS) {
  const running = new Map<string, Entry[]>();
  const current = (leaderId: string): string | null => {
    const shown = (running.get(leaderId) ?? []).filter((e) => e.shown);
    return shown.length ? shown[shown.length - 1].label : null;
  };

  return async function runActivity<T>(leaderId: string, label: string, fn: () => Promise<T>): Promise<T> {
    const entry: Entry = { label, shown: false };
    running.set(leaderId, [...(running.get(leaderId) ?? []), entry]);
    const timer = setTimeout(() => {
      entry.shown = true;
      void publish(leaderId, current(leaderId)).catch(() => {});
    }, delayMs);
    try {
      return await fn();
    } finally {
      clearTimeout(timer);
      const rest = (running.get(leaderId) ?? []).filter((e) => e !== entry);
      if (rest.length) running.set(leaderId, rest);
      else running.delete(leaderId);
      if (entry.shown) void publish(leaderId, current(leaderId)).catch(() => {});
    }
  };
}

const stateKey = (leaderId: string) => `${channelFor(leaderId)}:activity`;
const redisUrl = () => process.env.REDIS_URL ?? "redis://localhost:6379";
const g = globalThis as unknown as { __activityRedis?: Redis };
const redis = () => (g.__activityRedis ??= new Redis(redisUrl(), { maxRetriesPerRequest: 1 }));

/** Публикация: событие для открытых страниц и состояние для тех, что откроются позже. Сбой Redis не роняет задачу. */
export const publishActivity: PublishActivity = async (leaderId, label) => {
  try {
    if (label) await redis().set(stateKey(leaderId), label, "EX", STATE_TTL_SEC);
    else await redis().del(stateKey(leaderId));
  } catch {
    /* индикатор не критичен */
  }
  await publishEvent(leaderId, { type: "worker.activity", data: { label } });
};

/** Текущая фраза воркера для руководителя; нет Redis или воркер свободен → null. */
export async function getActivity(leaderId: string): Promise<string | null> {
  try {
    return await redis().get(stateKey(leaderId));
  } catch {
    return null;
  }
}

export const runActivity = createActivityTracker(publishActivity);
