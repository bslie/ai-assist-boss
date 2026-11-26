import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { readyClock } from "@/core/clock";
import { generateProtocolDecision } from "@/core/meetings/protocol";
import { fetchBotTranscript, loadRecallAuth } from "@/core/meetings/recall";
import { db } from "@/db/client";
import { jsonError } from "@/lib/http";
import { protocolLlm } from "@/lib/web-llm";

export const maxDuration = 300;

const Event = z.object({ event: z.string(), data: z.object({ bot: z.object({ id: z.string() }).passthrough().optional(), bot_id: z.string().optional() }).passthrough() }).passthrough();

const sameSecret = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * `POST /api/recall/webhook?secret=` — вебхук Recall о завершении встречи → транскрипт → карточка протокола.
 * Без настроенного RECALL_WEBHOOK_SECRET вебхук закрыт (fail closed): адрес публичный, а запрос запускает LLM.
 */
export async function POST(req: Request) {
  const expected = process.env.RECALL_WEBHOOK_SECRET;
  const given = new URL(req.url).searchParams.get("secret") ?? "";
  if (!expected || !sameSecret(given, expected)) return jsonError(401, "Нет доступа");

  const parsed = Event.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "Невалидное событие");
  // Нужны только события окончания: транскрипт готов или бот закончил запись.
  if (!/^(bot\.done|transcript\.done|bot\.call_ended)$/.test(parsed.data.event)) return NextResponse.json({ ignored: parsed.data.event });
  const botId = parsed.data.data.bot?.id ?? parsed.data.data.bot_id;
  if (!botId) return jsonError(400, "В событии нет id бота");

  const meeting = await db.meeting.findFirst({ where: { recallBotId: botId }, select: { id: true, leaderId: true } });
  if (!meeting) return NextResponse.json({ ignored: "бот не из нашей встречи" });
  await readyClock();
  try {
    const auth = await loadRecallAuth(db, meeting.leaderId);
    if (!auth) return jsonError(503, "Recall не подключён");
    const transcript = await fetchBotTranscript(auth, botId);
    const res = await generateProtocolDecision({ db, llm: protocolLlm() }, meeting.leaderId, meeting.id, transcript);
    return NextResponse.json(res);
  } catch (e) {
    return jsonError(502, `Протокол не собран: ${(e as Error).message}`);
  }
}
