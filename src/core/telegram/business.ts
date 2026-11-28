/**
 * Telegram Business (транспорт-независимая часть): бот подключён к личному аккаунту руководителя.
 *
 *  - connection: кто подключил бота. Руководитель определяется по его LEADER-привязке к чату
 *    user_chat_id (его /start у бота). Нет привязки → подключение игнорируется.
 *  - входящие: разбираем только текст от сотрудников, которых руководитель привязал к боту.
 *    Остальные личные чаты (семья, друзья, незнакомцы) не читаем и в модель не отправляем.
 *  - ответ: только после «Утвердить» на карточке и через шлюз; от имени аккаунта уходит с подписью помощника.
 */
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { clock } from "../clock";
import { ingestEmails, type IngestOptions } from "../email-triage/ingest";
import { publishEvent } from "../events";
import type { LlmClient } from "../llm";
import { getToolPermission, logVerdict } from "../policy-gate";
import { esc, type Messenger } from "./types";

export const BUSINESS_CONNECTOR = "BUILTIN_TELEGRAM_BUSINESS";
export const BUSINESS_READ_TOOL = "telegram_business.read_messages";
export const BUSINESS_READ_ALL_TOOL = "telegram_business.read_all";
export const BUSINESS_REPLY_TOOL = "telegram_business.send_reply";

/** Реплика-подтверждение без вопроса и без содержания: «ок», «спасибо», «принял», «👍». Карточки не стоит: ответа никто не ждёт. */
const ACK_WORDS = ["ок", "окей", "ok", "okay", "ладно", "хорошо", "понял", "поняла", "принял", "приняла", "принято", "спасибо", "благодарю", "спс", "да", "ясно", "договорились", "отлично", "супер", "здорово", "👍", "🙏", "✅", "👌"];
// Слова без спецсимволов регулярных выражений, поэтому экранирование не нужно.
const ACK = new RegExp(`^(?:(?:${ACK_WORDS.join("|")})[\\s,.!)-]*){1,3}$`, "iu");
export const isAcknowledgement = (text: string): boolean => text.length <= 40 && !text.includes("?") && ACK.test(text.trim());

export interface BusinessConnectionUpdate {
  connectionId: string;
  userId: string;
  userChatId: string;
  canReply: boolean;
  isEnabled: boolean;
}

export interface BusinessIncoming {
  connectionId: string;
  chatId: string;
  messageId: string;
  fromUserId: string;
  fromIsBot: boolean;
  /** Имя из Telegram: нужно для карточки, если отправитель не сотрудник. */
  fromName?: string;
  text: string;
}

export interface BusinessDeps {
  db: PrismaClient;
  messenger: Messenger;
  /** Нет модели — входящее всё равно не теряется: уходит руководителю карточкой без разбора. */
  llm?: LlmClient;
  draft?: IngestOptions["draft"];
}

export type BusinessResult =
  | { status: "queued"; decisionId: string | null }
  | { status: "skipped"; reason: string };

/** Подключение бота к аккаунту (или отключение, или смена прав). */
export async function handleBusinessConnection(db: PrismaClient, u: BusinessConnectionUpdate): Promise<BusinessResult> {
  const binding = await db.telegramBinding.findFirst({
    where: { chatId: u.userChatId, role: "LEADER" },
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
    select: { leaderId: true },
  });
  if (!binding) return { status: "skipped", reason: "чат не привязан к руководителю" };
  await db.businessConnection.upsert({
    where: { connectionId: u.connectionId },
    create: { connectionId: u.connectionId, leaderId: binding.leaderId, userId: u.userId, userChatId: u.userChatId, canReply: u.canReply, isEnabled: u.isEnabled },
    update: { canReply: u.canReply, isEnabled: u.isEnabled },
  });
  return { status: "queued", decisionId: null };
}

