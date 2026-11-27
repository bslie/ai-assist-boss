/**
 * Вопросы аватара по прошлому протоколу (SPEC 4.5.2): незакрытые поручения предыдущей встречи той же серии.
 * Нет утверждённого протокола в серии → открытые задачи участников встречи (просроченные первыми).
 * Детерминированно, без LLM: формулировки шаблонные, факты только из БД.
 */
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { clock } from "../clock";

const MAX_QUESTIONS = 5;
const TZ = "Europe/Moscow";
const fmtDay = (d: Date) => new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, day: "numeric", month: "long" }).format(d);

export const AgendaSchema = z.array(z.object({ question: z.string().min(1), assigneeName: z.string().nullable(), taskId: z.string().nullable() }));
export type AgendaQuestion = z.infer<typeof AgendaSchema>[number];

export async function buildAgendaQuestions(db: PrismaClient, leaderId: string, meetingId: string): Promise<AgendaQuestion[]> {
  const meeting = await db.meeting.findFirst({ where: { id: meetingId, leaderId } });
  if (!meeting) return [];
  const now = clock.now();

  // Идём по серии назад до встречи с утверждённым протоколом.
  let fromProtocol: string | null = null;
  for (let prevId = meeting.previousMeetingId, hops = 0; prevId && hops < 20; hops++) {
    const prev = await db.meeting.findFirst({ where: { id: prevId, leaderId }, select: { id: true, isProtocolApproved: true, previousMeetingId: true } });
    if (!prev) break;
    if (prev.isProtocolApproved) {
      fromProtocol = prev.id;
      break;
    }
    prevId = prev.previousMeetingId;
  }

  const open = { not: "DONE" as const };
  let tasks;
  if (fromProtocol) {
    tasks = await db.task.findMany({
      where: { leaderId, sourceType: "MEETING", sourceRefId: fromProtocol, status: open },
      include: { assignee: { select: { name: true } } },
      orderBy: { dueAt: "asc" },
    });
  } else {
    const attendees = z.array(z.string()).safeParse(meeting.attendees);
    const emails = attendees.success ? attendees.data : [];
    tasks = emails.length
      ? await db.task.findMany({
          where: { leaderId, status: open, assignee: { email: { in: emails } } },
          include: { assignee: { select: { name: true } } },
          orderBy: { dueAt: "asc" },
        })
      : [];
  }

  // Просроченные впереди: по ним вопрос важнее. Срок по правилу 4.3.6 (dueAt или csvStatus).
  const overdue = (t: (typeof tasks)[number]) => t.dueAt < now || t.csvStatus === "просрочена";
  tasks.sort((a, b) => Number(overdue(b)) - Number(overdue(a)) || a.dueAt.getTime() - b.dueAt.getTime());

  return tasks.slice(0, MAX_QUESTIONS).map((t) => {
    const who = t.assignee?.name ?? null;
    const base = who ? `${who}, как продвигается задача «${t.title}»?` : `Как продвигается задача «${t.title}»?`;
    const tail =
      t.dueAt < now
        ? ` Срок уже прошёл (${fmtDay(t.dueAt)}): когда будет готово?`
        : overdue(t)
          ? ` Задача числится просроченной (срок по плану — ${fmtDay(t.dueAt)}): когда будет готово?`
          : ` Срок — ${fmtDay(t.dueAt)}, успеваете?`;
    return { question: base + tail, assigneeName: who, taskId: t.id };
  });
}

/** Сохраняет вопросы во встрече; возвращает их же. */
export async function prepareAgenda(db: PrismaClient, leaderId: string, meetingId: string): Promise<AgendaQuestion[]> {
  const questions = await buildAgendaQuestions(db, leaderId, meetingId);
  await db.meeting.updateMany({ where: { id: meetingId, leaderId }, data: { agendaQuestions: questions } });
  return questions;
}

/** Реплики аватара (SPEC 4.5.3): представиться → вопросы → итог. Всегда «ИИ-помощник <имя>». */
export function buildAvatarScript(args: { leaderName: string; meetingTitle: string; questions: readonly AgendaQuestion[] }): string[] {
  const lines = [
    `Здравствуйте, я ИИ-помощник ${args.leaderName}. На встрече «${args.meetingTitle}» я представляю его вместо личного участия и задам несколько вопросов по прошлым поручениям.`,
  ];
  if (args.questions.length === 0) {
    lines.push("Открытых поручений по этой встрече у меня нет. Если у вас есть вопросы к руководителю, назовите их, я передам.");
  } else {
    lines.push("По каждому поручению скажите: выполнено, в работе или вопрос не решён. Если сама задача изменилась, скажите, как она звучит теперь и какой срок.");
    args.questions.forEach((q, i) => lines.push(`Вопрос ${i + 1}. ${q.question}`));
  }
  lines.push(`Спасибо. Ответы и договорённости я зафиксирую и передам руководителю: протокол придёт ему на утверждение.`);
  return lines;
}
