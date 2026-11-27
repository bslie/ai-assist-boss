/**
 * Следующая встреча серии после утверждённого протокола (SPEC 4.5.1, P1: подбор слота).
 * Слот — то же время через неделю; занят, выходной или защищённый блок → следующий рабочий день.
 * Создание события в календаре проходит Policy Gate: затронутый защищённый блок даёт APPROVE, и встреча
 * не создаётся сама (руководитель увидит причину в журнале).
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { pushNewMeeting, type WriteResult } from "../calendar/write";
import { clock } from "../clock";
import { evaluate, loadGateLeader, logVerdict } from "../policy-gate";
import { defaultParticipation } from "./participation";

const DAY = 86_400_000;
const MAX_SHIFT_DAYS = 14;
export const CALENDAR_TOOL = "calendar.create_event";
const TZ = "Europe/Moscow";

const isWeekend = (d: Date) => {
  const w = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(d);
  return w === "Sat" || w === "Sun";
};

/**
 * Встреча серии появляется и в Google Календаре, если он подключён. Здесь нет `approvedByLeader`:
 * право «Создавать встречи» должно быть AUTO, иначе приглашение не уходит, а причина попадает в журнал.
 * Внешние участники и защищённые блоки шлюз без руководителя не пропускает в любом случае.
 */
async function pushToCalendar(db: PrismaClient, leaderId: string, meetingId: string, title: string): Promise<void> {
  const res = await pushNewMeeting(db, leaderId, meetingId).catch((e): WriteResult => ({ status: "skipped", reason: (e as Error).message }));
  if (res.status === "done" || (res.status === "skipped" && res.reason === "Google Календарь не подключён")) return;
  await db.activityLog.create({
    data: {
      leaderId,
      createdAt: clock.now(),
      pipeline: "CALENDAR",
      action: "NEXT_MEETING_NOT_PUSHED",
      reason: `«${title}» создана только у меня, в Google Календарь не отправила: ${res.status === "approval" ? res.reasons.join("; ") : res.reason}`,
      metadata: { meetingId },
    },
  });
}

export type NextMeetingResult = { status: "created"; meetingId: string; startAt: Date } | { status: "exists" } | { status: "skipped"; reason: string };

export async function scheduleNextMeeting(db: PrismaClient, leaderId: string, meetingId: string): Promise<NextMeetingResult> {
  const m = await db.meeting.findFirst({ where: { id: meetingId, leaderId } });
  if (!m) return { status: "skipped", reason: "встреча не найдена" };

  // Следующая встреча серии уже в календаре (например, ежедневные планёрки из датасета): ничего не создаём.
  const later = await db.meeting.findFirst({ where: { leaderId, title: m.title, startAt: { gt: m.startAt } }, select: { id: true } });
  if (later) return { status: "exists" };

  const leader = await loadGateLeader(db, leaderId);
  const duration = m.endAt.getTime() - m.startAt.getTime();
  const from = new Date(m.startAt.getTime() + 7 * DAY);
  const horizon = new Date(from.getTime() + (MAX_SHIFT_DAYS + 1) * DAY);
  const around = await db.meeting.findMany({ where: { leaderId, startAt: { gte: new Date(from.getTime() - DAY), lt: horizon } }, select: { title: true, startAt: true, endAt: true } });

  const protectedHit = (title: string) => leader.protectedBlocks.some((b) => title.toLowerCase().includes(b.toLowerCase()));
  for (let shift = 0; shift <= MAX_SHIFT_DAYS; shift++) {
    const startAt = new Date(from.getTime() + shift * DAY);
    const endAt = new Date(startAt.getTime() + duration);
    if (isWeekend(startAt)) continue;
    const clash = around.some((o) => o.startAt < endAt && o.endAt > startAt);
    if (clash) continue;
    // Встреча сама про защищённый блок (например, «1:1»): шлюз не даёт создать её без руководителя.
    const verdict = evaluate(CALENDAR_TOOL, { leader, calendarSlotTitle: m.title, toolPermission: "AUTO", approvedByLeader: true /* протокол с «следующей встречей» утверждён */ });
    await logVerdict(db, leaderId, CALENDAR_TOOL, verdict, { metadata: { meetingId, startAt: startAt.toISOString(), protectedTitle: protectedHit(m.title) } });
    if (verdict.verdict !== "ALLOW") {
      await db.activityLog.create({
        data: { leaderId, createdAt: clock.now(), pipeline: "CALENDAR", action: "NEXT_MEETING_SKIPPED", reason: `Следующую встречу «${m.title}» не создала сама: ${verdict.reasons.join("; ")}`, metadata: { meetingId } },
      });
      return { status: "skipped", reason: verdict.reasons.join("; ") };
    }

    const next = await db.meeting.create({
      data: {
        leaderId,
        title: m.title,
        category: m.category,
        startAt,
        endAt,
        meetingUrl: m.meetingUrl,
        attendees: m.attendees as never,
        participationMode: defaultParticipation(m.category, m.title, leader.protectedBlocks),
        previousMeetingId: m.id,
      },
    });
    await db.activityLog.create({
      data: {
        leaderId,
        createdAt: clock.now(),
        pipeline: "CALENDAR",
        action: "NEXT_MEETING_CREATED",
        reason: `Назначила следующую встречу «${m.title}»`,
        savedMinutes: 5, // SPEC 7.3: переписка о времени
        metadata: { meetingId: next.id, previousMeetingId: m.id, startAt: startAt.toISOString() },
      },
    });
    await pushToCalendar(db, leaderId, next.id, m.title);
    return { status: "created", meetingId: next.id, startAt };
  }
  await db.activityLog.create({
    data: { leaderId, createdAt: clock.now(), pipeline: "CALENDAR", action: "NEXT_MEETING_SKIPPED", reason: `Не нашла свободного слота для «${m.title}» в ближайшие ${MAX_SHIFT_DAYS} дней`, metadata: { meetingId } },
  });
  return { status: "skipped", reason: "нет свободного слота" };
}
