/**
 * Исполнение утверждённого протокола (SPEC 4.5.1): рассылка участникам, поручения исполнителям.
 * Всё внешнее идёт через Policy Gate: письмо — как `mail.send_reply` (запрет прав подключения останавливает),
 * поручения создаются как Task, а их отправка исполнителям сама проходит шлюз (tasks/dispatch).
 * Следующая встреча серии создаётся подбором слота (next.ts) после поручений и рассылки.
 */
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { clock } from "../clock";
import { publishEvent } from "../events";
import { ensureSignature } from "../learning/draft";
import { createMailConnector, isMailType, MAIL_TYPES } from "../mail/factory";
import type { MailConnector } from "../mail/types";
import { scheduleNextMeeting, type NextMeetingResult } from "./next";
import { evaluate, getConnectorToolPermission, loadGateLeader, logVerdict } from "../policy-gate";

const DAY = 86_400_000;
const DEFAULT_SAVED_MINUTES = 30; // SPEC 7.3: «Протокол встречи»

const PayloadSchema = z.object({
  tool: z.literal("meeting.protocol"),
  args: z.object({
    meetingId: z.string().min(1),
    assignments: z
      .array(
        z.object({
          task: z.string().min(3),
          assigneeName: z.string(),
          assigneeId: z.string().nullable(),
          dueDate: z.string().nullable(),
          criteria: z.string().min(3),
        }),
      )
      .max(20),
    previousUpdates: z
      .array(
        z.object({
          taskId: z.string().min(1),
          outcome: z.enum(["DONE", "IN_PROGRESS", "NOT_RESOLVED", "CHANGED"]),
          comment: z.string(),
          newTitle: z.string().min(3).nullable(),
          newDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
        }),
      )
      .max(20)
      .default([]),
  }),
});

type PreviousUpdate = z.infer<typeof PayloadSchema>["args"]["previousUpdates"][number];

/**
 * Итоги встречи по прошлым поручениям: руководитель уже утвердил их вместе с протоколом.
 * Только задачи этого руководителя и только открытые; выполненные не трогаем.
 * Новый срок считается переносом (rescheduleCount), чтобы метрика «с первого раза» оставалась честной.
 */
async function applyPreviousUpdates(db: PrismaClient, leaderId: string, meetingTitle: string, updates: readonly PreviousUpdate[]): Promise<number> {
  if (!updates.length) return 0;
  const gate = evaluate("task.update", { leader: await loadGateLeader(db, leaderId), isOutbound: false, approvedByLeader: true, trustScope: "TASK_ASSIGN" });
  await logVerdict(db, leaderId, "task.update", gate, { metadata: { kind: "protocol_previous_updates", count: updates.length } });
  if (gate.verdict === "DENY") return 0;

  const day = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long" }).format(clock.now());
  let applied = 0;
  for (const u of updates) {
    const task = await db.task.findFirst({ where: { id: u.taskId, leaderId, status: { not: "DONE" } } });
    if (!task) continue;
    const label = { DONE: "выполнено", IN_PROGRESS: "в работе", NOT_RESOLVED: "не решено", CHANGED: "задача изменилась" }[u.outcome];
    const note = `\n\nВстреча «${meetingTitle}», ${day}: ${label}${u.comment ? `. ${u.comment}` : ""}`;
    const newDue = u.newDueDate ? new Date(`${u.newDueDate}T18:00:00+03:00`) : null;
    const moved = newDue !== null && newDue.getTime() !== task.dueAt.getTime();
    const status =
      u.outcome === "DONE" ? ("DONE" as const) : u.outcome === "IN_PROGRESS" && (task.status === "NEW" || task.status === "ACCEPTED") ? ("IN_PROGRESS" as const) : task.status;
    await db.task.update({
      where: { id: task.id },
      data: {
        status,
        description: task.description + note,
        ...(u.outcome === "CHANGED" && u.newTitle ? { title: u.newTitle } : {}),
        ...(moved ? { dueAt: newDue, rescheduleCount: { increment: 1 } } : {}),
      },
    });
    await db.activityLog.create({
      data: {
        createdAt: clock.now(),
        leaderId,
        pipeline: "TASK",
        action: `TASK_PROTOCOL_${u.outcome}`,
        reason: `«${task.title}»: ${label} по итогам встречи «${meetingTitle}»${u.newTitle ? `; теперь «${u.newTitle}»` : ""}${moved ? `; новый срок ${u.newDueDate}` : ""}`,
        metadata: { taskId: task.id, outcome: u.outcome, ...(u.newTitle ? { newTitle: u.newTitle } : {}), ...(moved ? { newDueDate: u.newDueDate } : {}) },
      },
    });
    await publishEvent(leaderId, { type: "task.updated", data: { id: task.id } });
    applied++;
  }
  return applied;
}

