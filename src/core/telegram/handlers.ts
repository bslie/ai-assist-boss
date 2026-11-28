/**
 * Обработчики колбэков и текста (SPEC 5.1). callback_data:
 *   d:a|e|d|s|b:<decisionId>   утвердить / поправить / передать / не сейчас / назад
 *   d:p:<decisionId>           протокол: утвердить и разослать только исполнителям
 *   d:t:<decisionId>:<empId>   передать сотруднику
 *   r:<bindingId>              сменить роль
 * Каждое решение проходит ту же функцию resolveDecision, что и веб; чужие карточки недоступны.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { resolveDecision, type ResolveInput } from "../decisions";
import { publishEvent } from "../events";
import { acceptMemory, rejectMemory } from "../learning/propose";
import { proposeRuleFromText, saveRuleProposal, type RuleProposal } from "../learning/rule-words";
import { handleChat } from "../chat";
import type { LlmClient } from "../llm";
import { randomUUID } from "node:crypto";
import { clock } from "../clock";
import { taskText } from "../tasks/dispatch";
import { parseRescheduleText, requestReschedule, submitResult, taskActionButtons, tellLeader } from "../tasks/lifecycle";
import { buildDecisionCards } from "../dashboard";
import { cardButtons, cardText, refreshDecisionCard } from "./cards";
import { leaderIdsForChat, switchRole } from "./bindings";
import { esc, type Messenger, type StateStore } from "./types";

export interface Deps {
  db: PrismaClient;
  messenger: Messenger;
  state: StateStore;
  /** Воркер умеет анализировать правки (есть LLM): после правки обещаем сообщить о найденном правиле. */
  learns?: boolean;
  /** Модель для правил словами и разговора руководителя в чате; без неё текст вне карточек не обрабатывается. */
  llm?: LlmClient;
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
  DRAFT_INCOMPLETE: "В черновике есть пропуск. Нажмите «Поправить» и впишите значение",
};