/** Сообщение сотрудника в личном чате руководителя → карточка решения. Ничего никуда не отправляет. */
export async function handleBusinessMessage(deps: BusinessDeps, m: BusinessIncoming): Promise<BusinessResult> {
  const { db } = deps;
  const conn = await db.businessConnection.findUnique({ where: { connectionId: m.connectionId } });
  if (!conn || !conn.isEnabled) return { status: "skipped", reason: "подключение неизвестно или выключено" };
  const leaderId = conn.leaderId;

  // Свои сообщения руководителя и ответы бота не разбираем: иначе бот отвечал бы сам себе.
  if (m.fromIsBot || m.fromUserId === conn.userId) return { status: "skipped", reason: "сообщение своё" };
  const text = m.text.trim();
  if (!text) return { status: "skipped", reason: "нет текста" };
  // «Ок», «спасибо», «принял»: ответа не ждут, руководителя не отвлекаем.
  if (isAcknowledgement(text)) return { status: "skipped", reason: "подтверждение без вопроса" };

  // Коннектор выключен или чтение запрещено → молчим.
  const perm = await getToolPermission(db, leaderId, BUSINESS_CONNECTOR, BUSINESS_READ_TOOL);
  if (perm === null || perm === "DENY") return { status: "skipped", reason: "чтение сообщений не включено" };

  // По умолчанию только привязанные сотрудники. Остальных читаем, лишь если руководитель включил «читать всех».
  const binding = await db.telegramBinding.findFirst({
    where: { chatId: m.chatId, leaderId, role: "EMPLOYEE", employeeId: { not: null } },
    include: { employee: true },
  });
  let emp: { name: string; email: string; position: string | null };
  if (binding?.employee) {
    emp = binding.employee;
  } else {
    const all = await getToolPermission(db, leaderId, BUSINESS_CONNECTOR, BUSINESS_READ_ALL_TOOL);
    if (all === null || all === "DENY") return { status: "skipped", reason: "отправитель не привязан как сотрудник" };
    emp = { name: m.fromName?.trim() || "Неизвестный отправитель", email: `tg-${m.fromUserId}@telegram.local`, position: null };
  }

  const externalId = `tgb:${m.connectionId}:${m.chatId}:${m.messageId}`;
  const subject = text.length > 70 ? `${text.slice(0, 67)}…` : text;
  const incoming = {
    externalId,
    senderName: emp.name,
    senderEmail: emp.email,
    senderRole: emp.position ?? undefined,
    subject,
    body: text,
    receivedAt: clock.now(),
    reply: { tool: BUSINESS_REPLY_TOOL, args: { connectionId: m.connectionId, chatId: m.chatId, replyToMessageId: Number(m.messageId) } },
  };
  const emit = (e: Parameters<typeof publishEvent>[1]) => publishEvent(leaderId, e);

  if (deps.llm) {
    try {
      const stats = await ingestEmails(db, deps.llm, leaderId, [incoming], { emit, draft: deps.draft });
      if (stats.skippedExisting > 0) return { status: "skipped", reason: "уже разобрано" };
      return { status: "queued", decisionId: null };
    } catch {
      // Сбой модели не должен терять сообщение: ниже уйдёт карточка без разбора.
    }
  }

  const d = await db.decision.create({
    data: {
      leaderId,
      createdAt: clock.now(),
      type: "EMAIL_REPLY",
      title: `Сообщение: ${emp.name}`,
      contextSummary: text,
      gateReasons: ["Не удалось разобрать сообщение автоматически"],
      aiRecommendation: "Спросить руководителя",
      proposedPayload: incoming.reply,
    },
  });
  await emit({ type: "decision.created", data: { id: d.id } });
  return { status: "queued", decisionId: d.id };
}

