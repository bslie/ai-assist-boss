import { NextResponse } from "next/server";
import { listTranscriptNames } from "@/core/meetings/protocol";
import { db } from "@/db/client";
import { requireLeaderId } from "@/lib/http";

/** `GET /api/meetings?leaderId=` — встречи руководителя (для выбора в демо) и доступные резервные транскрипты. */
export async function GET(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  const meetings = await db.meeting.findMany({
    where: { leaderId: auth.leaderId },
    orderBy: { startAt: "asc" },
    select: { id: true, title: true, category: true, startAt: true, endAt: true, participationMode: true, protocolReadyAt: true, isProtocolApproved: true, avatarToken: true },
  });
  return NextResponse.json({ meetings, transcripts: listTranscriptNames() });
}
