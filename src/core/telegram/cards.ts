/**
 * Карточки решений в Telegram: отправка, обновление («напоминание №N»), финальный вид после решения.
 * Сообщения идут только руководителю (его LEADER-привязкам); сотрудникам — через Policy Gate позже.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { buildDecisionCards, type DecisionCard } from "../dashboard";
import { findPlaceholders } from "../draft-placeholders";
import { esc, type Button, type Messenger } from "./types";

const STATUS_TEXT: Record<string, string> = {
  APPROVED: "Утверждено",
  EDITED_APPROVED: "Утверждено с вашей правкой",
  DELEGATED: "Передано",
  REJECTED: "Отклонено",
  SNOOZED: "Отложено: верну в утреннем плане",
};

export function cardText(c: DecisionCard): string {
  const lines = [
    c.reminderCount > 0 ? `<i>Напоминание №${c.reminderCount}</i>` : null,
    // Отправитель и время есть не у каждой карточки (например, у поручения нет письма): без висящих « · ».
    [`<b>${esc(c.tag)}</b>`, c.from && esc(c.from), c.when && esc(c.when)].filter(Boolean).join(" · "),
    `<b>${esc(c.title)}</b>`,
    esc(c.summary),
    c.draft ? `\nЧто я предлагаю:\n<i>${esc(c.draft)}</i>` : null,
    c.type !== "MEETING_PROTOCOL" && findPlaceholders(c.draft).length
      ? `\n⚠ В черновике остался пропуск ${esc(findPlaceholders(c.draft).join(", "))}. Нажмите «Поправить» и впишите значение: с пропуском письмо не уйдёт.`
      : null,
    c.reasons.length ? `\nПочему спрашиваю: ${esc(c.reasons.join("; "))}` : null,
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}

/** У протокола два варианта утверждения: разослать всем участникам или только исполнителям из протокола. */
export const cardButtons = (id: string, type?: string, draft?: string | null): Button[][] => [
  ...(type === "MEETING_PROTOCOL"
    ? [
        [
          { text: "Утвердить: всем", data: `d:a:${id}` },
          { text: "Только исполнителям", data: `d:p:${id}` },
        ],
        [{ text: "Поправить", data: `d:e:${id}` }],
      ]
    : findPlaceholders(draft).length
      ? // Пропуск «[срок]»: утвердить нельзя, пока руководитель не впишет значение.
        [[{ text: "Поправить", data: `d:e:${id}` }]]
      : [
          [
            { text: "Утвердить", data: `d:a:${id}` },
            { text: "Поправить", data: `d:e:${id}` },
          ],
        ]),
  [
    { text: "Передать", data: `d:d:${id}` },
    { text: "Не сейчас", data: `d:s:${id}` },
  ],
];

const ref = (chatId: string, messageId: string) => `${chatId}:${messageId}`;
const parseRef = (r: string): { chatId: string; messageId: string } | null => {
  const i = r.lastIndexOf(":");
  return i > 0 ? { chatId: r.slice(0, i), messageId: r.slice(i + 1) } : null;
};

async function leaderChats(db: PrismaClient, leaderId: string): Promise<string[]> {
  const rows = await db.telegramBinding.findMany({ where: { leaderId, role: "LEADER" }, select: { chatId: true } });
  return [...new Set(rows.map((r) => r.chatId))];
}

/** Шлёт карточку руководителю. Идемпотентно: повторное событие не создаёт второе сообщение. */
export async function sendDecisionCard(db: PrismaClient, m: Messenger, leaderId: string, decisionId: string): Promise<boolean> {
  const d = await db.decision.findFirst({ where: { id: decisionId, leaderId } });
  if (!d || d.status !== "PENDING" || d.telegramMessageId) return false;
  const chats = await leaderChats(db, leaderId);
  if (chats.length === 0) return false; // чат не привязан: карточка остаётся в вебе

  const [card] = await buildDecisionCards(db, leaderId, [d]);
  let first: string | null = null;
  for (const chatId of chats) {
    const { messageId } = await m.send(chatId, cardText(card), cardButtons(d.id, d.type, d.draftText));
    first ??= ref(chatId, messageId);
  }
  // Условная запись: гонка двух воркеров не затрёт уже сохранённую ссылку.
  await db.decision.updateMany({ where: { id: d.id, leaderId, telegramMessageId: null }, data: { telegramMessageId: first } });
  return true;
}

/** Обновляет уже отправленную карточку: новый повтор → «напоминание №N»; решено → финальный текст без кнопок. */
export async function refreshDecisionCard(db: PrismaClient, m: Messenger, leaderId: string, decisionId: string): Promise<boolean> {
  const d = await db.decision.findFirst({ where: { id: decisionId, leaderId } });
  const target = d?.telegramMessageId ? parseRef(d.telegramMessageId) : null;
  if (!d || !target) return false;
  const [card] = await buildDecisionCards(db, leaderId, [d]);
  if (d.status === "PENDING") {
    await m.edit(target.chatId, target.messageId, cardText(card), cardButtons(d.id, d.type, d.draftText));
  } else {
    await m.edit(target.chatId, target.messageId, `${cardText(card)}\n\n<b>${esc(STATUS_TEXT[d.status] ?? d.status)}</b>`);
  }
  return true;
}
