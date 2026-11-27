/**
 * Поручение по почте (SPEC 4.3.2): если исполнитель не привязал Telegram, задача уходит письмом.
 * В письме ссылка с подписанным токеном на страницу `/t/<token>`, где те же три действия, что и кнопки
 * бота: «Принял», «Уточнить», «Не успею». Ответ по ссылке фиксируется так же, как нажатие кнопки.
 * Токен — HMAC от id задачи (CONNECTOR_SECRET): без него ни прочитать, ни изменить чужую задачу нельзя.
 */
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { clock } from "../clock";
import { secretsConfigured, signState, verifyState } from "../connectors/crypto";
import { publishEvent } from "../events";
import { requestReschedule } from "./lifecycle";

const TZ = "Europe/Moscow";
const PREFIX = "task1:";

export const appUrl = () => (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");

/** Подписанный токен ссылки. Без CONNECTOR_SECRET ссылок нет (null), и поручение письмом не отправляется. */
export function taskLinkToken(taskId: string): string | null {
  if (!secretsConfigured()) return null;
  return Buffer.from(signState(`${PREFIX}${taskId}`)).toString("base64url");
}

export function verifyTaskLink(token: string): string | null {
  if (!secretsConfigured() || token.length > 400) return null;
  let raw: string;
  try {
    raw = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const payload = verifyState(raw);
  return payload?.startsWith(PREFIX) ? payload.slice(PREFIX.length) : null;
}

export const taskLinkUrl = (token: string) => `${appUrl()}/t/${token}`;

const fmtDue = (d: Date) =>
  new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(d);

/** Текст письма исполнителю. Этика (SPEC инвариант 7): помощник представляется первым предложением. */
export function taskEmail(args: { leaderName: string; title: string; dueAt: Date; criteria: string; url: string; inviteUrl?: string | null }): { subject: string; text: string } {
  return {
    subject: `Поручение: ${args.title}`,
    text: [
      `Здравствуйте, я ИИ-помощник ${args.leaderName}.`,
      "",
      `Новая задача: ${args.title}`,
      `Срок: ${fmtDue(args.dueAt)}`,
      `Критерий готовности: ${args.criteria}`,
      "",
      "Ответьте по ссылке: «Принял», «Уточнить» или «Не успею» (с новой датой и причиной):",
      args.url,
      ...(args.inviteUrl ? ["", `Удобнее в Telegram: ${args.inviteUrl}`] : []),
    ].join("\n"),
  };
}

export interface TaskLinkView {
  title: string;
  criteria: string;
  dueAt: string;
  status: string;
  assigneeName: string;
  leaderName: string;
}

async function findTask(db: PrismaClient, token: string) {
  const id = verifyTaskLink(token);
  if (!id) return null;
  return db.task.findFirst({ where: { id }, include: { assignee: true, leader: { select: { name: true } } } });
}

/** Что видит исполнитель по ссылке: только эта задача, без данных руководителя сверх имени. */
export async function viewTaskByLink(db: PrismaClient, token: string): Promise<TaskLinkView | null> {
  const t = await findTask(db, token);
  if (!t || !t.assignee) return null;
  return { title: t.title, criteria: t.acceptanceCriteria, dueAt: t.dueAt.toISOString(), status: t.status, assigneeName: t.assignee.name, leaderName: t.leader.name };
}

export const TaskLinkAnswerSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept") }),
  z.object({ action: z.literal("clarify"), question: z.string().trim().min(3, "Напишите вопрос").max(2000) }),
  z.object({
    action: z.literal("reschedule"),
    /** Дата нового срока (ГГГГ-ММ-ДД), конец рабочего дня по Москве. */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Укажите дату"),
    reason: z.string().trim().min(3, "Напишите причину").max(500),
  }),
]);
export type TaskLinkAnswer = z.infer<typeof TaskLinkAnswerSchema>;

export type TaskLinkResult = { ok: true; message: string } | { ok: false; code: "NOT_FOUND" | "INVALID"; message: string };

/** Ответ исполнителя по ссылке. Руководителю — запись в журнал и сообщение в Telegram через воркер. */
export async function answerTaskByLink(db: PrismaClient, token: string, input: TaskLinkAnswer): Promise<TaskLinkResult> {
  const task = await findTask(db, token);
  if (!task || !task.assignee) return { ok: false, code: "NOT_FOUND", message: "Ссылка недействительна или задача удалена" };
  const { leaderId } = task;
  const who = task.assignee.name;
  const log = (action: string, reason: string, metadata: object = {}) =>
    db.activityLog.create({ data: { leaderId, createdAt: clock.now(), pipeline: "TASK", action, reason, metadata: { taskId: task.id, channel: "email", ...metadata } } });
  const tellLeader = (text: string) => publishEvent(leaderId, { type: "leader.notify", data: { text } });

  if (input.action === "accept") {
    // Условный переход NEW → ACCEPTED, как у кнопки «Принял»: повтор ничего не меняет.
    const upd = await db.task.updateMany({ where: { id: task.id, leaderId, status: "NEW" }, data: { status: "ACCEPTED" } });
    if (upd.count === 0) return { ok: true, message: "Задача уже принята. Спасибо!" };
    await log("TASK_ACCEPTED", `${who} принял задачу «${task.title}» (по ссылке из письма)`);
    await publishEvent(leaderId, { type: "task.updated", data: { id: task.id } });
    await tellLeader(`${who} принял задачу «${task.title}».`);
    return { ok: true, message: "Принято. Руководитель увидит это в сводке." };
  }

  if (input.action === "clarify") {
    await log("TASK_QUESTION", `${who} спрашивает по задаче «${task.title}»: ${input.question}`, { question: input.question });
    await tellLeader(`Вопрос от ${who} по задаче «${task.title}»:\n${input.question}`);
    return { ok: true, message: "Передала ваш вопрос руководителю." };
  }

  // Конец рабочего дня (18:00 МСК) выбранной даты.
  const newDue = new Date(`${input.date}T18:00:00+03:00`);
  if (Number.isNaN(newDue.getTime())) return { ok: false, code: "INVALID", message: "Не поняла дату" };
  const res = await requestReschedule({ db, messenger: NO_MESSENGER }, leaderId, task.id, newDue, input.reason);
  if (res.status === "rescheduled") return { ok: true, message: `Перенесла срок на ${fmtDue(res.dueAt)}. Руководитель увидит это в сводке.` };
  if (res.status === "awaiting_leader") {
    await tellLeader(`${who} просит перенести срок по задаче «${task.title}». Карточка в «Разговоре».`);
    return { ok: true, message: `Срок не двигаю сама: ${res.reason.toLowerCase()}. Передала руководителю.` };
  }
  return { ok: false, code: "INVALID", message: res.reason };
}

/** Перенос срока в вебе ничего не шлёт в Telegram напрямую: руководителю пишет воркер по событию. */
const NO_MESSENGER = {
  send: async () => ({ messageId: "" }),
  edit: async () => {},
};
