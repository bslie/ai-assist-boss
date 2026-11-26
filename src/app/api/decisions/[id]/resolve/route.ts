import { NextResponse } from "next/server";
import { ResolveSchema, resolveDecision } from "@/core/decisions";
import { db } from "@/db/client";
import { jsonError, parseBody, requireLeaderId } from "@/lib/http";

/** `POST /api/decisions/[id]/resolve?leaderId=` — решение руководителя по карточке. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  const body = await parseBody(req, ResolveSchema);
  if (!body.ok) return body.res;

  const { id } = await params;
  const res = await resolveDecision(db, auth.leaderId, id, body.data);
  if (res.ok) return NextResponse.json({ status: res.status });
  const status = res.code === "NOT_FOUND" ? 404 : res.code === "ALREADY_RESOLVED" ? 409 : 422;
  return jsonError(status, res.message);
}
