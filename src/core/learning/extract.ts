/**
 * Обучение на правках (SPEC 4.4.1): сравнить черновик ИИ с правкой руководителя и вывести
 * устойчивое правило. Память влияет только на ЧЕРНОВИКИ; Policy Gate она не затрагивает,
 * поэтому правило не может сделать защищённое действие автоматическим.
 */
import { z } from "zod";
import type { LlmClient } from "../llm";

export const ExtractionSchema = z.object({
  found: z.boolean(),
  /** Одно предложение в повелительном наклонении: «Пиши коротко, без вводных фраз». */
  rule: z.string().max(240).nullable(),
  scope: z.enum(["GLOBAL", "EMAIL", "MEETING", "TASK"]),
  confidence: z.number().min(0).max(1),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

export const MIN_CONFIDENCE = 0.6;

/**
 * Правило, которое пытается снять подтверждение, включить авто или обойти защиту, не принимаем
 * (fail closed). Это дублирует защиту шлюза на уровне памяти: такое правило не должно даже
 * попасть в промпт.
 */
const UNSAFE = /без\s+(?:моего\s+)?(?:подтвержд|согласован|вопрос)|автоматическ|не\s+(?:спрашива|уточня|согласов)|сам[аи]?\s+(?:отправ|соглас|реша|утвержд)|всегда\s+(?:соглаш|утвержд|подтвержд)|игнорируй\s+(?:правил|огранич)/i;

export const isSafeRule = (text: string): boolean => !UNSAFE.test(text);

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

const SYSTEM = [
  "Ты сравниваешь черновик письма, который написал ИИ-помощник, с версией, которую отправил руководитель после правки.",
  "Задача: понять, есть ли УСТОЙЧИВОЕ различие в манере, которое стоит запомнить на будущее: тон, длина, структура,",
  "обращение, подпись, порядок мыслей, формулировки.",
  "Разовые правки по содержанию (имена, даты, суммы, конкретные факты, исправление ошибки) правилом не считаются: тогда found=false.",
  "Правило формулируй обобщённо, одним предложением в повелительном наклонении, без привязки к этому письму.",
  "Не придумывай правил про подтверждения, согласования и права: только про стиль и содержание текста.",
  "confidence — насколько ты уверен, что различие устойчивое, а не случайное.",
].join(" ");

export interface ExtractContext {
  leaderId: string;
  decisionId: string;
  /** Тема и суть письма, на которое отвечали. */
  subject: string;
  summary: string;
}

/** Возвращает правило или null (нет устойчивого различия, низкая уверенность, небезопасная формулировка). */
export async function extractRuleFromEdit(
  llm: LlmClient,
  draftText: string,
  editedText: string,
  ctx: ExtractContext,
): Promise<{ rule: string; scope: Extraction["scope"]; confidence: number } | null> {
  if (norm(draftText) === norm(editedText)) return null;

  const res = await llm.generateStructured({
    leaderId: ctx.leaderId,
    pipeline: "RULE_EXTRACTION",
    schema: ExtractionSchema,
    system: SYSTEM,
    prompt: `Письмо: ${ctx.subject}\nСуть: ${ctx.summary}\n\nЧерновик ИИ:\n${draftText}\n\nПосле правки руководителя:\n${editedText}`,
    cacheKey: `${ctx.decisionId}\u0000${norm(editedText)}`,
    temperature: 0,
  });

  const rule = res.rule?.trim();
  if (!res.found || !rule || res.confidence < MIN_CONFIDENCE) return null;
  if (!isSafeRule(rule)) return null;
  return { rule, scope: res.scope, confidence: res.confidence };
}