async function resolveAndRefresh(deps: Deps, chatId: string, decisionId: string, leaderId: string, input: ResolveInput): Promise<string> {
  const res = await resolveDecision(deps.db, leaderId, decisionId, input);
  // Карточка в чате обновляется всегда: и после решения, и если оно уже было принято в вебе.
  await refreshDecisionCard(deps.db, deps.messenger, leaderId, decisionId).catch(() => {});
  if (res.ok) return input.action === "SNOOZE" ? "Верну в утреннем плане" : "Готово";
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
  if (kind === "u" && action && id) return handleRuleCallback(deps, input, action, id);
  if (kind !== "d" || !action || !id) return "Неизвестное действие";

  const d = await authorize(deps, input.chatId, id);
  if (!d) return "Нет доступа к этой карточке";

  switch (action) {
    case "a":
      return resolveAndRefresh(deps, input.chatId, id, d.leaderId, { action: "APPROVE" });
    case "p":
      if (d.type !== "MEETING_PROTOCOL") return "Неизвестное действие";
      return resolveAndRefresh(deps, input.chatId, id, d.leaderId, { action: "APPROVE", protocolRecipients: "IN_PROTOCOL" });
    case "s":
      return resolveAndRefresh(deps, input.chatId, id, d.leaderId, { action: "SNOOZE" });
    case "t":
      if (!extra) return "Не выбран сотрудник";
      return resolveAndRefresh(deps, input.chatId, id, d.leaderId, { action: "DELEGATE", delegateToId: extra });
    case "e": {
      if (d.status !== "PENDING") return "Уже решено";
      await deps.state.set(editKey(input.chatId), id, EDIT_TTL);
      // Черновик отдельным сообщением: по нажатию на моноширинный текст он копируется, правится и отправляется назад.
      await deps.messenger.send(
        input.chatId,
        [
          "Ответьте на карточку своим текстом или просто пришлите его сообщением. Отмена: /cancel",
          d.draftText ? `\nЧерновик, его можно скопировать:\n<code>${esc(d.draftText)}</code>` : "",
        ].join(""),
      );
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
      await deps.messenger.edit(input.chatId, input.messageId, cardText(card), cardButtons(id, d.type, d.draftText));
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
const reschedKey = (chatId: string) => `tg:resched:${chatId}`;
const submitKey = (chatId: string) => `tg:submit:${chatId}`;
const ruleKey = (id: string) => `tg:rule:${id}`;
const RULE_TTL = 900;

/** u:s|w|c:<id> — «Сохранить» / «Только на неделю» / «Отмена» на черновике правила (SPEC 4.4.2). */
async function handleRuleCallback(deps: Deps, input: CallbackInput, action: string, id: string): Promise<string> {
  const raw = await deps.state.get(ruleKey(id));
  if (!raw) return "Предложение устарело: скажите правило ещё раз";
  const stored = JSON.parse(raw) as { leaderId: string; proposal: RuleProposal };
  const allowed = await leaderIdsForChat(deps.db, input.chatId);
  if (!allowed.includes(stored.leaderId)) return "Нет доступа к этому правилу";
  await deps.state.del(ruleKey(id)); // решение одно: повторное нажатие ничего не сохранит

  if (action === "c") {
    await deps.messenger.edit(input.chatId, input.messageId, "Хорошо, правило не сохраняю.").catch(() => {});
    return "Отменено";
  }
  if (action !== "s" && action !== "w") return "Неизвестное действие";
  const res = await saveRuleProposal(deps.db, stored.leaderId, { ...stored.proposal, weekOnly: false }, { weekOnly: action === "w" });
  if (!res.ok) {
    await deps.messenger.edit(input.chatId, input.messageId, `Не могу так сделать. ${esc(res.message)}`).catch(() => {});
    return "Не сохранено";
  }
  await publishEvent(stored.leaderId, { type: "metrics.updated", data: {} });
  await deps.messenger.edit(input.chatId, input.messageId, `Запомнила: ${esc(stored.proposal.summary)}${action === "w" ? " (на неделю)" : ""}`).catch(() => {});
  return action === "w" ? "Запомнила на неделю" : "Запомнила";
}

/**
 * Свободный текст руководителя: правило словами (с подтверждением кнопками) или обычный разговор.
 * null — чат не руководителя или нет модели: пусть отвечает общий текст.
 */
async function leaderTalk(deps: Deps, chatId: string, text: string): Promise<string | null> {
  if (!deps.llm) return null;
  const binding =
    (await deps.db.telegramBinding.findFirst({ where: { chatId, role: "LEADER", isActive: true } })) ??
    (await deps.db.telegramBinding.findFirst({ where: { chatId, role: "LEADER" } }));
  if (!binding) return null;
  const body = text.trim();
  if (!body || body.startsWith("/")) return null;

  const proposed = await proposeRuleFromText(deps.db, deps.llm, binding.leaderId, body);
  if (proposed.ok) {
    const id = randomUUID().slice(0, 12);
    await deps.state.set(ruleKey(id), JSON.stringify({ leaderId: binding.leaderId, proposal: proposed.proposal }), RULE_TTL);
    await deps.messenger.send(chatId, `Я поняла так: <b>${esc(proposed.proposal.summary)}</b>
Сохранить?`, [
      [
        { text: "Сохранить", data: `u:s:${id}` },
        { text: "Только на неделю", data: `u:w:${id}` },
      ],
      [{ text: "Отмена", data: `u:c:${id}` }],
    ]);
    return "";
  }
  if (!proposed.notARule) return esc(proposed.message);

  const reply = await handleChat(deps.db, deps.llm, binding.leaderId, body);
  return [esc(reply.text), reply.draft ? `
<i>${esc(reply.draft)}</i>` : ""].join("");
}

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
        .edit(
          input.chatId,
          input.messageId,
          `${taskText({ leaderName: "", title: task.title, dueAt: task.dueAt, criteria: task.acceptanceCriteria }).split("\n").slice(1).join("\n")}\n\n<b>Принято в работу.</b>`,
          taskActionButtons({ id: task.id, status: "ACCEPTED" }),
        )
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
      await deps.state.set(reschedKey(input.chatId), task.id, EDIT_TTL);
      await deps.messenger.send(input.chatId, `Срок сейчас: ${esc(fmtShort(task.dueAt))}. Напишите одним сообщением новую дату (например, 15.12) и причину. Отмена: /cancel`);
      return "Жду новый срок";
    }
    case "s": {
      await deps.state.set(submitKey(input.chatId), task.id, EDIT_TTL);
      await deps.messenger.send(input.chatId, `Пришлите результат по задаче «${title}» одним сообщением: текст или ссылку. Отмена: /cancel`);
      return "Жду результат";
    }
    default:
      return "Неизвестное действие";
  }
}

/** Исполнитель прислал новую дату и причину: перенос сам или карточка руководителю (SPEC 4.3.3). */
async function handleReschedule(deps: Deps, chatId: string, taskId: string, text: string): Promise<string> {
  const task = await authorizeAssignee(deps, chatId, taskId);
  if (!task || !task.assignee) return "Не могу перенести срок: нет доступа к задаче.";
  const parsed = await parseRescheduleText(deps.llm, task.leaderId, text, clock.now()).catch(() => null);
  if (!parsed) {
    await deps.state.set(reschedKey(chatId), taskId, EDIT_TTL);
    return "Не поняла дату. Напишите, например: «до 15.12, жду данные от клиента». Отмена: /cancel";
  }
  const res = await requestReschedule(deps, task.leaderId, task.id, parsed.newDueAt, parsed.reason);
  if (res.status === "rescheduled") return `Перенесла срок на ${esc(fmtShort(res.dueAt))}. Руководитель увидит это в сводке.`;
  if (res.status === "awaiting_leader") {
    await tellLeader(deps, task.leaderId, `${esc(task.assignee.name)} просит перенести срок по задаче «${esc(task.title)}». Карточка выше.`);
    return `Срок не двигаю сама: ${esc(res.reason.toLowerCase())}. Передала руководителю, отвечу, как только он решит.`;
  }
  return `Не получилось: ${esc(res.reason)}.`;
}

