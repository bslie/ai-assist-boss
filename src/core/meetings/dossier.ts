/**
 * Досье перед 1:1 и встречей с партнёром (SPEC 4.5.4, P2): за 15 минут до начала руководителю уходят
 * открытые задачи участников, просрочки и их последние письма. Детерминированно, факты только из БД.
 * Сообщение получает только сам руководитель (его LEADER-чаты), поэтому шлюз не нужен.
 */
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { clock } from "../clock";
import { esc, type Messenger } from "../telegram/types";

const LEAD_MS = 15 * 60_000;
const DOSSIER_CATEGORIES = ["ONE_ON_ONE", "PARTNER"];
const TZ = "Europe/Moscow";
const fmtDay = (d: Date) => new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, day: "numeric", month: "long" }).format(d);
const fmtTime = (d: Date) => new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(d);

export async function dueDossiers(db: PrismaClient, at: Date = clock.now()): Promise<{ id: string; leaderId: string }[]> {
  const meetings = await db.meeting.findMany({
    where: { category: { in: DOSSIER_CATEGORIES }, startAt: { gt: at, lte: new Date(at.getTime() + LEAD_MS) } },
    select: { id: true, leaderId: true },
  });
  const out: { id: string; leaderId: string }[] = [];
  for (const m of meetings) {
    const sent = await db.activityLog.count({ where: { leaderId: m.leaderId, action: "DOSSIER_SENT", metadata: { path: ["meetingId"], equals: m.id } } });
    if (sent === 0) out.push(m);
  }
  return out;
}

export async function buildDossier(db: PrismaClient, leaderId: string, meetingId: string, at: Date = clock.now()): Promise<string | null> {
  const meeting = await db.meeting.findFirst({ where: { id: meetingId, leaderId } });
  if (!meeting) return null;
  const parsed = z.array(z.string()).safeParse(meeting.attendees);
  const emails = (parsed.success ? parsed.data : []).map((e) => e.toLowerCase());

  const people = emails.length ? await db.employee.findMany({ where: { leaderId, email: { in: emails, mode: "insensitive" } }, select: { id: true, name: true, email: true } }) : [];
  const tasks = people.length
    ? await db.task.findMany({ where: { leaderId, assigneeId: { in: people.map((p) => p.id) }, status: { not: "DONE" } }, include: { assignee: { select: { name: true } } }, orderBy: { dueAt: "asc" } })
    : [];
  const isOverdue = (t: (typeof tasks)[number]) => t.dueAt < at || t.csvStatus === "просрочена";
  const overdue = tasks.filter(isOverdue);
  const open = tasks.filter((t) => !isOverdue(t));
  const mails = emails.length
    ? await db.emailItem.findMany({ where: { leaderId, senderEmail: { in: emails, mode: "insensitive" }, occurrence: 1 }, orderBy: { receivedAt: "desc" }, take: 5, select: { subject: true, receivedAt: true, senderName: true } })
    : [];

  const who = people.length ? people.map((p) => p.name).join(", ") : emails.join(", ") || "участники не указаны";
  const lines = [`<b>Досье перед встречей «${esc(meeting.title)}»</b> в ${esc(fmtTime(meeting.startAt))}`, `Участники: ${esc(who)}`];
  if (overdue.length) lines.push("", "<b>Просрочено</b>", ...overdue.map((t) => `• ${esc(t.title)} (${esc(t.assignee?.name ?? "")}, срок ${esc(fmtDay(t.dueAt))})`));
  if (open.length) lines.push("", "<b>Открытые задачи</b>", ...open.map((t) => `• ${esc(t.title)} (${esc(t.assignee?.name ?? "")}, до ${esc(fmtDay(t.dueAt))})`));
  if (tasks.length === 0) lines.push("", "Открытых задач у участников нет.");
  if (mails.length) lines.push("", "<b>Последние письма</b>", ...mails.map((m) => `• ${esc(fmtDay(m.receivedAt))}: ${esc(m.subject)}`));
  return lines.join("\n");
}

/** Отправка досье руководителю один раз на встречу (отметка в журнале ставится до отправки). */
export async function sendDossier(db: PrismaClient, messenger: Messenger, leaderId: string, meetingId: string): Promise<"sent" | "no_chat" | "skipped"> {
  const done = await db.activityLog.count({ where: { leaderId, action: "DOSSIER_SENT", metadata: { path: ["meetingId"], equals: meetingId } } });
  if (done > 0) return "skipped";
  const text = await buildDossier(db, leaderId, meetingId);
  if (!text) return "skipped";
  const chats = await db.telegramBinding.findMany({ where: { leaderId, role: "LEADER" }, select: { chatId: true } });
  const unique = [...new Set(chats.map((c) => c.chatId))];
  if (unique.length === 0) return "no_chat"; // без чата не отмечаем: появится чат — досье ещё успеет уйти
  await db.activityLog.create({ data: { leaderId, createdAt: clock.now(), pipeline: "MEETING", action: "DOSSIER_SENT", reason: "Отправила досье перед встречей", metadata: { meetingId } } });
  for (const chatId of unique) await messenger.send(chatId, text).catch(() => {});
  return "sent";
}
