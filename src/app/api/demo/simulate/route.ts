import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { readyClock } from "@/core/clock";
import { PROFILES_DIR, loadInbox } from "@/core/dataset";
import { ingestEmails } from "@/core/email-triage/ingest";
import { publishEvent } from "@/core/events";
import { createDraftGenerator } from "@/core/learning/draft";
import { createCriteriaGenerator } from "@/core/tasks/criteria";
import { generateProtocolDecision, listTranscriptNames, loadTranscript } from "@/core/meetings/protocol";
import { LlmClient } from "@/core/llm";
import { dbUsageSink } from "@/core/llm/usage-db";
import { FileCache } from "@/core/llm/file-cache";
import { createProviderOrReplay } from "@/core/llm/providers";
import { db } from "@/db/client";
import { jsonError, parseBody, requireLeaderId } from "@/lib/http";
import { protocolLlm } from "@/lib/web-llm";

export const maxDuration = 300; // живая модель: ~17 последовательных вызовов

const Body = z.object({
  scenario: z.enum(["INGEST_DATASET", "TRIGGER_MORNING", "TRIGGER_EMAIL_BATCH", "RUN_MEETING_TRANSCRIPT", "TRIGGER_WEEKLY"]),
  transcriptName: z.string().optional(),
  /** Для RUN_MEETING_TRANSCRIPT: конкретная встреча; иначе по заголовку транскрипта «# meeting: <название>». */
  meetingId: z.string().optional(),
});

/** Первая строка транскрипта: «# meeting: Название встречи». */
const HEADER_RE = /^# meeting:[ \t]*(.+?)[ \t]*(?:\r?\n|$)/;

const CACHE_FILE =path.resolve(process.cwd(), process.env.LLM_CACHE_FILE ?? "tests/fixtures/llm-cache.json");
const DRAFT_CACHE_FILE = path.resolve(process.cwd(), "data/cache/llm-drafts.json");

/**
 * `POST /api/demo/simulate?leaderId=` — запуск демо-сценариев.
 * INGEST_DATASET / TRIGGER_EMAIL_BATCH — разбор писем (живая LLM или кэш); RUN_MEETING_TRANSCRIPT — протокол;
 * TRIGGER_MORNING / TRIGGER_WEEKLY — рутина уходит воркеру событием, Telegram есть только у него.
 */
export async function POST(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  // Сценарии гоняют живую LLM и пишут в БД: только для панели администратора.
  if (auth.user.role !== "ADMIN") return jsonError(403, "Нужна роль администратора");
  const body = await parseBody(req, Body);
  if (!body.ok) return body.res;

  if (body.data.scenario === "RUN_MEETING_TRANSCRIPT") {
    const clk = await readyClock();
    try {
      const name = body.data.transcriptName ?? listTranscriptNames()[0];
      if (!name) return jsonError(404, "В data/transcripts нет ни одного транскрипта");
      const raw = loadTranscript(name);
      const title = HEADER_RE.exec(raw)?.[1]?.trim();
      const transcript = raw.replace(HEADER_RE, "");
      const candidates = await db.meeting.findMany({
        where: { leaderId: auth.leaderId, isProtocolApproved: false, ...(body.data.meetingId ? { id: body.data.meetingId } : title ? { title } : {}) },
        orderBy: { startAt: "asc" },
        select: { id: true, endAt: true },
      });
      const now = clk.now();
      const meeting = [...candidates].reverse().find((m) => m.endAt <= now) ?? candidates[0];
      if (!meeting) return jsonError(404, "Подходящая встреча не найдена");
      const res = await generateProtocolDecision({ db, llm: protocolLlm() }, auth.leaderId, meeting.id, transcript);
      return res.ok ? NextResponse.json({ scenario: body.data.scenario, ...res }) : jsonError(409, res.reason);
    } catch (e) {
      return jsonError(502, `Протокол не собран: ${(e as Error).message}`);
    }
  }

  if (body.data.scenario === "TRIGGER_MORNING" || body.data.scenario === "TRIGGER_WEEKLY") {
    const code = body.data.scenario === "TRIGGER_MORNING" ? "MORNING_DIGEST" : "WEEKLY_REPORT";
    const leaderChatBound = (await db.telegramBinding.count({ where: { leaderId: auth.leaderId, role: "LEADER" } })) > 0;
    await publishEvent(auth.leaderId, { type: "routine.trigger", data: { code } });
    // Отправку делает воркер: без него и без привязанного чата сообщение не придёт, и это видно в ответе.
    return NextResponse.json({ scenario: body.data.scenario, queued: true, routine: code, leaderChatBound });
  }

  await readyClock();
  let provider;
  try {
    provider = createProviderOrReplay();
  } catch (e) {
    return jsonError(503, `LLM не настроена: ${(e as Error).message}`);
  }
  const llm = new LlmClient({ provider, cache: new FileCache(CACHE_FILE), usage: dbUsageSink(db) });
  // Черновики кэшируются отдельно от фикстур eval: повторная загрузка датасета не тратит токены.
  const draftLlm = new LlmClient({ provider, cache: new FileCache(DRAFT_CACHE_FILE), usage: dbUsageSink(db) });

  try {
    // Основной датасет или небольшая добавленная пачка (порог бюджета, повтор, обращение клиента): в eval она не входит.
    const mails = body.data.scenario === "TRIGGER_EMAIL_BATCH" ? loadInbox(PROFILES_DIR, "extra_inbox.csv") : loadInbox();
    const stats = await ingestEmails(db, llm, auth.leaderId, mails, {
      emit: (e) => publishEvent(auth.leaderId, e),
      draft: createDraftGenerator(db, draftLlm),
      criteria: createCriteriaGenerator(draftLlm),
    });
    await publishEvent(auth.leaderId, { type: "metrics.updated", data: {} });
    return NextResponse.json({ scenario: body.data.scenario, stats });
  } catch (e) {
    return jsonError(502, `Разбор почты не удался: ${(e as Error).message}`);
  }
}
