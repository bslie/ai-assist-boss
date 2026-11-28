/**
 * Подсказки под полем чата: 3–5 готовых реплик руководителя, которые модель составляет по его собственному
 * контексту (встречи, карточки, письма, подключения). Это только тексты для кнопок: нажатие отправляет их в чат
 * обычным путём, внешних эффектов у подсказок нет. Нет LLM или она ответила ошибкой — безопасный общий набор.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { buildChatContext } from "./chat";
import { clock } from "./clock";
import type { LlmClient } from "./llm";

export const FALLBACK_SUGGESTIONS = ["Что на сегодня?", "Что ты умеешь?", "Какие встречи можно пропустить?"];

export const SuggestionsSchema = z.object({
  suggestions: z.array(z.string().trim().min(3).max(60)).min(3).max(5),
});

const SYSTEM = [
  "Ты составляешь подсказки для кнопок под полем чата ИИ-помощника руководителя.",
  "Каждая подсказка — короткая реплика, которую сам руководитель мог бы написать помощнику (до 50 символов, по-русски, без точки в конце, без кавычек и нумерации).",
  "Подсказки строго по КОНТЕКСТУ: называй реальные встречи, письма, людей и задачи оттуда, а не абстрактные.",
  "Сначала самое срочное сегодня: ближайшая встреча, карточка, которая ждёт решения, просроченная задача, письмо, на которое нужен ответ.",
  "Если не подключена почта или календарь, одна подсказка — про подключение. Если режим обучения предлагает отпустить область, можно подсказать это.",
  "Предлагай только то, что помощник умеет по списку возможностей из контекста. Не выдумывай имена, даты и факты, которых нет в контексте. Подсказки не должны повторять друг друга по смыслу.",
].join(" ");

/** Один из «времён суток» для ключа кэша: подсказки живут час, пока контекст не поменялся. */
const hourBucket = (d: Date) => d.toISOString().slice(0, 13);

export async function generateSuggestions(db: PrismaClient, llm: LlmClient, leaderId: string): Promise<string[]> {
  const context = await buildChatContext(db, leaderId);
  // Первая строка контекста — текущее время с минутами: в ключ она не входит, иначе кэш не сработает ни разу.
  const stable = context.split("\n").slice(1).join("\n");
  const out = await llm.generateStructured({
    leaderId,
    pipeline: "CHAT",
    schema: SuggestionsSchema,
    system: SYSTEM,
    prompt: `КОНТЕКСТ\n${context}\n\nСоставь 4–5 подсказок.`,
    cacheKey: `suggestions\u0000${hourBucket(clock.now())}\u0000${createHash("sha256").update(stable).digest("hex")}`,
    temperature: 0.4,
  });
  const seen = new Set<string>();
  return out.suggestions.map(tidySuggestion).filter((s) => {
    const k = s.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Единый вид кнопок: заглавная первая буква, без точки в конце (модель отвечает по-разному). */
export function tidySuggestion(s: string): string {
  const t = s.trim().replace(/[.\s]+$/, "");
  return t ? t[0].toLocaleUpperCase("ru-RU") + t.slice(1) : t;
}
