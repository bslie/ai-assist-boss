import { NextResponse } from "next/server";
import { z } from "zod";
import { readyClock } from "@/core/clock";
import { generateProtocolDecision } from "@/core/meetings/protocol";
import { db } from "@/db/client";
import { jsonError, parseBody, requireLeaderId } from "@/lib/http";
import { protocolLlm } from "@/lib/web-llm";

export const maxDuration = 300;

const Body = z.object({ transcript: z.string().min(20).max(200_000) });

/** `POST /api/meetings/[id]/transcript?leaderId=` — транскрипт руками (резервный путь без Recall) → карточка протокола. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  const body = await parseBody(req, Body);
  if (!body.ok) return body.res;
  const { id } = await ctx.params;
  await readyClock();
  try {
    const res = await generateProtocolDecision({ db, llm: protocolLlm() }, auth.leaderId, id, body.data.transcript);
    return res.ok ? NextResponse.json(res) : jsonError(409, res.reason);
  } catch (e) {
    return jsonError(502, `Протокол не собран: ${(e as Error).message}`);
  }
}
