import { NextResponse } from "next/server";
import { z } from "zod";
import { readyClock } from "@/core/clock";
import { joinMeetingNow } from "@/core/meetings/recall";
import { db } from "@/db/client";
import { jsonError, parseBody, requireLeaderId } from "@/lib/http";

const Body = z.object({ url: z.string().max(2000) });

/** `POST /api/meetings/[id]/join?leaderId=` — отправить ИИ-помощника на встречу по ссылке (Zoom, Meet, Teams, Webex, GoTo). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  const body = await parseBody(req, Body);
  if (!body.ok) return body.res;
  const { id } = await ctx.params;
  await readyClock();
  const res = await joinMeetingNow(db, auth.leaderId, id, body.data.url);
  if (res.status === "rejected") return jsonError(400, res.reason);
  if (res.status === "failed") return jsonError(502, res.reason);
  return NextResponse.json(res);
}
