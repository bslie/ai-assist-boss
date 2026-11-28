/**
 * Запись во внешний календарь (SPEC 4.5): создать, перенести, отменить встречу.
 * Всё идёт через Policy Gate. Защищённые блоки и внешние участники никогда не получают ALLOW сами:
 * без `approvedByLeader` возвращаем `approval`, и действие ждёт руководителя.
 * `calendar.update_event` имеет потолок APPROVE, поэтому перенос и отмена всегда требуют `approvedByLeader: true`.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { clock } from "../clock";
import { evaluate, getConnectorToolPermission, loadGateLeader, logVerdict } from "../policy-gate";
import { calendarAccount, createCalendarClient } from "./factory";
import type { GoogleCalendarClient } from "./google";
import { GCAL_PREFIX } from "./sync";

export type WriteResult =
  | { status: "done"; externalId?: string }
  | { status: "approval"; reasons: string[] }
  | { status: "skipped"; reason: string };

export interface WriteOptions {
  /** Руководитель уже согласился (утвердил карточку, сам нажал «перенести»). */
  approvedByLeader?: boolean;
  /** Не приглашать участников: событие создаётся только в календаре руководителя (демо с вымышленными адресами). */
  noInvites?: boolean;
  /** Подмена в тестах: готовый клиент вместо сетевого. */
  client?: Pick<GoogleCalendarClient, "createEvent" | "moveEvent" | "cancelEvent">;
}

type Tool = "calendar.create_event" | "calendar.update_event";

const domain = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";

async function authorize(
  db: PrismaClient,
  leaderId: string,
  tool: Tool,
  m: { id: string; title: string; attendees: unknown },
  opts: WriteOptions,
): Promise<{ ok: true; row: { id: string; leaderId: string; type: string; encryptedConfig: string }; notify: boolean } | { ok: false; res: WriteResult }> {
  const row = await db.connector.findFirst({ where: { leaderId, type: "BUILTIN_GOOGLE_CALENDAR", isActive: true } });
  if (!row) return { ok: false, res: { status: "skipped", reason: "Google Календарь не подключён" } };

  const attendees = Array.isArray(m.attendees) ? (m.attendees as unknown[]).filter((a): a is string => typeof a === "string") : [];
  const own = calendarAccount(row);
  const external = own ? attendees.some((a) => domain(a) !== domain(own)) : attendees.length > 0;

  const perm = await getConnectorToolPermission(db, leaderId, row.id, tool);
  const verdict = evaluate(tool, {
    leader: await loadGateLeader(db, leaderId),
    calendarSlotTitle: m.title,
    toolPermission: perm,
    isOutbound: true,
    // Внешние участники: приглашение уходит наружу от имени руководителя — как обязательство перед клиентом.
    ...(external ? { category: "CLIENT_COMMITMENT", confidence: 1 } : {}),
    approvedByLeader: opts.approvedByLeader,
  });
  await logVerdict(db, leaderId, tool, verdict, { metadata: { meetingId: m.id, approvedByLeader: Boolean(opts.approvedByLeader) } });
  if (verdict.verdict === "DENY") return { ok: false, res: { status: "skipped", reason: verdict.reasons.join("; ") } };
  if (verdict.verdict === "APPROVE" && !opts.approvedByLeader) return { ok: false, res: { status: "approval", reasons: verdict.reasons } };
  return { ok: true, row, notify: attendees.length > 0 };
}

const logCalendar = (db: PrismaClient, leaderId: string, action: string, reason: string, meetingId: string) =>
  db.activityLog.create({ data: { leaderId, createdAt: clock.now(), pipeline: "CALENDAR", action, reason, metadata: { meetingId } } });

