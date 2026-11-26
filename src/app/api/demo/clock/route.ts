import { NextResponse } from "next/server";
import { z } from "zod";
import { readyClock } from "@/core/clock";
import { publishEvent } from "@/core/events";
import { db } from "@/db/client";
import { jsonError, parseBody, requireUser } from "@/lib/http";
import { requireAdmin } from "@/lib/require-admin";

const Body = z.union([
  z.object({ advanceMinutes: z.number().finite().min(-60 * 24 * 30).max(60 * 24 * 30) }),
  z.object({ reset: z.literal(true) }),
]);

export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;
  const clk = await readyClock();
  return NextResponse.json({ now: clk.now().toISOString(), mode: clk.mode });
}

/** `POST /api/demo/clock` с `{ advanceMinutes }` или `{ reset: true }` (SPEC 4.7). Только ADMIN: часы общие для всех. */
export async function POST(req: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.res;
  const body = await parseBody(req, Body);
  if (!body.ok) return body.res;
  const clk = await readyClock();
  if (clk.mode === "real") return jsonError(409, "Часы в режиме real: перемотка отключена");

  const now = "reset" in body.data ? await clk.reset() : await clk.advance(body.data.advanceMinutes);

  // Время изменилось у всех: обновить метрики на экранах всех руководителей.
  const leaders = await db.leader.findMany({ select: { id: true } });
  await Promise.all(leaders.map((l) => publishEvent(l.id, { type: "metrics.updated", data: { now: now.toISOString() } })));
  return NextResponse.json({ now: now.toISOString(), mode: clk.mode });
}
