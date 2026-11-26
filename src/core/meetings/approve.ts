/**
 * Исполнение утверждённого протокола (SPEC 4.5.1): рассылка участникам, поручения исполнителям.
 * Всё внешнее идёт через Policy Gate: письмо — как `mail.send_reply` (запрет прав подключения останавливает),
 * поручения создаются как Task, а их отправка исполнителям сама проходит шлюз (tasks/dispatch).
 * Создание следующей встречи в календаре — P1 (подбор слота), здесь не делается.
 */
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { clock } from "../clock";
import { publishEvent } from "../events";
import { ensureSignature } from "../learning/draft";
import { createMailConnector, isMailType, MAIL_TYPES } from "../mail/factory";
import type { MailConnector } from "../mail/types";
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
  }),
});

export type ProtocolExecResult =
  | { applicable: false; reason: string }
  | { applicable: true; tasksCreated: number; mailsSent: number; mailsFailed: number; mailNote: string | null };

export async function executeApprovedProtocol(
  db: PrismaClient,
  leaderId: string,
  decisionId: string,
  deps: { connector?: MailConnector } = {},
): Promise<ProtocolExecResult> {
  const skip = (reason: string): ProtocolExecResult => ({ applicable: false, reason });
  const d = await db.decision.findFirst({ where: { id: decisionId, leaderId, type: "MEETING_PROTOCOL" } });
  if (!d || (d.status !== "APPROVED" && d.status !== "EDITED_APPROVED")) return skip("Решение не утверждено");
  const payload = PayloadSchema.safeParse(d.proposedPayload);
  if (!payload.success) return skip("Некорректные данные протокола");
  const { meetingId, assignments } = payload.data.args;

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
  for (const a of assignments) {
    const assignee = a.assigneeId ? await db.employee.findFirst({ where: { id: a.assigneeId, leaderId } }) : null;
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

  const mail = await sendProtocolMail(db, leaderId, meeting, markdown, deps.connector);

  const saved = await db.leader
    .findFirstOrThrow({ where: { id: leaderId }, select: { savedMinutesConfig: true } })
    .then((l) => Number((l.savedMinutesConfig as Record<string, unknown> | null)?.protocol ?? DEFAULT_SAVED_MINUTES));
  await db.activityLog.create({
    data: {
      createdAt: now,
      leaderId,
      pipeline: "MEETING",
      action: "PROTOCOL_APPROVED",
      reason: `Протокол «${meeting.title}» утверждён: поручений ${tasksCreated}, писем ${mail.sent}`,
      savedMinutes: Number.isFinite(saved) ? saved : DEFAULT_SAVED_MINUTES,
      metadata: { decisionId, meetingId, tasksCreated, mailsSent: mail.sent, mailsFailed: mail.failed },
    },
  });
  await publishEvent(leaderId, { type: "metrics.updated", data: {} });
  return { applicable: true, tasksCreated, mailsSent: mail.sent, mailsFailed: mail.failed, mailNote: mail.note };
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
    await log("PROTOCOL_MAIL_SKIPPED", "У встречи нет адресов участников: протокол не разослан");
    return { sent: 0, failed: 0, note: "нет адресов участников" };
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
    const verdict = evaluate("mail.send_reply", { leader: await loadGateLeader(db, leaderId), toolPermission: perm, isOutbound: true });
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
