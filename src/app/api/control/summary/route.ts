import { Redis } from "ioredis";
import { NextResponse } from "next/server";
import { readyClock } from "@/core/clock";
import { db } from "@/db/client";
import { requireAdmin } from "@/lib/require-admin";

type Check = { name: string; ok: boolean; detail: string };

const errText = (e: unknown) => (e instanceof Error ? e.message.slice(0, 160) : "ошибка");

async function checkDb(): Promise<Check> {
  const t = Date.now();
  try {
    await db.$queryRaw`SELECT 1`;
    return { name: "PostgreSQL", ok: true, detail: `${Date.now() - t} мс` };
  } catch (e) {
    return { name: "PostgreSQL", ok: false, detail: errText(e) };
  }
}

async function checkRedis(): Promise<Check> {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 1500, enableOfflineQueue: false });
  try {
    await redis.connect();
    await redis.ping();
    return { name: "Redis", ok: true, detail: "отвечает" };
  } catch (e) {
    return { name: "Redis", ok: false, detail: errText(e) };
  } finally {
    redis.disconnect();
  }
}

/** `GET /api/control/summary` — состояние системы и счётчики для панели управления (только ADMIN). */
export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.res;

  const [dbCheck, redisCheck, clock, leaders, appUsers, pendingDecisions, openTasks] = await Promise.all([
    checkDb(),
    checkRedis(),
    readyClock(),
    db.leader.count(),
    db.appUser.count(),
    db.decision.count({ where: { status: "PENDING" } }),
    db.task.count({ where: { status: { notIn: ["DONE"] } } }),
  ]);

  const bot = process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, "");
  const config: Check[] = [
    {
      name: "LLM",
      ok: Boolean(process.env.LLM_BASE_URL && process.env.LLM_API_KEY && process.env.LLM_MODEL),
      detail: process.env.LLM_MODEL ? `модель ${process.env.LLM_MODEL}` : "не задана",
    },
    {
      name: "Telegram-бот",
      ok: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      detail: bot ? `@${bot}` : "нет имени бота",
    },
    {
      name: "Вход",
      ok: Boolean(process.env.AUTH_SECRET && process.env.AUTH_SECRET.length >= 32),
      detail: process.env.AUTH_SECRET ? "секрет задан" : "AUTH_SECRET не задан",
    },
  ];

  return NextResponse.json({
    viewer: { login: auth.user.login, displayName: auth.user.displayName },
    health: [
      dbCheck,
      redisCheck,
      { name: "Часы демо", ok: true, detail: `${clock.mode}, ${clock.now().toISOString()}` },
      ...config,
    ],
    counts: { leaders, appUsers, pendingDecisions, openTasks },
  });
}