export type ProtocolExecResult =
  | { applicable: false; reason: string }
  | { applicable: true; tasksCreated: number; tasksUpdated: number; mailsSent: number; mailsFailed: number; mailNote: string | null; nextMeeting: string };

export async function executeApprovedProtocol(
  db: PrismaClient,
  leaderId: string,
  decisionId: string,
  deps: { connector?: MailConnector; recipients?: "ALL" | "IN_PROTOCOL" } = {},
): Promise<ProtocolExecResult> {
  const mode = deps.recipients ?? "ALL";
  const skip = (reason: string): ProtocolExecResult => ({ applicable: false, reason });
  const d = await db.decision.findFirst({ where: { id: decisionId, leaderId, type: "MEETING_PROTOCOL" } });
  if (!d || (d.status !== "APPROVED" && d.status !== "EDITED_APPROVED")) return skip("Решение не утверждено");
  const payload = PayloadSchema.safeParse(d.proposedPayload);
  if (!payload.success) return skip("Некорректные данные протокола");
  const { meetingId, assignments, previousUpdates } = payload.data.args;

  const meeting = await db.meeting.findFirst({ where: { id: meetingId, leaderId } });
  if (!meeting) return skip("Встреча не найдена");

  // Условный апдейт: повторное срабатывание события не разошлёт протокол дважды.
  const markdown = (d.editedText ?? d.draftText ?? meeting.protocolMarkdown ?? "").trim();
  const claimed = await db.meeting.updateMany({
    where: { id: meetingId, leaderId, isProtocolApproved: false },
    data: { isProtocolApproved: true, protocolMarkdown: markdown },
  });
  if (claimed.count === 0) return skip("Протокол уже разослан");

  const now = clock.now();
  let tasksCreated = 0;
  const assigneeEmails = new Set<string>();
  for (const a of assignments) {
    const assignee = a.assigneeId ? await db.employee.findFirst({ where: { id: a.assigneeId, leaderId } }) : null;
    if (assignee?.email) assigneeEmails.add(assignee.email.toLowerCase());
    const due = a.dueDate ? new Date(`${a.dueDate}T18:00:00+03:00`) : new Date(meeting.endAt.getTime() + 7 * DAY);
    const task = await db.task.create({
      data: {
        leaderId,
        assigneeId: assignee?.id ?? null,
        title: a.task,
        description: `Из протокола встречи «${meeting.title}»`,
        acceptanceCriteria: a.criteria,
        sourceType: "MEETING",
        sourceRefId: meetingId,
        dueAt: due,
      },
    });
    tasksCreated++;
    // Отправка исполнителю — отдельным шагом воркера через Policy Gate.
    await publishEvent(leaderId, { type: "task.updated", data: { id: task.id, created: true } });
  }

  const tasksUpdated = await applyPreviousUpdates(db, leaderId, meeting.title, previousUpdates);

  // «Всем» — участники из календаря; «из протокола» — только исполнители поручений.
  const recipients = mode === "IN_PROTOCOL" ? [...assigneeEmails] : meeting.attendees;
  const mail = await sendProtocolMail(db, leaderId, { title: meeting.title, attendees: recipients }, markdown, deps.connector);
  // Сбой подбора слота не отменяет утверждённый протокол: поручения и рассылка уже выполнены.
  const next = await scheduleNextMeeting(db, leaderId, meetingId).catch((e): NextMeetingResult => ({ status: "skipped", reason: (e as Error).message }));

  const saved = await db.leader
    .findFirstOrThrow({ where: { id: leaderId }, select: { savedMinutesConfig: true } })
    .then((l) => Number((l.savedMinutesConfig as Record<string, unknown> | null)?.protocol ?? DEFAULT_SAVED_MINUTES));
  await db.activityLog.create({
    data: {
      createdAt: now,
      leaderId,
      pipeline: "MEETING",
      action: "PROTOCOL_APPROVED",
      reason: `Протокол «${meeting.title}» утверждён: поручений ${tasksCreated}, обновлено прошлых ${tasksUpdated}, писем ${mail.sent} (${mode === "IN_PROTOCOL" ? "только исполнителям" : "всем участникам"})`,
      savedMinutes: Number.isFinite(saved) ? saved : DEFAULT_SAVED_MINUTES,
      metadata: { decisionId, meetingId, tasksCreated, tasksUpdated, mailsSent: mail.sent, mailsFailed: mail.failed, recipients: mode },
    },
  });
  await publishEvent(leaderId, { type: "metrics.updated", data: {} });
  return { applicable: true, tasksCreated, tasksUpdated, mailsSent: mail.sent, mailsFailed: mail.failed, mailNote: mail.note, nextMeeting: next.status };
}

