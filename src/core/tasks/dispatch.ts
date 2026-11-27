/**
 * Назначение поручения исполнителю в Telegram (SPEC 4.3.2). Сообщение сотруднику — внешняя
 * мутация, поэтому только через Policy Gate:
 *   ALLOW   → отправить сразу;
 *   APPROVE → карточка руководителю (Decision TOOL_CALL), отправка после «Утвердить»;
 *   DENY    → не отправлять.
 * Исполнитель не привязал бота → письмом со ссылкой «Принял / Уточнить / Не успею» (если подключена почта),
 * иначе поручение ждёт, а руководителю уйдёт ссылка-приглашение.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { clock } from "../clock";
import { publishEvent } from "../events";
import {
  evaluate,
  getToolPermission,
  loadGateLeader,
  logVerdict,
  TELEGRAM_CONNECTOR,
  type GateResult,
} from "../policy-gate";
import { esc, type Button, type Messenger } from "../telegram/types";
import { createMailConnector, MAIL_TYPES } from "../mail/factory";
import type { MailConnector } from "../mail/types";
import { getConnectorToolPermission } from "../policy-gate";
import { taskEmail, taskLinkToken, taskLinkUrl } from "./email-link";

export const ASSIGN_TOOL = "telegram.assign_task";
/** Область доверия режима обучения для отправки поручений (SPEC 1.1). */
export const TASK_ASSIGN_SCOPE = "TASK_ASSIGN";
const TZ = "Europe/Moscow";

export interface DispatchDeps {
  db: PrismaClient;
  messenger: Messenger;
  /** Почтовый клиент для поручений письмом; по умолчанию — из подключения руководителя (тесты подменяют). */
  mail?: (row: { id: string; leaderId: string; type: string; encryptedConfig: string }) => MailConnector | null;
}

export type DispatchResult =
  | { status: "sent"; chats: number }
  | { status: "emailed"; to: string }
  | { status: "awaiting_binding" }
  | { status: "awaiting_approval"; decisionId: string }
  | { status: "denied" }
  | { status: "skipped"; reason: string };

export const taskButtons = (taskId: string): Button[][] => [
  [
    { text: "Принял", data: `t:a:${taskId}` },
    { text: "Уточнить", data: `t:c:${taskId}` },
  ],
  [{ text: "Не успею", data: `t:r:${taskId}` }],
];

const fmtDue = (d: Date) =>
  new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(d);

export function taskText(args: { leaderName: string; title: string; dueAt: Date; criteria: string }): string {
  // Этика (SPEC инвариант 7): агент всегда представляется.
  return [
    `<b>Здравствуйте, я ИИ-помощник ${esc(args.leaderName)}.</b>`,
    `Новая задача: <b>${esc(args.title)}</b>`,
    `Срок: ${esc(fmtDue(args.dueAt))}`,
    `Критерий готовности: ${esc(args.criteria)}`,
  ].join("\n");
}

const ref = (chatId: string, messageId: string) => `${chatId}:${messageId}`;

