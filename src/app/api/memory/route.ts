import { NextResponse } from "next/server";
import { z } from "zod";
import { forgetMemory, listLearned } from "@/core/memory";
import { db } from "@/db/client";
import { jsonError, parseBody, requireLeaderId } from "@/lib/http";

/** `GET /api/memory?leaderId=` — выученные правила руководителя. */
export async function GET(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  return NextResponse.json({ rules: await listLearned(db, auth.leaderId) });
}

/** `DELETE /api/memory?leaderId=` с `{ id }` — «Забыть» правило. */
export async function DELETE(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  const body = await parseBody(req, z.object({ id: z.string().min(1) }));
  if (!body.ok) return body.res;
  return (await forgetMemory(db, auth.leaderId, body.data.id))
    ? NextResponse.json({ ok: true })
    : jsonError(404, "Правило не найдено");
}
