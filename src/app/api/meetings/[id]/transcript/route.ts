import { NextResponse } from "next/server";
import { z } from "zod";
import { readyClock } from "@/core/clock";
import { generateProtocolDecision } from "@/core/meetings/protocol";
import { fetchBotTranscript, loadRecallAuth } from "@/core/meetings/recall";
import { db } from "@/db/client";
import { jsonError, parseBody, requireLeaderId } from "@/lib/http";
import { protocolLlm } from "@/lib/web-llm";

export const maxDuration = 300;

const Body = z.object({ transcript: z.string().min(20).max(200_000).optional() });

/**
 * `POST /api/meetings/[id]/transcript?leaderId=` — карточка протокола из транскрипта.
 * С `transcript` — текст руками (Телемост, Dion, без Recall). Без него — забираем у Recall по боту встречи:
 * путь, когда вебхук не настроен или не дошёл.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  const body = await parseBody(req, Body);
  if (!body.ok) return body.res;
  const { id } = await ctx.params;
  await readyClock();
  try {
    let transcript = body.data.transcript;
    if (!transcript) {
      const meeting = await db.meeting.findFirst({ where: { id, leaderId: auth.leaderId }, select: { recallBotId: true } });
      if (!meeting) return jsonError(404, "Встреча не найдена");
      if (!meeting.recallBotId || meeting.recallBotId.startsWith("pending:")) return jsonError(409, "На этой встрече не было бота Recall: вставьте транскрипт текстом");
      const recall = await loadRecallAuth(db, auth.leaderId);
      if (!recall) return jsonError(503, "Recall не подключён");
      transcript = await fetchBotTranscript(recall, meeting.recallBotId);
    }
    const res = await generateProtocolDecision({ db, llm: protocolLlm() }, auth.leaderId, id, transcript);
    return res.ok ? NextResponse.json(res) : jsonError(409, res.reason);
  } catch (e) {
    return jsonError(502, `Протокол не собран: ${(e as Error).message}`);
  }
}
