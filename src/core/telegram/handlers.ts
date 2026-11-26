/**
 * Обработчики колбэков и текста (SPEC 5.1). callback_data:
 *   d:a|e|d|s|b:<decisionId>   утвердить / поправить / передать / не сейчас / назад
 *   d:t:<decisionId>:<empId>   передать сотруднику
 *   r:<bindingId>              сменить роль
 * Каждое решение проходит ту же функцию resolveDecision, что и веб; чужие карточки недоступны.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { resolveDecision, type ResolveInput } from "../decisions";
import { buildDecisionCards } from "../dashboard";
import { cardButtons, cardText, refreshDecisionCard } from "./cards";
import { leaderIdsForChat, switchRole } from "./bindings";
import { esc, type Messenger, type StateStore } from "./types";

export interface Deps {
  db: PrismaClient;
  messenger: Messenger;
  state: StateStore;
}

export interface CallbackInput {
  chatId: string;
  messageId: string;
  data: string;
}

const EDIT_TTL = 600;
const editKey = (chatId: string) => `tg:edit:${chatId}`;

/** Чат вправе трогать карточку только если привязан как руководитель именно этой карточки. */
async function authorize(deps: Deps, chatId: string, decisionId: string) {
  const d = await deps.db.decision.findUnique({ where: { id: decisionId } });
  if (!d) return null;
  const allowed = await leaderIdsForChat(deps.db, chatId);
  return allowed.includes(d.leaderId) ? d : null;
}

const RESOLVE_MSG: Record<string, string> = {
  NOT_FOUND: "Карточка не найдена",
  ALREADY_RESOLVED: "Уже решено",
  BAD_DELEGATE: "Этот сотрудник недоступен",
};

async function resolveAndRefresh(deps: Deps, chatId: string, decisionId: string, leaderId: string, input: ResolveInput): Promise<string> {
  const res = await resolveDecision(deps.db, leaderId, decisionId, input);
  // Карточка в чате обновляется всегда: и после решения, и если оно уже было принято в вебе.
  await refreshDecisionCard(deps.db, deps.messenger, leaderId, decisionId).catch(() => {});
  if (res.ok) return "Готово";
  return RESOLVE_MSG[res.code] ?? res.message;
}

/** Возвращает короткий ответ-«тост» для answerCallbackQuery. */
export async function handleCallback(deps: Deps, input: CallbackInput): Promise<string> {
  const parts = input.data.split(":");
  const [kind, action, id, extra] = parts;

  if (kind === "r" && action) {
    return (await switchRole(deps.db, input.chatId, action)).text.replace(/<[^>]+>/g, "");
  }
  if (kind !== "d" || !action || !id) return "Неизвестное действие";

  const d = await authorize(deps, input.chatId, id);
  if (!d) return "Нет доступа к этой карточке";

  switch (action) {
    case "a":
      return resolveAndRefresh(deps, input.chatId, id, d.leaderId, { action: "APPROVE" });
    case "s":
      return resolveAndRefresh(deps, input.chatId, id, d.leaderId, { action: "SNOOZE" });
    case "t":
      if (!extra) return "Не выбран сотрудник";
      return resolveAndRefresh(deps, input.chatId, id, d.leaderId, { action: "DELEGATE", delegateToId: extra });
    case "e": {
      if (d.status !== "PENDING") return "Уже решено";
      await deps.state.set(editKey(input.chatId), id, EDIT_TTL);
      await deps.messenger.send(input.chatId, "Пришлите текст ответа одним сообщением. Отмена: /cancel");
      return "Жду ваш текст";
    }
    case "d": {
      if (d.status !== "PENDING") return "Уже решено";
      const people = await deps.db.employee.findMany({
        where: { leaderId: d.leaderId, relationType: "SUBORDINATE" },
        orderBy: { name: "asc" },
        select: { id: true, name: true, position: true },
      });
      const [card] = await buildDecisionCards(deps.db, d.leaderId, [d]);
      await deps.messenger.edit(input.chatId, input.messageId, `${cardText(card)}\n\n<b>Кому передать?</b>`, [
        ...people.map((p) => [{ text: `${p.name}, ${p.position}`, data: `d:t:${id}:${p.id}` }]),
        [{ text: "Назад", data: `d:b:${id}` }],
      ]);
      return "Выберите сотрудника";
    }
    case "b": {
      const [card] = await buildDecisionCards(deps.db, d.leaderId, [d]);
      await deps.messenger.edit(input.chatId, input.messageId, cardText(card), cardButtons(id));
      return "Ок";
    }
    default:
      return "Неизвестное действие";
  }
}

/** Текст от пользователя: сейчас это только ответ на «Поправить». */
export async function handleText(deps: Deps, chatId: string, text: string): Promise<string> {
  const pending = await deps.state.get(editKey(chatId));
  if (text.trim() === "/cancel") {
    await deps.state.del(editKey(chatId));
    return "Отменила.";
  }
  if (pending) {
    const d = await authorize(deps, chatId, pending);
    await deps.state.del(editKey(chatId));
    if (!d) return "Не могу применить правку: нет доступа к карточке.";
    const body = text.trim();
    if (!body) return "Текст пустой, правку не применила.";
    const msg = await resolveAndRefresh(deps, chatId, pending, d.leaderId, { action: "EDITED_APPROVED", editedText: body });
    return msg === "Готово" ? `Принято, использую ваш вариант:\n${esc(body)}` : msg;
  }
  const bound = await deps.db.telegramBinding.count({ where: { chatId } });
  return bound === 0
    ? "Чтобы начать, откройте ссылку-приглашение, которую вам прислали."
    : "Пока я отвечаю кнопками на карточках. Разговор с помощником в чате появится позже.";
}