async function sendProtocolMail(
  db: PrismaClient,
  leaderId: string,
  meeting: { title: string; attendees: unknown },
  markdown: string,
  injected?: MailConnector,
): Promise<{ sent: number; failed: number; note: string | null }> {
  const log = (action: string, reason: string, metadata: Record<string, string | number> = {}) =>
    db.activityLog.create({ data: { createdAt: clock.now(), leaderId, pipeline: "MEETING", action, reason, metadata } });

  const recipients = z.array(z.string().email()).safeParse(meeting.attendees);
  if (!recipients.success || recipients.data.length === 0) {
    await log("PROTOCOL_MAIL_SKIPPED", "Нет адресов получателей: протокол не разослан");
    return { sent: 0, failed: 0, note: "нет адресов получателей" };
  }

  let row = null;
  if (!injected) {
    const rows = await db.connector.findMany({ where: { leaderId, isActive: true, type: { in: [...MAIL_TYPES] } }, orderBy: { createdAt: "asc" } });
    row = rows.find((r) => isMailType(r.type)) ?? null;
    if (!row) {
      await log("PROTOCOL_MAIL_SKIPPED", "Почта не подключена: протокол не разослан, отправьте вручную");
      return { sent: 0, failed: 0, note: "почта не подключена" };
    }
    const perm = await getConnectorToolPermission(db, leaderId, row.id, "mail.send_reply");
    const verdict = evaluate("mail.send_reply", { leader: await loadGateLeader(db, leaderId), toolPermission: perm, isOutbound: true, approvedByLeader: true });
    await logVerdict(db, leaderId, "mail.send_reply", verdict, { metadata: { kind: "protocol", approvedByLeader: true } });
    if (verdict.verdict === "DENY") {
      await log("PROTOCOL_MAIL_SKIPPED", "Рассылка запрещена в правах подключения");
      return { sent: 0, failed: 0, note: "рассылка запрещена в правах подключения" };
    }
  }
  const connector = injected ?? (row ? createMailConnector(db, row) : null);
  if (!connector) {
    await log("PROTOCOL_MAIL_SKIPPED", "Нет доступа к почте: войдите заново в разделе «Подключения»");
    return { sent: 0, failed: 0, note: "нет доступа к почте" };
  }

  const leader = await db.leader.findFirstOrThrow({ where: { id: leaderId }, select: { name: true } });
  const body = ensureSignature(markdown, leader.name);
  let sent = 0;
  let failed = 0;
  for (const to of recipients.data) {
    try {
      await connector.send({ to, subject: `Протокол встречи: ${meeting.title}`, text: body });
      sent++;
    } catch (e) {
      failed++;
      await log("PROTOCOL_MAIL_FAILED", `Не отправлено ${to}: ${(e as Error).message}`, { to });
    }
  }
  return { sent, failed, note: failed ? `не отправлено: ${failed}` : null };
}
