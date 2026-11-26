import { NextResponse } from "next/server";
import { readyClock } from "@/core/clock";
import { pollWithPipeline } from "@/core/mail/pipeline";
import { db } from "@/db/client";
import { jsonError, requireLeaderId } from "@/lib/http";

export const maxDuration = 300; // живая модель: до 30 писем подряд

/** `POST /api/connectors/[id]/poll?leaderId=` — «проверить почту сейчас». Автоопрос делает воркер. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  await readyClock();
  const res = await pollWithPipeline(db, auth.leaderId, (await params).id);
  if (!res.ok) return jsonError(res.skipped ? 409 : 502, res.message);
  return NextResponse.json({ fetched: res.fetched, decisions: res.stats.decisionsCreated, archived: res.archived });
}
