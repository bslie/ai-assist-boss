import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { pushNewMeeting } from "@/core/calendar/write";
import { readyClock } from "@/core/clock";
import { PROFILES_DIR, loadInbox } from "@/core/dataset";
import { ingestEmails } from "@/core/email-triage/ingest";
import { publishEvent } from "@/core/events";
import { createDraftGenerator } from "@/core/learning/draft";
import { LlmClient } from "@/core/llm";
import { FileCache } from "@/core/llm/file-cache";
import { createProviderOrReplay } from "@/core/llm/providers";
import { dbUsageSink } from "@/core/llm/usage-db";
import { detectPlatform, MeetingUrlSchema } from "@/core/meetings/platform";
import { createCriteriaGenerator } from "@/core/tasks/criteria";
import { db } from "@/db/client";
import { jsonError, parseBody, requireLeaderId } from "@/lib/http";

export const maxDuration = 300;

const CACHE_FILE = path.resolve(process.cwd(), process.env.LLM_CACHE_FILE ?? "tests/fixtures/llm-cache.json");
const DRAFT_CACHE_FILE = path.resolve(process.cwd(), "data/cache/llm-drafts.json");

const Body = z.discriminatedUnion("action", [
  /** «Написали в Telegram, бот ответил»: вопрос уходит боту в чат руководителя, ответ приходит туда же. */
  z.object({ action: z.literal("TELEGRAM"), text: z.string().trim().min(1).max(500) }),
  /** «Написали на почту N писем»: следующие N писем датасета, которых в ящике ещё не было. */
  z.object({ action: z.literal("EMAILS"), count: z.number().int().min(1).max(20) }),
  /** «Поставили встречу в календарь с ссылкой на Zoom». */
  z.object({
    action: z.literal("MEETING"),
    title: z.string().trim().min(1).max(200).default("Созвон по статусу проекта"),
    zoomUrl: MeetingUrlSchema,
    startInMinutes: z.number().int().min(1).max(24 * 60).default(10),
    durationMinutes: z.number().int().min(10).max(240).default(30),
  }),
]);

/**
 * `POST /api/demo/stage?leaderId=` — действия меню маскота для живого показа. Только администратор:
 * они пишут в БД руководителя и тратят бюджет модели. Любая внешняя мутация идёт через обычные пути (Policy Gate, карточки).
 */
export async function POST(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  if (auth.user.role !== "ADMIN") return jsonError(403, "Нужна роль администратора");
  const body = await parseBody(req, Body);
  if (!body.ok) return body.res;
  const { leaderId } = auth;
  const clk = await readyClock();
  const input = body.data;

  if (input.action === "TELEGRAM") {
    const bound = await db.telegramBinding.count({ where: { leaderId, role: "LEADER" } });
    if (bound === 0) return jsonError(409, "Telegram руководителя не привязан: откройте бота по ссылке привязки (npm run tg:link)");
    await publishEvent(leaderId, { type: "demo.telegram_chat", data: { text: input.text } });
    return NextResponse.json({ action: input.action, queued: true });
  }

  if (input.action === "EMAILS") {
    let provider;
    try {
      provider = createProviderOrReplay();
    } catch (e) {
      return jsonError(503, `LLM не настроена: ${(e as Error).message}`);
    }
    const llm = new LlmClient({ provider, cache: new FileCache(CACHE_FILE), usage: dbUsageSink(db) });
    const draftLlm = new LlmClient({ provider, cache: new FileCache(DRAFT_CACHE_FILE), usage: dbUsageSink(db) });
    // Берём письма, которых у руководителя ещё нет: сначала добавочная пачка, потом основной датасет. Повторы не тратят токены.
    const have = new Set(
      (await db.emailItem.findMany({ where: { leaderId, externalId: { not: null } }, select: { externalId: true } })).map((e) => e.externalId as string),
    );
    const pool = [...loadInbox(PROFILES_DIR, "extra_inbox.csv"), ...loadInbox()];
    const fresh = pool.filter((m) => !have.has(m.externalId)).slice(0, input.count);
    if (fresh.length === 0) return jsonError(409, "Письма датасета закончились: сбросьте данные стенда (npm run db:seed)");
    try {
      // Письма приходят «сейчас»: иначе в «Разговоре» они выглядели бы старыми.
      const mails = fresh.map((m, i) => ({ ...m, receivedAt: new Date(clk.now().getTime() - (fresh.length - i) * 60_000) }));
      const stats = await ingestEmails(db, llm, leaderId, mails, {
        emit: (e) => publishEvent(leaderId, e),
        draft: createDraftGenerator(db, draftLlm),
        criteria: createCriteriaGenerator(draftLlm),
      });
      await publishEvent(leaderId, { type: "metrics.updated", data: {} });
      return NextResponse.json({ action: input.action, requested: input.count, ingested: stats.processed, decisions: stats.decisionsCreated, left: pool.filter((m) => !have.has(m.externalId)).length - fresh.length });
    } catch (e) {
      return jsonError(502, `Разбор почты не удался: ${(e as Error).message}`);
    }
  }

  // MEETING
  const attendees = (await db.employee.findMany({ where: { leaderId }, orderBy: { name: "asc" }, take: 3, select: { email: true } })).map((e) => e.email);
  const startAt = new Date(clk.now().getTime() + input.startInMinutes * 60_000);
  const endAt = new Date(startAt.getTime() + input.durationMinutes * 60_000);
  const platform = detectPlatform(input.zoomUrl);
  const meeting = await db.meeting.create({
    data: {
      leaderId,
      title: input.title,
      category: "OPERATIONAL",
      startAt,
      endAt,
      meetingUrl: input.zoomUrl,
      attendees,
      // Формальная встреча: на неё идёт ИИ-помощник (бот Recall заходит по ссылке, пока руководитель занят).
      participationMode: "AVATAR",
    },
  });
  // Если Google Календарь подключён, встреча появится и там (через Policy Gate), но без приглашений: адреса сотрудников в демо вымышленные.
  const calendar = await pushNewMeeting(db, leaderId, meeting.id, { approvedByLeader: true, noInvites: true }).catch((e) => ({ status: "skipped" as const, reason: (e as Error).message }));
  await publishEvent(leaderId, { type: "metrics.updated", data: {} });
  return NextResponse.json({
    action: input.action,
    meetingId: meeting.id,
    platform: platform.label,
    botSupported: platform.botSupported,
    calendar: calendar.status === "done" ? "created" : calendar.status === "approval" ? "needs_approval" : `skipped: ${calendar.reason}`,
  });
}
