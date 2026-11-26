/**
 * Ретрансляция событий в Telegram: что воркер делает на каждое событие шины.
 * Вынесено из worker/, чтобы покрыть тестами без Telegram.
 */
import type { LeaderEvent } from "../events";
import { dispatchTask, executeApprovedToolCall, type DispatchDeps } from "../tasks/dispatch";
import { refreshDecisionCard, sendDecisionCard } from "./cards";

/** Возвращает короткое описание сделанного (для лога) или null, если событие воркеру не нужно. */
export async function relayEvent(deps: DispatchDeps, leaderId: string, e: LeaderEvent): Promise<string | null> {
  const id = typeof e.data.id === "string" ? e.data.id : null;
  if (!id) return null;

  if (e.type === "decision.created") {
    return (await sendDecisionCard(deps.db, deps.messenger, leaderId, id)) ? `карточка ${id} отправлена` : null;
  }

  if (e.type === "decision.updated") {
    await refreshDecisionCard(deps.db, deps.messenger, leaderId, id);
    // Подтверждённое руководителем действие (например, отправка поручения) исполняется только здесь, после шлюза.
    const res = await executeApprovedToolCall(deps, leaderId, id);
    return res ? `карточка ${id} обновлена, действие: ${res.status}` : `карточка ${id} обновлена`;
  }

  // Новое поручение: отправка исполнителю через Policy Gate. Остальные task.updated воркеру не нужны.
  if (e.type === "task.updated" && e.data.created === true) {
    const res = await dispatchTask(deps, leaderId, id);
    return `поручение ${id}: ${res.status}`;
  }
  return null;
}
