/**
 * Recall.ai (SPEC 4.5.3): бот заходит на созвон, камера бота — публичная страница аватара, после встречи отдаёт транскрипт.
 * Доступы: подключение BUILTIN_RECALL руководителя, иначе RECALL_API_KEY / RECALL_REGION из env.
 * Внешний вызов идёт только через Policy Gate: запрет `meeting.join_bot` в правах подключения останавливает запуск.
 * Режим AVATAR у встречи — постоянное согласие руководителя (правило профиля), поэтому APPROVE по правам не блокирует.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { clock } from "../clock";
import { decryptJson } from "../connectors/crypto";
import { evaluate, getConnectorToolPermission, loadGateLeader, logVerdict } from "../policy-gate";
import { recallCostRub, recordServiceUsage } from "../usage";
import { detectPlatform, MeetingUrlSchema } from "./platform";

const RECALL_TYPE = "BUILTIN_RECALL";
const JOIN_LEAD_MS = 60_000; // SPEC 4.5.3: за 1 минуту до начала

export interface RecallAuth {
  apiKey: string;
  region: string;
  connectorId: string | null;
}

export async function loadRecallAuth(db: PrismaClient, leaderId: string): Promise<RecallAuth | null> {
  const row = await db.connector.findFirst({ where: { leaderId, type: RECALL_TYPE, isActive: true } });
  if (row) {
    const stored = decryptJson<{ values?: Record<string, string> }>(row.encryptedConfig);
    const apiKey = stored?.values?.apiKey;
    if (apiKey) return { apiKey, region: stored?.values?.region || "us-east-1", connectorId: row.id };
  }
  const apiKey = process.env.RECALL_API_KEY;
  return apiKey ? { apiKey, region: process.env.RECALL_REGION ?? "us-east-1", connectorId: null } : null;
}

const base = (a: RecallAuth) => `https://${a.region}.recall.ai/api/v1`;
const headers = (a: RecallAuth) => ({ Authorization: `Token ${a.apiKey}`, "Content-Type": "application/json" });

const BotSchema = z.object({ id: z.string().min(1) }).passthrough();

export function appUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

/** Бот представляется в имени участника: агент всегда называет себя ИИ-помощником. */
export async function createAvatarBot(auth: RecallAuth, args: { meetingUrl: string; leaderName: string; avatarToken: string }): Promise<string> {
  const res = await fetch(`${base(auth)}/bot/`, {
    method: "POST",
    headers: headers(auth),
    body: JSON.stringify({
      meeting_url: args.meetingUrl,
      bot_name: `ИИ-помощник ${args.leaderName}`,
      output_media: { camera: { kind: "webpage", config: { url: `${appUrl()}/avatar/${args.avatarToken}?autoplay=1` } } },
      recording_config: { transcript: { provider: { recallai_streaming: {} } } },
      ...(process.env.RECALL_WEBHOOK_URL ? { webhook_url: process.env.RECALL_WEBHOOK_URL } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Recall: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return BotSchema.parse(await res.json()).id;
}

const WordSchema = z.object({ text: z.string() }).passthrough();
const TranscriptSchema = z.array(
  z.object({ participant: z.object({ name: z.string().nullish() }).passthrough().nullish(), words: z.array(WordSchema) }).passthrough(),
);

/** Транскрипт бота в строки «Имя: текст». Форма ответа Recall проверяется zod; чужая форма — ошибка, а не пустой протокол. */
export async function fetchBotTranscript(auth: RecallAuth, botId: string): Promise<string> {
  const botRes = await fetch(`${base(auth)}/bot/${encodeURIComponent(botId)}/`, { headers: headers(auth) });
  if (!botRes.ok) throw new Error(`Recall: HTTP ${botRes.status}`);
  const bot = z
    .object({ recordings: z.array(z.object({ media_shortcuts: z.object({ transcript: z.object({ data: z.object({ download_url: z.string().url() }) }).nullish() }).nullish() }).passthrough()).default([]) })
    .passthrough()
    .parse(await botRes.json());
  const url = bot.recordings.map((r) => r.media_shortcuts?.transcript?.data.download_url).find(Boolean);
  if (!url) throw new Error("Recall: транскрипт ещё не готов");
  const tr = await fetch(url);
  if (!tr.ok) throw new Error(`Recall: транскрипт HTTP ${tr.status}`);
  return TranscriptSchema.parse(await tr.json())
    .map((s) => `${s.participant?.name ?? "Участник"}: ${s.words.map((w) => w.text).join(" ")}`)
    .join("\n");
}

export type LaunchResult = { status: "launched"; botId: string } | { status: "skipped"; reason: string } | { status: "failed"; reason: string };

/** Запуск бота на встречу с аватаром. Идемпотентен: `recallBotId` занимается условным апдейтом до вызова API. */
export async function launchAvatarBot(db: PrismaClient, leaderId: string, meetingId: string): Promise<LaunchResult> {
  const meeting = await db.meeting.findFirst({ where: { id: meetingId, leaderId }, include: { leader: { select: { name: true } } } });
  if (!meeting) return { status: "skipped", reason: "встреча не найдена" };
  if (meeting.participationMode !== "AVATAR") return { status: "skipped", reason: "режим участия не AVATAR" };
  if (!meeting.meetingUrl) return { status: "skipped", reason: "у встречи нет ссылки" };
  if (meeting.recallBotId) return { status: "skipped", reason: "бот уже запущен" };
  const platform = detectPlatform(meeting.meetingUrl);
  if (!platform.botSupported) {
    return { status: "skipped", reason: `${platform.label}: бот Recall туда не заходит — пришлите транскрипт вручную` };
  }
  const auth = await loadRecallAuth(db, leaderId);
  if (!auth) return { status: "skipped", reason: "Recall не подключён" };

  const perm = auth.connectorId ? await getConnectorToolPermission(db, leaderId, auth.connectorId, "meeting.join_bot") : null;
  const verdict = evaluate("meeting.join_bot", { leader: await loadGateLeader(db, leaderId), toolPermission: perm === "DENY" ? "DENY" : "AUTO", isOutbound: true, approvedByLeader: true });
  await logVerdict(db, leaderId, "meeting.join_bot", verdict, { metadata: { meetingId, standingConsent: "participationMode=AVATAR" } });
  if (verdict.verdict === "DENY") return { status: "skipped", reason: "запуск бота запрещён в правах подключения" };

  const placeholder = `pending:${randomUUID()}`;
  const claim = await db.meeting.updateMany({ where: { id: meetingId, leaderId, recallBotId: null }, data: { recallBotId: placeholder } });
  if (claim.count === 0) return { status: "skipped", reason: "бот уже запускается" };
  try {
    const botId = await createAvatarBot(auth, { meetingUrl: meeting.meetingUrl, leaderName: meeting.leader.name, avatarToken: meeting.avatarToken });
    await db.meeting.update({ where: { id: meetingId }, data: { recallBotId: botId } });
    await db.activityLog.create({
      data: { createdAt: clock.now(), leaderId, pipeline: "MEETING", action: "AVATAR_BOT_LAUNCHED", reason: `ИИ-помощник отправлен на встречу «${meeting.title}»`, metadata: { meetingId, botId } },
    });
    // Recall считает минуты бота: пишем плановую длительность встречи (SPEC инвариант 8).
    const seconds = Math.max(0, (meeting.endAt.getTime() - meeting.startAt.getTime()) / 1000);
    await recordServiceUsage(db, { leaderId, pipeline: "AVATAR_SESSION", provider: "recall.ai", model: "bot", audioSeconds: seconds, costRub: recallCostRub(seconds) }).catch(() => {});
    return { status: "launched", botId };
  } catch (e) {
    await db.meeting.update({ where: { id: meetingId }, data: { recallBotId: null } });
    return { status: "failed", reason: (e as Error).message };
  }
}

export type JoinNowResult = LaunchResult | { status: "rejected"; reason: string };

/**
 * «Зайди на встречу»: руководитель сам указал ссылку — это явное согласие на AVATAR для этой встречи.
 * Ссылка проверяется zod и платформой до записи в БД; завершённую встречу не трогаем.
 */
export async function joinMeetingNow(db: PrismaClient, leaderId: string, meetingId: string, url: string): Promise<JoinNowResult> {
  const parsed = MeetingUrlSchema.safeParse(url);
  if (!parsed.success) return { status: "rejected", reason: "некорректная ссылка на встречу" };
  const platform = detectPlatform(parsed.data);
  if (!platform.botSupported) return { status: "rejected", reason: `${platform.label}: бот туда не заходит` };
  const meeting = await db.meeting.findFirst({ where: { id: meetingId, leaderId }, select: { endAt: true, recallBotId: true } });
  if (!meeting) return { status: "rejected", reason: "встреча не найдена" };
  if (meeting.recallBotId) return { status: "rejected", reason: "бот уже на этой встрече" };
  if (meeting.endAt <= clock.now()) return { status: "rejected", reason: "встреча уже закончилась" };
  await db.meeting.updateMany({ where: { id: meetingId, leaderId, recallBotId: null }, data: { meetingUrl: parsed.data, participationMode: "AVATAR" } });
  return launchAvatarBot(db, leaderId, meetingId);
}

/** Встречи с аватаром, которым пора запускать бота: старт в ближайшую минуту по демо-времени (или уже идёт). */
export async function dueAvatarMeetings(db: PrismaClient): Promise<{ id: string; leaderId: string }[]> {
  const now = clock.now();
  return db.meeting.findMany({
    where: { participationMode: "AVATAR", recallBotId: null, meetingUrl: { not: null }, startAt: { lte: new Date(now.getTime() + JOIN_LEAD_MS) }, endAt: { gt: now } },
    select: { id: true, leaderId: true },
  });
}
