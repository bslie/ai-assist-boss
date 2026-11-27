/**
 * Транскрипт без вебхука: воркер сам спрашивает Recall о встречах, где был бот, и собирает карточку протокола.
 * Пользователю ничего настраивать не нужно: ключ и регион уже в подключении Recall.
 * Транскрипт ещё не готов (встреча идёт) — это не ошибка: спросим в следующий раз.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { clock } from "../clock";
import type { LlmClient } from "../llm";
import { generateProtocolDecision } from "./protocol";
import { fetchBotTranscript, loadRecallAuth } from "./recall";

const LOOKBACK_MS = 24 * 3_600_000;

/** Встречи с ботом Recall, начавшиеся за последние сутки, по которым протокола ещё нет. */
export async function dueTranscriptMeetings(db: PrismaClient): Promise<{ id: string; leaderId: string }[]> {
  const now = clock.now();
  return db.meeting.findMany({
    where: {
      recallBotId: { not: null },
      NOT: { recallBotId: { startsWith: "pending:" } },
      protocolReadyAt: null,
      isProtocolApproved: false,
      startAt: { lte: now, gte: new Date(now.getTime() - LOOKBACK_MS) },
    },
    select: { id: true, leaderId: true },
  });
}

export type CollectResult = { status: "created" } | { status: "waiting"; reason: string } | { status: "skipped"; reason: string };

export async function collectRecallProtocol(db: PrismaClient, llm: LlmClient, leaderId: string, meetingId: string): Promise<CollectResult> {
  const meeting = await db.meeting.findFirst({ where: { id: meetingId, leaderId }, select: { recallBotId: true } });
  if (!meeting?.recallBotId || meeting.recallBotId.startsWith("pending:")) return { status: "skipped", reason: "бота на встрече не было" };
  const auth = await loadRecallAuth(db, leaderId);
  if (!auth) return { status: "skipped", reason: "Recall не подключён" };
  let transcript: string;
  try {
    transcript = await fetchBotTranscript(auth, meeting.recallBotId);
  } catch (e) {
    return { status: "waiting", reason: (e as Error).message };
  }
  const res = await generateProtocolDecision({ db, llm }, leaderId, meetingId, transcript);
  return res.ok ? { status: "created" } : { status: "skipped", reason: res.reason };
}
