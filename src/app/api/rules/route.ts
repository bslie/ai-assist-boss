import { NextResponse } from "next/server";
import { CreateRuleSchema, PatchSchema, createRule, listRules, patchRules } from "@/core/rules";
import { db } from "@/db/client";
import { jsonError, parseBody, requireLeaderId } from "@/lib/http";

const statusFor = (code: "NOT_FOUND" | "LOCKED" | "INVALID") => (code === "NOT_FOUND" ? 404 : code === "INVALID" ? 400 : 403);

export async function GET(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  return NextResponse.json(await listRules(db, auth.leaderId));
}

export async function POST(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  const body = await parseBody(req, CreateRuleSchema);
  if (!body.ok) return body.res;
  const res = await createRule(db, auth.leaderId, body.data);
  return res.ok ? NextResponse.json(res.value, { status: 201 }) : jsonError(statusFor(res.code), res.message);
}

/** `{ kind: "rule", id, patch }` или `{ kind: "settings", budgetAutoLimit?, protectedBlocks? }`. */
export async function PATCH(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  const body = await parseBody(req, PatchSchema);
  if (!body.ok) return body.res;
  const res = await patchRules(db, auth.leaderId, body.data);
  return res.ok ? NextResponse.json({ ok: true }) : jsonError(statusFor(res.code), res.message);
}