export async function dispatchTask(
  deps: DispatchDeps,
  leaderId: string,
  taskId: string,
  opts: { approved?: boolean } = {},
): Promise<DispatchResult> {
  const { db, messenger } = deps;
  const task = await db.task.findFirst({
    where: { id: taskId, leaderId },
    include: { assignee: true, leader: { select: { name: true } } },
  });
  if (!task) return { status: "skipped", reason: "задача не найдена" };
  if (!task.assignee) return { status: "skipped", reason: "у задачи нет исполнителя" };
  if (task.notifiedAt) return { status: "skipped", reason: "уже отправлено" };
  if (task.status !== "NEW") return { status: "skipped", reason: `статус ${task.status}` };

  const permission = await getToolPermission(db, leaderId, TELEGRAM_CONNECTOR, ASSIGN_TOOL);
  const source = await db.emailItem.findFirst({ where: { leaderId, taskId: task.id }, select: { category: true, confidence: true } });

  let verdict: GateResult;
  if (opts.approved) {
    // Руководитель уже сказал «да» на карточке. Запрет инструмента (DENY) сильнее согласия.
    verdict =
      permission === "DENY"
        ? { verdict: "DENY", reasons: [`Инструмент ${ASSIGN_TOOL} запрещён`], signals: [] }
        : { verdict: "ALLOW", reasons: ["Подтверждено руководителем"], signals: [] };
  } else {
    // Поручение из утверждённого протокола: руководитель уже видел исполнителя, срок и критерий.
    // Это снимает только режим обучения; права инструмента и защищённые категории проверяются как обычно.
    const fromApprovedProtocol =
      task.sourceType === "MEETING" &&
      Boolean(task.sourceRefId) &&
      (await db.meeting.count({ where: { id: task.sourceRefId ?? "", leaderId, isProtocolApproved: true } })) > 0;
    verdict = evaluate(ASSIGN_TOOL, {
      approvedByLeader: fromApprovedProtocol,
      leader: await loadGateLeader(db, leaderId),
      // Обязательство клиенту — защищённая категория, даже если письмо классифицировано иначе.
      category: task.isClientCommitment ? "CLIENT_COMMITMENT" : (source?.category ?? undefined),
      confidence: source?.confidence ?? 1,
      toolPermission: permission,
      trustScope: TASK_ASSIGN_SCOPE,
    });
  }
  await logVerdict(db, leaderId, ASSIGN_TOOL, verdict, { metadata: { taskId: task.id } });

  if (verdict.verdict === "DENY") return { status: "denied" };

  if (verdict.verdict === "APPROVE") {
    const existing = await db.decision.findFirst({
      where: { leaderId, type: "TOOL_CALL", status: "PENDING", proposedPayload: { path: ["args", "taskId"], equals: task.id } },
      select: { id: true },
    });
    if (existing) return { status: "awaiting_approval", decisionId: existing.id };
    const d = await db.decision.create({
      data: {
        leaderId,
        createdAt: clock.now(),
        type: "TOOL_CALL",
        title: `Отправить поручение: ${task.title}`,
        contextSummary: `Исполнитель: ${task.assignee.name}, ${task.assignee.position}. Срок: ${fmtDue(task.dueAt)}. Критерий: ${task.acceptanceCriteria}`,
        gateReasons: verdict.reasons,
        aiRecommendation: "Отправить поручение",
        proposedPayload: { tool: ASSIGN_TOOL, args: { taskId: task.id } },
      },
    });
    await publishEvent(leaderId, { type: "decision.created", data: { id: d.id } });
    return { status: "awaiting_approval", decisionId: d.id };
  }

  // ALLOW: нужен привязанный чат исполнителя.
  const bindings = await db.telegramBinding.findMany({
    where: { leaderId, role: "EMPLOYEE", employeeId: task.assignee.id },
    select: { chatId: true },
  });
  const chats = [...new Set(bindings.map((b) => b.chatId))];
  if (chats.length === 0) {
    // Telegram нет — письмом, если подключена почта (SPEC 4.3.2): задача не «зависает» из-за бота.
    const emailed = await dispatchByEmail(deps, task);
    if (emailed) return emailed;
    await db.activityLog.create({
      data: {
        leaderId,
        createdAt: clock.now(),
        pipeline: "TASK",
        action: "TASK_WAITING_BINDING",
        reason: `${task.assignee.name} ещё не подключил бота: поручение «${task.title}» ждёт приглашения`,
        metadata: { taskId: task.id, employeeId: task.assignee.id },
      },
    });
    return { status: "awaiting_binding" };
  }

  // Захват перед отправкой: два воркера или повтор события не отправят поручение дважды.
  const claimed = await db.task.updateMany({
    where: { id: task.id, leaderId, notifiedAt: null },
    data: { notifiedAt: clock.now() },
  });
  if (claimed.count === 0) return { status: "skipped", reason: "уже отправлено" };

  const text = taskText({ leaderName: task.leader.name, title: task.title, dueAt: task.dueAt, criteria: task.acceptanceCriteria });
  let first: string | null = null;
  try {
    for (const chatId of chats) {
      const { messageId } = await messenger.send(chatId, text, taskButtons(task.id));
      first ??= ref(chatId, messageId);
    }
  } catch (e) {
    if (!first) await db.task.updateMany({ where: { id: task.id, leaderId }, data: { notifiedAt: null } }); // дать шанс повторить
    throw e;
  }
  await db.task.updateMany({ where: { id: task.id, leaderId }, data: { telegramMessageId: first } });
  await publishEvent(leaderId, { type: "task.updated", data: { id: task.id } });
  return { status: "sent", chats: chats.length };
}

