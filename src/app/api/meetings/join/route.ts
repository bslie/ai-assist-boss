import { NextResponse } from "next/server";
import { z } from "zod";
import { readyClock } from "@/core/clock";
import { joinByLink } from "@/core/meetings/recall";
import { db } from "@/db/client";
import { jsonError, parseBody, requireLeaderId } from "@/lib/http";

const Body = z.object({ url: z.string().max(2000), meetingId: z.string().min(1).max(64).optional() });

/** `POST /api/meetings/join?leaderId=` — ИИ-помощник заходит по ссылке; без `meetingId` создаётся разовая встреча. */
export async function POST(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  const body = await parseBody(req, Body);
  if (!body.ok) return body.res;
  await readyClock();
  const res = await joinByLink(db, auth.leaderId, body.data);
  if (res.status === "rejected") return jsonError(400, res.reason);
  if (res.status === "failed") return jsonError(502, res.reason);
  return NextResponse.json(res);
}
