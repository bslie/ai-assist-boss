import { NextResponse } from "next/server";
import { removeConnector, updateConnector, UpdateSchema } from "@/core/connectors/service";
import { db } from "@/db/client";
import { jsonError, parseBody, requireLeaderId } from "@/lib/http";

const STATUS = { NOT_FOUND: 404, INVALID: 422, CONFLICT: 409, UNAVAILABLE: 503 } as const;

/** `PATCH /api/connectors/[id]?leaderId=` — включить/выключить, переименовать, сменить доступы, права инструментов. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  const body = await parseBody(req, UpdateSchema);
  if (!body.ok) return body.res;
  const res = await updateConnector(db, auth.leaderId, (await params).id, body.data);
  return res.ok ? NextResponse.json({ ok: true }) : jsonError(STATUS[res.code], res.message);
}

/** `DELETE /api/connectors/[id]?leaderId=` — отключить и стереть сохранённые доступы. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  const res = await removeConnector(db, auth.leaderId, (await params).id);
  return res.ok ? NextResponse.json({ ok: true }) : jsonError(STATUS[res.code], res.message);
}
