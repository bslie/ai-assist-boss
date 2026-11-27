import { NextResponse } from "next/server";
import { syncCalendar } from "@/core/calendar/sync";
import { readyClock } from "@/core/clock";
import { pollWithPipeline } from "@/core/mail/pipeline";
import { db } from "@/db/client";
import { jsonError, requireLeaderId } from "@/lib/http";

export const maxDuration = 300; // живая модель: до 30 писем подряд

/** `POST /api/connectors/[id]/poll?leaderId=` — «проверить сейчас» (почта или календарь). Автоопрос делает воркер. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  await readyClock();
  const id = (await params).id;

  const row = await db.connector.findFirst({ where: { id, leaderId: auth.leaderId }, select: { type: true } });
  if (row?.type === "BUILTIN_GOOGLE_CALENDAR") {
    const cal = await syncCalendar(db, auth.leaderId, id);
    if (!cal.ok) return jsonError(cal.skipped ? 409 : 502, cal.message);
    return NextResponse.json({ fetched: cal.fetched, decisions: 0, archived: 0, updated: cal.updated, removed: cal.removed });
  }

  const res = await pollWithPipeline(db, auth.leaderId, id);
  if (!res.ok) return jsonError(res.skipped ? 409 : 502, res.message);
  return NextResponse.json({ fetched: res.fetched, decisions: res.stats.decisionsCreated, archived: res.archived });
}
