/**
 * «Задержка ответа ИИ» в настройках Telegram Business: сколько минут ИИ ждёт, прежде чем разобрать сообщение
 * сотрудника в личном чате руководителя. Если за это время руководитель ответил сам, ИИ не вмешивается.
 * Чистый модуль: его читают и проверка при сохранении настройки, и бизнес-логика.
 */
export const DEFAULT_REPLY_DELAY_MINUTES = 30;
export const MAX_REPLY_DELAY_MINUTES = 1440;

/** Пустое или неверное значение даёт значение по умолчанию: ожидание лучше, чем вмешательство в чужой разговор. */
export function parseReplyDelay(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined || String(raw).trim() === "") return DEFAULT_REPLY_DELAY_MINUTES;
  const n = Number(String(raw).trim().replace(",", "."));
  if (!Number.isInteger(n) || n < 0 || n > MAX_REPLY_DELAY_MINUTES) return DEFAULT_REPLY_DELAY_MINUTES;
  return n;
}

/** Для проверки при сохранении: понятная ошибка вместо молчаливой подстановки. */
export function validateReplyDelay(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw.trim().replace(",", "."));
  if (!Number.isInteger(n) || n < 0 || n > MAX_REPLY_DELAY_MINUTES) {
    return `«Задержка ответа ИИ»: целое число минут от 0 до ${MAX_REPLY_DELAY_MINUTES} (0 — отвечать сразу)`;
  }
  return null;
}
