import { NextResponse } from "next/server";
import { buildAvatarScript, prepareAgenda } from "@/core/meetings/agenda";
import { db } from "@/db/client";
import { jsonError } from "@/lib/http";

/** Публичный сценарий аватара по токену встречи: страница открывается камерой Recall без входа. Токен — единственный секрет. */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const meeting = await db.meeting.findUnique({ where: { avatarToken: token }, include: { leader: { select: { name: true } } } });
  if (!meeting) return jsonError(404, "Встреча не найдена");
  const questions = await prepareAgenda(db, meeting.leaderId, meeting.id);
  return NextResponse.json({
    leaderName: meeting.leader.name,
    title: meeting.title,
    lines: buildAvatarScript({ leaderName: meeting.leader.name, meetingTitle: meeting.title, questions }),
  });
}