/** Создать в Google Календаре встречу, которая пока есть только у нас (например, следующая встреча серии). */
export async function pushNewMeeting(db: PrismaClient, leaderId: string, meetingId: string, opts: WriteOptions = {}): Promise<WriteResult> {
  const m = await db.meeting.findFirst({ where: { id: meetingId, leaderId } });
  if (!m) return { status: "skipped", reason: "встреча не найдена" };
  if (m.externalId) return { status: "skipped", reason: "встреча уже есть во внешнем календаре" };
  const a = await authorize(db, leaderId, "calendar.create_event", m, opts);
  if (!a.ok) return a.res;
  const client = opts.client ?? createCalendarClient(db, a.row);
  if (!client) return { status: "skipped", reason: "Нет доступа к календарю: войдите заново" };
  try {
    const attendees = opts.noInvites ? [] : Array.isArray(m.attendees) ? (m.attendees as string[]) : [];
    const id = await client.createEvent({ title: m.title, start: clock.toReal(m.startAt), end: clock.toReal(m.endAt), attendees, meetingUrl: m.meetingUrl ?? undefined, notify: opts.noInvites ? false : a.notify });
    await db.meeting.updateMany({ where: { id: m.id, leaderId }, data: { externalId: `${GCAL_PREFIX}${id}` } });
    await logCalendar(db, leaderId, "CALENDAR_EVENT_CREATED", `Создала встречу «${m.title}» в Google Календаре`, m.id);
    return { status: "done", externalId: id };
  } catch (e) {
    await logCalendar(db, leaderId, "CALENDAR_WRITE_FAILED", `Не создала «${m.title}» в Google Календаре: ${(e as Error).message}`, m.id);
    return { status: "skipped", reason: (e as Error).message };
  }
}

/** Перенести встречу из Google Календаря. Перенос чужой встречи или защищённого блока — только с `approvedByLeader`. */
export async function moveMeeting(db: PrismaClient, leaderId: string, meetingId: string, startAt: Date, endAt: Date, opts: WriteOptions = {}): Promise<WriteResult> {
  if (!(endAt > startAt)) return { status: "skipped", reason: "конец встречи раньше начала" };
  const m = await db.meeting.findFirst({ where: { id: meetingId, leaderId } });
  if (!m) return { status: "skipped", reason: "встреча не найдена" };
  if (!m.externalId?.startsWith(GCAL_PREFIX)) return { status: "skipped", reason: "встреча не из Google Календаря" };
  const a = await authorize(db, leaderId, "calendar.update_event", m, opts);
  if (!a.ok) return a.res;
  const client = opts.client ?? createCalendarClient(db, a.row);
  if (!client) return { status: "skipped", reason: "Нет доступа к календарю: войдите заново" };
  try {
    await client.moveEvent(m.externalId.slice(GCAL_PREFIX.length), clock.toReal(startAt), clock.toReal(endAt), a.notify);
    await db.meeting.updateMany({ where: { id: m.id, leaderId }, data: { startAt, endAt } });
    await logCalendar(db, leaderId, "CALENDAR_EVENT_MOVED", `Перенесла встречу «${m.title}»`, m.id);
    return { status: "done" };
  } catch (e) {
    await logCalendar(db, leaderId, "CALENDAR_WRITE_FAILED", `Не перенесла «${m.title}»: ${(e as Error).message}`, m.id);
    return { status: "skipped", reason: (e as Error).message };
  }
}

/** Отменить встречу из Google Календаря: участники получат уведомление. */
export async function cancelMeeting(db: PrismaClient, leaderId: string, meetingId: string, opts: WriteOptions = {}): Promise<WriteResult> {
  const m = await db.meeting.findFirst({ where: { id: meetingId, leaderId } });
  if (!m) return { status: "skipped", reason: "встреча не найдена" };
  if (!m.externalId?.startsWith(GCAL_PREFIX)) return { status: "skipped", reason: "встреча не из Google Календаря" };
  const a = await authorize(db, leaderId, "calendar.update_event", m, opts);
  if (!a.ok) return a.res;
  const client = opts.client ?? createCalendarClient(db, a.row);
  if (!client) return { status: "skipped", reason: "Нет доступа к календарю: войдите заново" };
  try {
    await client.cancelEvent(m.externalId.slice(GCAL_PREFIX.length), a.notify);
    // Работа по встрече (протокол, запись) остаётся; пустую встречу убираем.
    if (m.protocolMarkdown || m.transcript || m.recallBotId) await db.meeting.updateMany({ where: { id: m.id, leaderId }, data: { externalId: null } });
    else await db.meeting.deleteMany({ where: { id: m.id, leaderId } });
    await logCalendar(db, leaderId, "CALENDAR_EVENT_CANCELLED", `Отменила встречу «${m.title}»`, m.id);
    return { status: "done" };
  } catch (e) {
    await logCalendar(db, leaderId, "CALENDAR_WRITE_FAILED", `Не отменила «${m.title}»: ${(e as Error).message}`, m.id);
    return { status: "skipped", reason: (e as Error).message };
  }
}
