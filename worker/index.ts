/**
 * Воркер (SPEC 5): Telegram-бот, тик-планировщик демо-времени, очередь BullMQ, ретрансляция событий.
 * Запуск: `npm run worker`. Токен бота: TELEGRAM_BOT_TOKEN (без него — «сухой» режим с логом).
 */
import "dotenv/config";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { clock } from "@/core/clock";
import { subscribeAllEvents } from "@/core/events";
import { LlmClient, MemoryCache } from "@/core/llm";
import { createProviderOrReplay } from "@/core/llm/providers";
import { dbUsageSink } from "@/core/llm/usage-db";
import { tick, type JobQueue, type RoutineJob } from "@/core/scheduler";
import { processRoutineJob } from "@/core/telegram/morning";
import { activeMailConnectors } from "@/core/mail/poll";
import { pollWithPipeline } from "@/core/mail/pipeline";
import { prepareAgenda } from "@/core/meetings/agenda";
import { dueAvatarMeetings, launchAvatarBot } from "@/core/meetings/recall";
import { relayEvent } from "@/core/telegram/relay";
import type { StateStore } from "@/core/telegram/types";
import { db } from "@/db/client";
import { createBot, createConsoleMessenger, createMessenger } from "./telegram";

const QUEUE = "routines";
const TICK_MS = 60_000;
const MAIL_POLL_MS = Math.max(30, Number(process.env.MAIL_POLL_SECONDS ?? 120)) * 1000;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

function redisConnection() {
  const u = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
  return { host: u.hostname, port: Number(u.port || 6379), password: u.password || undefined, db: Number(u.pathname.slice(1)) || 0 };
}

function redisState(): StateStore {
  const r = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 2 });
  return {
    get: (k) => r.get(k),
    set: async (k, v, ttl) => void (await r.set(k, v, "EX", ttl)),
    del: async (k) => void (await r.del(k)),
  };
}

async function main() {
  await clock.init();
  log(`демо-время: ${clock.now().toISOString()} (режим ${clock.mode})`);

  // LLM для обучения на правках. Без неё правки просто не анализируются. Каждый вызов пишется в UsageLog.
  let llm: LlmClient | undefined;
  try {
    llm = new LlmClient({ provider: createProviderOrReplay(), cache: new MemoryCache(), usage: dbUsageSink(db) });
  } catch (e) {
    log(`LLM не настроена (${(e as Error).message}): обучение на правках выключено`);
  }
  // Режим повтора из кэша (без LLM_BASE_URL) правки не анализирует: не обещаем пользователю того, чего не будет.
  const learns = Boolean(llm && process.env.LLM_BASE_URL);

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const state = redisState();
  const bot = token ? createBot(token, db, state, { learns, llm }) : null;
  const messenger = bot ? createMessenger(bot.api) : createConsoleMessenger(log);
  if (!bot) log("TELEGRAM_BOT_TOKEN не задан: бот выключен, сообщения идут в лог");

  // Очередь рутин. От дублей защищает условный захват lastRunAt в tick(), а не jobId: BullMQ молча
  // отбрасывает задачу с уже существующим id, и после сброса демо-часов рутина не сработала бы снова.
  const queue = new Queue<RoutineJob>(QUEUE, {
    connection: redisConnection(),
    defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 200, removeOnFail: 500 },
  });
  const jobQueue: JobQueue = {
    enqueue: async (job) => void (await queue.add(job.code, job, { jobId: `${job.routineId}__${Date.parse(job.firedAt)}__${Date.now()}` })),
  };
  const worker = new Worker<RoutineJob>(
    QUEUE,
    async (job) => {
      const res = await processRoutineJob({ db, messenger }, job.data);
      log(`рутина ${job.data.code}:`, JSON.stringify(res));
      return res;
    },
    { connection: redisConnection(), concurrency: 1 },
  );
  worker.on("failed", (job, err) => log(`рутина ${job?.data.code} упала:`, err.message));

  // Карточки решений: web/ingest публикуют события, воркер доставляет их в Telegram.
  const unsubscribe = await subscribeAllEvents((leaderId, e) => {
    relayEvent({ db, messenger, llm }, leaderId, e)
      .then((what) => what && log(`событие ${e.type}: ${what}`))
      .catch((err) => log(`событие ${e.type}: ошибка:`, (err as Error).message));
  });

  const runTick = async () => {
    try {
      const n = await tick(db, jobQueue);
      if (n > 0) log(`тик: поставлено рутин — ${n}`);
    } catch (e) {
      log("тик не удался:", (e as Error).message);
    }
  };
  await runTick();
  const timer = setInterval(runTick, TICK_MS);

  // Опрос почты: включённые подключения по очереди. Блокировка в Redis не даёт двум процессам разобрать одно письмо дважды.
  let polling = false;
  const runMailPoll = async () => {
    if (polling) return;
    polling = true;
    try {
      for (const c of await activeMailConnectors(db)) {
        const res = await pollWithPipeline(db, c.leaderId, c.id);
        if (res.ok) {
          if (res.fetched > 0) log(`почта ${c.id}: писем ${res.fetched}, карточек ${res.stats.decisionsCreated}`);
        } else if (!res.skipped) log(`почта ${c.id}: ${res.message}`);
      }
    } catch (e) {
      log("опрос почты не удался:", (e as Error).message);
    } finally {
      polling = false;
    }
  };
  void runMailPoll();
  const mailTimer = setInterval(runMailPoll, MAIL_POLL_MS);

  // Встречи с аватаром (SPEC 5.2): раз в 2 минуты реального времени готовим вопросы и за минуту до начала отправляем бота.
  let launching = false;
  const runAvatarCheck = async () => {
    if (launching) return;
    launching = true;
    try {
      for (const m of await dueAvatarMeetings(db)) {
        await prepareAgenda(db, m.leaderId, m.id);
        const res = await launchAvatarBot(db, m.leaderId, m.id);
        if (res.status !== "skipped") log(`аватар ${m.id}: ${res.status}${res.status === "failed" ? ` (${res.reason})` : ""}`);
      }
    } catch (e) {
      log("запуск аватара не удался:", (e as Error).message);
    } finally {
      launching = false;
    }
  };
  void runAvatarCheck();
  const avatarTimer = setInterval(runAvatarCheck, 120_000);

  if (bot) {
    void bot.start({ onStart: (me) => log(`бот @${me.username} запущен`) });
  }

  const shutdown = async () => {
    log("останавливаюсь…");
    clearInterval(timer);
    clearInterval(mailTimer);
    clearInterval(avatarTimer);
    await bot?.stop();
    await unsubscribe();
    await worker.close();
    await queue.close();
    await db.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
