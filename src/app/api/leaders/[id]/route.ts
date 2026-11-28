import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteLeader } from "@/core/profile/delete";
import { db } from "@/db/client";
import { jsonError, parseBody } from "@/lib/http";
import { requireAdmin } from "@/lib/require-admin";

const Body = z.object({ confirm: z.literal(true) });

/** `DELETE /api/leaders/[id]` с `{ confirm: true }` — удалить руководителя со всеми данными (только ADMIN, необратимо). */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.res;
  const body = await parseBody(req, Body);
  if (!body.ok) return body.res;
  const { id } = await ctx.params;
  const exists = await db.leader.findUnique({ where: { id }, select: { id: true } });
  if (!exists) return jsonError(404, "Руководитель не найден");
  const res = await deleteLeader(db, id);
  return NextResponse.json({ ok: true, ...res });
}
