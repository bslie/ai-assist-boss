/**
 * Обработчики колбэков и текста (SPEC 5.1). callback_data:
 *   d:a|e|d|s|b:<decisionId>   утвердить / поправить / передать / не сейчас / назад
 *   d:t:<decisionId>:<empId>   передать сотруднику
 *   r:<bindingId>              сменить роль
 * Каждое решение проходит ту же функцию resolveDecision, что и веб; чужие карточки недоступны.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { resolveDecision, type ResolveInput } from "../decisions";
import { publishEvent } from "../events";
import { acceptMemory, rejectMemory } from "../learning/propose";
import { taskText } from "../tasks/dispatch";
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
  if (kind === "t" && action && id) return handleTaskCallback(deps, input, action, id);
  if (kind === "m" && action && id) return handleMemoryCallback(deps, input, action, id);
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

/** m:y|n:<memoryId> — «Да, запомнить» / «Только этот раз» на предложении правила. */
async function handleMemoryCallback(deps: Deps, input: CallbackInput, action: string, memoryId: string): Promise<string> {
  const m = await deps.db.memory.findUnique({ where: { id: memoryId } });
  if (!m) return "Правило не найдено";
  const allowed = await leaderIdsForChat(deps.db, input.chatId);
  if (!allowed.includes(m.leaderId)) return "Нет доступа к этому правилу";

  if (action === "y") {
    const r = await acceptMemory(deps.db, m.leaderId, memoryId);
    if (r === "already") return "Уже запомнила";
    await deps.messenger.edit(input.chatId, input.messageId, `Запомнила: <b>${esc(m.ruleText)}</b>`).catch(() => {});
    return "Запомнила";
  }
  if (action === "n") {
    const r = await rejectMemory(deps.db, m.leaderId, memoryId);
    if (r === "already") return "Это правило уже запомнено";
    await deps.messenger.edit(input.chatId, input.messageId, "Хорошо, это только на этот раз.").catch(() => {});
    return "Ок, только этот раз";
  }
  return "Неизвестное действие";
}

const clarifyKey = (chatId: string) => `tg:clarify:${chatId}`;

/** Поручение доступно только своему исполнителю: чат должен быть привязан именно к нему. */
async function authorizeAssignee(deps: Deps, chatId: string, taskId: string) {
  const task = await deps.db.task.findUnique({ where: { id: taskId }, include: { assignee: true } });
  if (!task?.assigneeId) return null;
  const binding = await deps.db.telegramBinding.findFirst({
    where: { chatId, role: "EMPLOYEE", employeeId: task.assigneeId, leaderId: task.leaderId },
    select: { id: true },
  });
  return binding ? task : null;
}

/** Сообщение руководителю (его LEADER-чатам). Руководителю можно писать без шлюза: это его собственный помощник. */
async function notifyLeader(deps: Deps, leaderId: string, text: string) {
  const chats = await deps.db.telegramBinding.findMany({ where: { leaderId, role: "LEADER" }, select: { chatId: true } });
  for (const chatId of new Set(chats.map((c) => c.chatId))) await deps.messenger.send(chatId, text);
}

/** t:a|c|r:<taskId> — «Принял» / «Уточнить» / «Не успею» от исполнителя. */
async function handleTaskCallback(deps: Deps, input: CallbackInput, action: string, taskId: string): Promise<string> {
  const task = await authorizeAssignee(deps, input.chatId, taskId);
  if (!task || !task.assignee) return "Нет доступа к этой задаче";
  const who = esc(task.assignee.name);
  const title = esc(task.title);

  switch (action) {
    case "a": {
      // Условный переход NEW → ACCEPTED: повторное нажатие ничего не меняет.
      const upd = await deps.db.task.updateMany({
        where: { id: task.id, leaderId: task.leaderId, assigneeId: task.assigneeId, status: "NEW" },
        data: { status: "ACCEPTED" },
      });
      if (upd.count === 0) return "Уже принято";
      await deps.messenger
        .edit(input.chatId, input.messageId, `${taskText({ leaderName: "", title: task.title, dueAt: task.dueAt, criteria: task.acceptanceCriteria }).split("\n").slice(1).join("\n")}\n\n<b>Принято в работу.</b>`)
        .catch(() => {});
      await publishEvent(task.leaderId, { type: "task.updated", data: { id: task.id } });
      await notifyLeader(deps, task.leaderId, `${who} принял задачу «${title}».`);
      return "Принято";
    }
    case "c": {
      await deps.state.set(clarifyKey(input.chatId), task.id, EDIT_TTL);
      await deps.messenger.send(input.chatId, "Напишите вопрос одним сообщением, я передам его руководителю. Отмена: /cancel");
      return "Жду ваш вопрос";
    }
    case "r": {
      // Перенос срока — P1. Пока сообщаем руководителю, статус и срок не меняем.
      await notifyLeader(deps, task.leaderId, `${who} сообщает, что не успеет по задаче «${title}». Срок сейчас: ${esc(fmtShort(task.dueAt))}.`);
      return "Сообщила руководителю";
    }
    default:
      return "Неизвестное действие";
  }
}

const fmtShort = (d: Date) =>
  new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(d);

/** Текст от пользователя: ответ на «Поправить» (руководитель) или на «Уточнить» (исполнитель). */
export async function handleText(deps: Deps, chatId: string, text: string): Promise<string> {
  const pending = await deps.state.get(editKey(chatId));
  const clarify = await deps.state.get(clarifyKey(chatId));
  if (text.trim() === "/cancel") {
    await deps.state.del(editKey(chatId));
    await deps.state.del(clarifyKey(chatId));
    return "Отменила.";
  }
  if (clarify) {
    await deps.state.del(clarifyKey(chatId));
    const task = await authorizeAssignee(deps, chatId, clarify);
    if (!task || !task.assignee) return "Не могу передать вопрос: нет доступа к задаче.";
    const body = text.trim();
    if (!body) return "Текст пустой, вопрос не передала.";
    await notifyLeader(deps, task.leaderId, `Вопрос от ${esc(task.assignee.name)} по задаче «${esc(task.title)}»:\n${esc(body)}`);
    return "Передала ваш вопрос руководителю.";
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
