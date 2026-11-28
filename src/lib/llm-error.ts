/**
 * Ошибка вызова модели → фраза для руководителя. Сырой текст («The operation was aborted due to timeout»,
 * «Rate limit exceeded», тело ответа провайдера) в интерфейс не попадает: он ничего не говорит и может раскрыть настройки.
 * Подробности остаются в логе сервера.
 */
export function friendlyLlmError(e: unknown): string {
  const text = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  console.error("[llm]", text.slice(0, 500));
  if (/timeout|timed out|aborted|abort/i.test(text)) return "Модель отвечает слишком долго. Попробуйте ещё раз.";
  if (/\b429\b|rate.?limit|too many requests|quota|overload/i.test(text)) return "Модель сейчас перегружена. Попробуйте через минуту.";
  if (/\b(401|402|403)\b|unauthori[sz]ed|forbidden|api key|insufficient|credit/i.test(text)) return "Нет доступа к модели. Сообщите администратору стенда.";
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|network|socket/i.test(text)) return "Нет связи с моделью. Попробуйте ещё раз.";
  return "Не получилось обработать запрос. Попробуйте ещё раз или скажите иначе.";
}
