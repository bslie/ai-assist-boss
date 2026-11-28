/**
 * События для SSE (SPEC 6): web и worker — разные процессы, поэтому шина на Redis pub/sub.
 * Канал на руководителя: `events:<leaderId>` (изоляция данных, инвариант 5).
 */
import Redis from "ioredis";
import { z } from "zod";

export const EVENT_TYPES = [
  "decision.created",
  "decision.updated",
  "email.processed",
  "task.updated",
  "metrics.updated",
  "avatar.speak",
  /** Запуск рутины вручную (демо-сценарии): исполняет воркер, у него есть Telegram. data.code — код рутины. */
  "routine.trigger",
  /** Сообщение руководителю в Telegram от веба (ответ исполнителя по ссылке из письма). data.text — простой текст. */
  "leader.notify",
  /** Чем сейчас занят воркер для этого руководителя. data.label — короткая фраза или null, если свободен. */
  "worker.activity",
  /** Демо: вопрос руководителя боту в Telegram и ответ бота. Исполняет воркер (у него есть бот). data.text — вопрос. */
  "demo.telegram_chat",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const LeaderEventSchema = z.object({
  type: z.enum(EVENT_TYPES),
  /** Небольшой JSON; клиент по событию обычно перечитывает данные. */
  data: z.record(z.string(), z.unknown()).default({}),
});
export type LeaderEvent = z.infer<typeof LeaderEventSchema>;

/**
 * Префикс каналов. Pub/sub в Redis общий для всех баз, поэтому тесты (vitest задаёт `EVENTS_CHANNEL_PREFIX`)
 * публикуют в свои каналы и не будят живой воркер, который иначе исполнил бы тестовые события раньше теста.
 */
const prefix = () => `${process.env.EVENTS_CHANNEL_PREFIX || "events"}:`;
export const channelFor = (leaderId: string) => `${prefix()}${leaderId}`;

const redisUrl = () => process.env.REDIS_URL ?? "redis://localhost:6379";

const g = globalThis as unknown as { __eventsPub?: Redis };
function publisher(): Redis {
  return (g.__eventsPub ??= new Redis(redisUrl(), { maxRetriesPerRequest: 1 }));
}

/** Публикация не должна ронять бизнес-операцию: ошибки Redis проглатываются. */
export async function publishEvent(leaderId: string, event: LeaderEvent): Promise<void> {
  try {
    await publisher().publish(channelFor(leaderId), JSON.stringify(LeaderEventSchema.parse(event)));
  } catch {
    /* SSE — best effort */
  }
}

/** Подписка на события руководителя. Возвращает функцию отписки. */
export async function subscribeEvents(leaderId: string, onEvent: (e: LeaderEvent) => void): Promise<() => Promise<void>> {
  const sub = new Redis(redisUrl(), { maxRetriesPerRequest: 1 });
  const channel = channelFor(leaderId);
  sub.on("message", (_ch, raw) => {
    const parsed = LeaderEventSchema.safeParse(safeJson(raw));
    if (parsed.success) onEvent(parsed.data);
  });
  sub.on("error", () => {});
  await sub.subscribe(channel);
  return async () => {
    sub.removeAllListeners("message");
    await sub.quit().catch(() => {});
  };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Подписка на события ВСЕХ руководителей (для воркера: рассылка карточек в Telegram). */
export async function subscribeAllEvents(
  onEvent: (leaderId: string, e: LeaderEvent) => void,
): Promise<() => Promise<void>> {
  const sub = new Redis(redisUrl(), { maxRetriesPerRequest: 1 });
  sub.on("pmessage", (_p, channel, raw) => {
    const parsed = LeaderEventSchema.safeParse(safeJson(raw));
    if (parsed.success) onEvent(channel.slice(prefix().length), parsed.data);
  });
  sub.on("error", () => {});
  await sub.psubscribe(`${prefix()}*`);
  return async () => {
    sub.removeAllListeners("pmessage");
    await sub.quit().catch(() => {});
  };
}
