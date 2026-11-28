import { NextResponse } from "next/server";
import { z } from "zod";
import { publishEvent } from "@/core/events";
import { resetLeaderToFirstRun } from "@/core/profile/reset";
import { db } from "@/db/client";
import { jsonError, parseBody } from "@/lib/http";
import { requireAdmin } from "@/lib/require-admin";

const Body = z.object({ confirm: z.literal(true) });

/**
 * `POST /api/control/users/[id]/reset` с `{ confirm: true }` — вернуть руководителя пользователя к первому входу.
 * Только ADMIN. Необратимо: подключения и история разбора удаляются.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.res;
  const body = await parseBody(req, Body);
  if (!body.ok) return body.res;
  const { id } = await ctx.params;
  const user = await db.appUser.findUnique({ where: { id }, select: { leaderId: true, login: true } });
  if (!user) return jsonError(404, "Пользователь не найден");
  if (!user.leaderId) return jsonError(409, "У этой учётной записи нет руководителя: сбрасывать нечего");
  const report = await resetLeaderToFirstRun(db, user.leaderId);
  await publishEvent(user.leaderId, { type: "metrics.updated", data: {} });
  return NextResponse.json({ ok: true, report });
}
