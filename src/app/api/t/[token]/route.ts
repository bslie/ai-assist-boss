import { NextResponse } from "next/server";
import { readyClock } from "@/core/clock";
import { TaskLinkAnswerSchema, answerTaskByLink } from "@/core/tasks/email-link";
import { db } from "@/db/client";
import { jsonError, parseBody } from "@/lib/http";

/**
 * `POST /api/t/[token]` — ответ исполнителя по ссылке из письма: `{ action: "accept" }`,
 * `{ action: "clarify", question }`, `{ action: "reschedule", date, reason }`. Без входа: секрет — подписанный токен.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const body = await parseBody(req, TaskLinkAnswerSchema);
  if (!body.ok) return body.res;
  await readyClock();
  const res = await answerTaskByLink(db, token, body.data);
  return res.ok ? NextResponse.json(res) : jsonError(res.code === "NOT_FOUND" ? 404 : 400, res.message);
}
