/**
 * Ретрансляция событий в Telegram: что воркер делает на каждое событие шины.
 * Вынесено из worker/, чтобы покрыть тестами без Telegram.
 */
import type { LeaderEvent } from "../events";
import { proposeLearning } from "../learning/propose";
import type { LlmClient } from "../llm";
import { dispatchTask, executeApprovedToolCall, type DispatchDeps } from "../tasks/dispatch";
import { executeBusinessReply } from "./business";
import { refreshDecisionCard, sendDecisionCard } from "./cards";
import { esc } from "./types";

export interface RelayDeps extends DispatchDeps {
  /** Нужна для обучения на правках. Нет модели — правки просто не анализируются. */
  llm?: LlmClient;
}

/** Возвращает короткое описание сделанного (для лога) или null, если событие воркеру не нужно. */
export async function relayEvent(deps: RelayDeps, leaderId: string, e: LeaderEvent): Promise<string | null> {
  const id = typeof e.data.id === "string" ? e.data.id : null;
  if (!id) return null;

  if (e.type === "decision.created") {
    return (await sendDecisionCard(deps.db, deps.messenger, leaderId, id)) ? `карточка ${id} отправлена` : null;
  }

  if (e.type === "decision.updated") {
    await refreshDecisionCard(deps.db, deps.messenger, leaderId, id);
    // Подтверждённое руководителем действие (например, отправка поручения) исполняется только здесь, после шлюза.
    const res = await executeApprovedToolCall(deps, leaderId, id);
    const parts = [`карточка ${id} обновлена`];
    if (res) parts.push(`действие: ${res.status}`);
    // Ответ в личный чат от аккаунта руководителя (Telegram Business): тоже только после утверждения и шлюза.
    const reply = await executeBusinessReply(deps, leaderId, id);
    if (reply) {
      parts.push(`ответ в чат: ${reply.status}${reply.status === "skipped" ? ` (${reply.reason})` : ""}`);
      // Утверждённый ответ не ушёл: руководитель должен узнать об этом, а не гадать.
      if (reply.status === "denied" || (reply.status === "skipped" && reply.reason !== "уже отправлено")) {
        const why = reply.status === "denied" ? "действие запрещено в настройках подключения" : reply.reason;
        const chats = await deps.db.telegramBinding.findMany({ where: { leaderId, role: "LEADER" }, select: { chatId: true } });
        for (const chatId of new Set(chats.map((c) => c.chatId))) {
          await deps.messenger.send(chatId, `Ответ утверждён, но не отправлен: ${esc(why)}.`);
        }
      }
    }
    // Правка руководителя → фоновый анализ: нет ли устойчивого правила для памяти.
    if (e.data.status === "EDITED_APPROVED" && deps.llm) {
      const l = await proposeLearning({ db: deps.db, messenger: deps.messenger, llm: deps.llm }, leaderId, id);
      parts.push(`обучение: ${l.status}`);
    }
    return parts.join(", ");
  }

  // Новое поручение: отправка исполнителю через Policy Gate. Остальные task.updated воркеру не нужны.
  if (e.type === "task.updated" && e.data.created === true) {
    const res = await dispatchTask(deps, leaderId, id);
    return `поручение ${id}: ${res.status}`;
  }
  return null;
}
