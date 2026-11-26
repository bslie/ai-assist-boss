import { NextResponse } from "next/server";
import { PatchRoutineSchema, listRoutines, patchRoutine } from "@/core/routines";
import { db } from "@/db/client";
import { jsonError, parseBody, requireLeaderId } from "@/lib/http";

/** `GET /api/routines?leaderId=` — рутины и их расписание (демо-время). */
export async function GET(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  return NextResponse.json({ routines: await listRoutines(db, auth.leaderId) });
}

/** `PATCH /api/routines?leaderId=` — `{ id, isActive?, cronExpression? }`. */
export async function PATCH(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  const body = await parseBody(req, PatchRoutineSchema);
  if (!body.ok) return body.res;
  const res = await patchRoutine(db, auth.leaderId, body.data);
  return res.ok ? NextResponse.json({ ok: true }) : jsonError(res.code === "NOT_FOUND" ? 404 : 400, res.message);
}