/**
 * Поручение письмом: вердикт шлюза уже ALLOW (или руководитель утвердил карточку). Нужны подключённая почта,
 * адрес исполнителя и CONNECTOR_SECRET для подписи ссылки. Запрет отправки в правах почты (DENY) сильнее.
 * null — письмом отправить нельзя, поручение ждёт Telegram, как раньше.
 */
async function dispatchByEmail(
  deps: DispatchDeps,
  task: { id: string; leaderId: string; title: string; dueAt: Date; acceptanceCriteria: string; assignee: { id: string; name: string; email: string; inviteToken: string } | null; leader: { name: string } },
): Promise<DispatchResult | null> {
  const { db } = deps;
  const to = task.assignee?.email.trim();
  if (!task.assignee || !to || !to.includes("@")) return null;
  const token = taskLinkToken(task.id);
  if (!token) return null;
  const row = await db.connector.findFirst({ where: { leaderId: task.leaderId, isActive: true, type: { in: [...MAIL_TYPES] } }, orderBy: { createdAt: "asc" } });
  if (!row) return null;
  if ((await getConnectorToolPermission(db, task.leaderId, row.id, "mail.send_reply")) === "DENY") return null;
  const mail = (deps.mail ?? ((r) => createMailConnector(db, r)))(row);
  if (!mail) return null;

  const claimed = await db.task.updateMany({ where: { id: task.id, leaderId: task.leaderId, notifiedAt: null }, data: { notifiedAt: clock.now() } });
  if (claimed.count === 0) return { status: "skipped", reason: "уже отправлено" };

  const bot = process.env.TELEGRAM_BOT_USERNAME;
  const { subject, text } = taskEmail({
    leaderName: task.leader.name,
    title: task.title,
    dueAt: task.dueAt,
    criteria: task.acceptanceCriteria,
    url: taskLinkUrl(token),
    inviteUrl: bot ? `https://t.me/${bot}?start=${task.assignee.inviteToken}` : null,
  });
  try {
    await mail.send({ to, subject, text });
  } catch (e) {
    await db.task.updateMany({ where: { id: task.id, leaderId: task.leaderId }, data: { notifiedAt: null } }); // дать шанс повторить
    await db.activityLog.create({
      data: { leaderId: task.leaderId, createdAt: clock.now(), pipeline: "TASK", action: "TASK_EMAIL_FAILED", reason: `Поручение «${task.title}» не ушло письмом: ${(e as Error).message}`, metadata: { taskId: task.id } },
    });
    return null;
  }
  await db.activityLog.create({
    data: {
      leaderId: task.leaderId,
      createdAt: clock.now(),
      pipeline: "TASK",
      action: "TASK_SENT_EMAIL",
      reason: `Поручение «${task.title}» отправлено ${task.assignee.name} письмом: Telegram не подключён`,
      savedMinutes: 3,
      metadata: { taskId: task.id, employeeId: task.assignee.id, to },
    },
  });
  await publishEvent(task.leaderId, { type: "task.updated", data: { id: task.id } });
  return { status: "emailed", to };
}

/** Поручения сотрудника, которые ждали привязки или ещё не отправлялись (после /start сотрудника). */
export async function dispatchPendingForEmployee(deps: DispatchDeps, leaderId: string, employeeId: string): Promise<number> {
  const tasks = await deps.db.task.findMany({
    where: { leaderId, assigneeId: employeeId, notifiedAt: null, status: "NEW", sourceType: { not: "DATASET" } },
    orderBy: { dueAt: "asc" },
    select: { id: true },
  });
  let sent = 0;
  for (const t of tasks) {
    const r = await dispatchTask(deps, leaderId, t.id);
    if (r.status === "sent") sent++;
  }
  return sent;
}

/** Карточка TOOL_CALL подтверждена руководителем → исполнить действие (после гейта). */
export async function executeApprovedToolCall(deps: DispatchDeps, leaderId: string, decisionId: string): Promise<DispatchResult | null> {
  const d = await deps.db.decision.findFirst({ where: { id: decisionId, leaderId } });
  if (!d || d.type !== "TOOL_CALL" || (d.status !== "APPROVED" && d.status !== "EDITED_APPROVED")) return null;
  const payload = d.proposedPayload as { tool?: string; args?: { taskId?: string } } | null;
  if (payload?.tool !== ASSIGN_TOOL || !payload.args?.taskId) return null;
  return dispatchTask(deps, leaderId, payload.args.taskId, { approved: true });
}
