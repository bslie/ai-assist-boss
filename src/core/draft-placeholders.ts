/**
 * Пропуск в черновике: «[срок]», «[дата]». Модель оставляет его руководителю вместо выдуманного значения
 * (см. `learning/draft.ts`). Письмо с таким пропуском уйти не должно: карточка подсвечивает его,
 * а `resolveDecision` не даёт утвердить текст, пока пропуск не заполнен.
 *
 * Чистый модуль без зависимостей: его читают и сервер, и клиентская карточка.
 */

// Не трогаем чекбоксы «[x]», «[ ]» и markdown-ссылки «[текст](адрес)». Внутри должна быть хотя бы одна буква.
const PLACEHOLDER = /\[(?=[^\]\n]*\p{L})[^\]\n]{2,40}\](?!\()/gu;

/** Уникальные пропуски в тексте в порядке появления; пустой массив — текст готов к отправке. */
export function findPlaceholders(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...new Set(text.match(PLACEHOLDER) ?? [])];
}

/** Делит текст на куски так, чтобы пропуски можно было подсветить: `{ text, gap }`. */
export function splitPlaceholders(text: string): { text: string; gap: boolean }[] {
  const out: { text: string; gap: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(PLACEHOLDER)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at), gap: false });
    out.push({ text: m[0], gap: true });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), gap: false });
  return out;
}