/** Права бота изменились на «можно отвечать» → доотправить утверждённые, но не отправленные ответы за последние сутки. */
export async function retryApprovedReplies(deps: BusinessDeps, connectionId: string): Promise<number> {
  const conn = await deps.db.businessConnection.findUnique({ where: { connectionId } });
  if (!conn || !conn.isEnabled || !conn.canReply) return 0;
  const pending = await deps.db.decision.findMany({
    where: {
      leaderId: conn.leaderId,
      status: { in: ["APPROVED", "EDITED_APPROVED"] },
      resolvedAt: { gt: new Date(clock.now().getTime() - 24 * 3_600_000) },
      proposedPayload: { path: ["tool"], equals: BUSINESS_REPLY_TOOL },
    },
    select: { id: true },
  });
  let sent = 0;
  for (const d of pending) if ((await executeBusinessReply(deps, conn.leaderId, d.id))?.status === "sent") sent++;
  return sent;
}

const ReplyPayload =z.object({
  tool: z.literal(BUSINESS_REPLY_TOOL),
  args: z.object({ connectionId: z.string().min(1), chatId: z.string().min(1), replyToMessageId: z.number().int().optional() }),
});

export type BusinessReplyResult =
  | { status: "sent" }
  | { status: "denied" }
  | { status: "skipped"; reason: string };

/** Подпись помощника всегда в начале: получатель должен понимать, что пишет не человек (SPEC, этика). */
export const replyText = (leaderName: string, body: string): string => `<b>Это ИИ-помощник ${esc(leaderName)}.</b>\n${esc(body)}`;

/**
 * Карточка с ответом утверждена руководителем → отправить в чат от имени его аккаунта.
 * Возвращает null, если карточка не про Telegram Business.
 */
export async function executeBusinessReply(deps: BusinessDeps, leaderId: string, decisionId: string): Promise<BusinessReplyResult | null> {
  const { db, messenger } = deps;
  const d = await db.decision.findFirst({ where: { id: decisionId, leaderId } });
  if (!d || (d.status !== "APPROVED" && d.status !== "EDITED_APPROVED")) return null;
  const payload = ReplyPayload.safeParse(d.proposedPayload);
  if (!payload.success) return null;
  const { connectionId, chatId, replyToMessageId } = payload.data.args;

  const already = await db.activityLog.findFirst({
    where: { leaderId, action: "TELEGRAM_BUSINESS_SENT", metadata: { path: ["decisionId"], equals: d.id } },
    select: { id: true },
  });
  if (already) return { status: "skipped", reason: "уже отправлено" };

  // Руководитель сказал «да», но запрет инструмента или выключенный коннектор сильнее согласия.
  const perm = await getToolPermission(db, leaderId, BUSINESS_CONNECTOR, BUSINESS_REPLY_TOOL);
  if (perm === null || perm === "DENY") {
    await logVerdict(db, leaderId, BUSINESS_REPLY_TOOL, { verdict: "DENY", reasons: [`Инструмент ${BUSINESS_REPLY_TOOL} запрещён или не подключён`], signals: [] }, { metadata: { decisionId: d.id } });
    return { status: "denied" };
  }
  const conn = await db.businessConnection.findFirst({ where: { connectionId, leaderId, isEnabled: true, canReply: true } });
  if (!conn) return { status: "skipped", reason: "подключение выключено или у бота нет права отвечать" };
  const body = (d.editedText ?? d.draftText ?? "").trim();
  if (!body) return { status: "skipped", reason: "нет текста ответа" };

  if (!messenger.sendBusiness) return { status: "skipped", reason: "транспорт не умеет писать от аккаунта" };
  const leader = await db.leader.findFirstOrThrow({ where: { id: leaderId }, select: { name: true } });
  await logVerdict(db, leaderId, BUSINESS_REPLY_TOOL, { verdict: "ALLOW", reasons: ["Подтверждено руководителем"], signals: [] }, { metadata: { decisionId: d.id } });
  await messenger.sendBusiness(connectionId, chatId, replyText(leader.name, body), replyToMessageId);
  await db.activityLog.create({
    data: {
      leaderId,
      createdAt: clock.now(),
      pipeline: "EMAIL",
      action: "TELEGRAM_BUSINESS_SENT",
      reason: `Ответ отправлен в личный чат от аккаунта руководителя: ${d.title}`,
      metadata: { decisionId: d.id, chatId },
    },
  });
  return { status: "sent" };
}