/** Исполнитель сдал результат: сверка с критерием, возврат, закрытие или карточка «Принять» (SPEC 4.3.5). */
async function handleSubmit(deps: Deps, chatId: string, taskId: string, text: string): Promise<string> {
  const task = await authorizeAssignee(deps, chatId, taskId);
  if (!task || !task.assignee) return "Не могу принять результат: нет доступа к задаче.";
  const res = await submitResult(deps, task.leaderId, task.id, text);
  switch (res.status) {
    case "returned":
      await deps.messenger.send(
        chatId,
        `Проверила результат по задаче «${esc(task.title)}». Нужно доработать:\n${res.shortcomings.map((s) => `• ${esc(s)}`).join("\n")}`,
        [[{ text: "Сдать результат", data: `t:s:${task.id}` }]],
      );
      return "";
    case "done":
      return `Результат соответствует критерию, задача «${esc(task.title)}» закрыта. Спасибо!`;
    case "awaiting_leader":
      return "Результат соответствует критерию. Передала руководителю на приёмку, напишу, когда он решит.";
    default:
      return `Не получилось принять результат: ${esc(res.reason)}.`;
  }
}

/** Ответ после правки. Если воркер анализирует правки, предупреждаем, что сообщение придёт чуть позже (10–20 секунд). */
function afterEdit(deps: Deps, resolved: string, body: string): string {
  if (resolved !== "Готово") return resolved;
  const wait = deps.learns ? "\n\nПосмотрю, нет ли в правке правила для памяти. Если есть, напишу через несколько секунд." : "";
  return `Принято, использую ваш вариант:\n${esc(body)}${wait}`;
}

const fmtShort = (d: Date) =>
  new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(d);

/** Текст от пользователя: ответ на «Поправить» (руководитель) или на «Уточнить» (исполнитель). */
export async function handleText(deps: Deps, chatId: string, text: string, opts: { replyToMessageId?: string } = {}): Promise<string> {
  const pending = await deps.state.get(editKey(chatId));
  const clarify = await deps.state.get(clarifyKey(chatId));
  if (text.trim() === "/cancel") {
    await deps.state.del(editKey(chatId));
    await deps.state.del(clarifyKey(chatId));
    await deps.state.del(reschedKey(chatId));
    await deps.state.del(submitKey(chatId));
    return "Отменила.";
  }

  const resched = await deps.state.get(reschedKey(chatId));
  if (resched) {
    await deps.state.del(reschedKey(chatId));
    return handleReschedule(deps, chatId, resched, text);
  }
  const submit = await deps.state.get(submitKey(chatId));
  if (submit) {
    await deps.state.del(submitKey(chatId));
    return handleSubmit(deps, chatId, submit, text);
  }

  // Ответ (reply) на сообщение с карточкой = правка этой карточки, кнопка «Поправить» не нужна.
  if (opts.replyToMessageId && !clarify) {
    const card = await deps.db.decision.findFirst({
      where: { telegramMessageId: `${chatId}:${opts.replyToMessageId}`, status: "PENDING" },
    });
    if (card) {
      const d = await authorize(deps, chatId, card.id);
      if (!d) return "Не могу применить правку: нет доступа к карточке.";
      const body = text.trim();
      if (!body) return "Текст пустой, правку не применила.";
      await deps.state.del(editKey(chatId));
      return afterEdit(deps, await resolveAndRefresh(deps, chatId, card.id, d.leaderId, { action: "EDITED_APPROVED", editedText: body }), body);
    }
  }
  if (clarify) {
    await deps.state.del(clarifyKey(chatId));
    const task = await authorizeAssignee(deps, chatId, clarify);
    if (!task || !task.assignee) return "Не могу передать вопрос: нет доступа к задаче.";
    const body = text.trim();
    if (!body) return "Текст пустой, вопрос не передала.";
    await notifyLeader(deps, task.leaderId, `Вопрос по задаче «${esc(task.title)}», ${esc(task.assignee.name)}:\n${esc(body)}`);
    return "Передала ваш вопрос руководителю.";
  }
  if (pending) {
    const d = await authorize(deps, chatId, pending);
    await deps.state.del(editKey(chatId));
    if (!d) return "Не могу применить правку: нет доступа к карточке.";
    const body = text.trim();
    if (!body) return "Текст пустой, правку не применила.";
    return afterEdit(deps, await resolveAndRefresh(deps, chatId, pending, d.leaderId, { action: "EDITED_APPROVED", editedText: body }), body);
  }
  const talk = await leaderTalk(deps, chatId, text).catch(() => "Не смогла разобрать сообщение. Попробуйте ещё раз чуть позже.");
  if (talk !== null) return talk;
  const bound = await deps.db.telegramBinding.count({ where: { chatId } });
  return bound === 0
    ? "Чтобы начать, откройте ссылку-приглашение, которую вам прислали."
    : "Пока я отвечаю кнопками на карточках. Разговор с помощником в чате появится позже.";
}
