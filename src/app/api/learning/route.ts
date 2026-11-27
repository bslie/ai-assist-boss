import { NextResponse } from "next/server";
import { LearningPatchSchema, getLearningStatus, patchLearning } from "@/core/learning/mode";
import { db } from "@/db/client";
import { jsonError, parseBody, requireLeaderId } from "@/lib/http";

/** `GET /api/learning?leaderId=` — режим обучения: счётчик решений без правок, доверенные области, предложения. */
export async function GET(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  return NextResponse.json(await getLearningStatus(db, auth.leaderId));
}

/** `PATCH /api/learning?leaderId=` — `{ kind: "mode", enabled }` или `{ kind: "trust", scope, trusted }`. */
export async function PATCH(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  const body = await parseBody(req, LearningPatchSchema);
  if (!body.ok) return body.res;
  const res = await patchLearning(db, auth.leaderId, body.data);
  return res.ok ? NextResponse.json(res) : jsonError(400, res.message);
}
