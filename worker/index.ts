/**
 * Воркер (SPEC 5): Telegram-бот, тик-планировщик демо-времени, очередь BullMQ, ретрансляция событий.
 * Запуск: `npm run worker`. Токен бота: TELEGRAM_BOT_TOKEN (без него — «сухой» режим с логом).
 */
import "dotenv/config";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { clock } from "@/core/clock";
import { subscribeAllEvents } from "@/core/events";
import { tick, type JobQueue, type RoutineJob } from "@/core/scheduler";
import { refreshDecisionCard, sendDecisionCard } from "@/core/telegram/cards";
import { processRoutineJob } from "@/core/telegram/morning";
import type { StateStore } from "@/core/telegram/types";
import { db } from "@/db/client";
import { createBot, createConsoleMessenger, createMessenger } from "./telegram";

const QUEUE = "routines";
const TICK_MS = 60_000;
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

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const state = redisState();
  const bot = token ? createBot(token, db, state) : null;
  const messenger = bot ? createMessenger(bot.api) : createConsoleMessenger(log);
  if (!bot) log("TELEGRAM_BOT_TOKEN не задан: бот выключен, сообщения идут в лог");

  // Очередь рутин. jobId = рутина + момент по cron: повторный тик не создаст дубль.
  const queue = new Queue<RoutineJob>(QUEUE, {
    connection: redisConnection(),
    defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 200, removeOnFail: 500 },
  });
  const jobQueue: JobQueue = {
    enqueue: async (job) => void (await queue.add(job.code, job, { jobId: `${job.routineId}__${Date.parse(job.firedAt)}` })),
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
    const id = typeof e.data.id === "string" ? e.data.id : null;
    if (!id) return;
    const run =
      e.type === "decision.created"
        ? sendDecisionCard(db, messenger, leaderId, id)
        : e.type === "decision.updated"
          ? refreshDecisionCard(db, messenger, leaderId, id)
          : null;
    run?.catch((err) => log(`${e.type} ${id}: не удалось обновить Telegram:`, (err as Error).message));
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

  if (bot) {
    void bot.start({ onStart: (me) => log(`бот @${me.username} запущен`) });
  }

  const shutdown = async () => {
    log("останавливаюсь…");
    clearInterval(timer);
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
