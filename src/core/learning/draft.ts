/**
 * Черновик ответа руководителю на письмо (SPEC 4.2.3): стиль из профиля + активная Memory.
 * Черновик пишет ИИ-помощник как руководитель; в первой фразе он называет себя помощником, подписи нет.
 * Решение «отправлять ли» остаётся за руководителем и Policy Gate.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import type { IngestOptions } from "../email-triage/ingest";
import { threadKey } from "../email-triage/threads";
import type { LlmClient } from "../llm";

export const DraftSchema = z.object({
  text: z.string().min(1).max(4000),
  /** В письме просят согласовать или отказать: руководителю нужны две кнопки. */
  needsVerdict: z.boolean().optional(),
  /** Готовый ответ-отказ; нужен только вместе с needsVerdict. `text` тогда ответ-согласие. */
  declineText: z.string().min(1).max(4000).optional(),
});

/** Активные правила руководителя для области (GLOBAL всегда). Только его, только включённые. */
export async function activeMemoryRules(db: PrismaClient, leaderId: string, scope: "EMAIL" | "MEETING" | "TASK" = "EMAIL"): Promise<string[]> {
  const rows = await db.memory.findMany({
    where: { leaderId, isActive: true, scope: { in: ["GLOBAL", scope] } },
    orderBy: { createdAt: "asc" },
    select: { ruleText: true },
  });
  return rows.map((r) => r.ruleText);
}

/** Подписи ИИ-помощника в письмах больше нет: бот отвечает как руководитель (решение владельца продукта). Функция оставлена для вызовов и только чистит текст. */
export function ensureSignature(text: string, _leaderName: string): string {
  return text.trim();
}

const memoryHash = (rules: readonly string[]) => createHash("sha256").update(rules.join("\n")).digest("hex").slice(0, 12);

/** Хук `draft` для ingestEmails. Кэш по треду и набору правил: новое правило даёт новый черновик. */
export function createDraftGenerator(db: PrismaClient, llm: LlmClient): NonNullable<IngestOptions["draft"]> {
  return async ({ leaderId, email, summary }) => {
    const leader = await db.leader.findFirstOrThrow({ where: { id: leaderId }, select: { name: true, stylePrompt: true } });
    const rules = await activeMemoryRules(db, leaderId, "EMAIL");

    const system = [
      `Ты ИИ-помощник руководителя ${leader.name}. Напиши черновик ответа на письмо от своего имени:`,
      `Начни с приветствия по имени отправителя и в той же фразе скажи, кто пишет: «Это ИИ-помощник ${leader.name}». Подписи в конце не нужно, не выдавай себя за руководителя.`,
      "Пиши готовый ответ по существу, как ответил бы руководитель: сам предложи решение, которое следует из письма и правил ниже (например, просят согласовать и условия выполнены: сообщи, что согласовано). Руководитель только утвердит или поправит текст.",
      "Если в письме просят согласовать, утвердить или отказать, поставь needsVerdict=true: в text напиши ответ-согласие, в declineText ответ-отказ, оба готовые к отправке. Иначе needsVerdict=false и declineText не заполняй.",
      "Никогда не пиши «передал руководителю», «решение за руководителем» и не выставляй срок ответа: руководитель читает этот текст как готовое письмо.",
      "Не придумывай даты, суммы, имена и факты, которых нет в письме или в правилах ниже. Если для ответа нужна конкретная дата или сумма, которой нет в письме, оставь «[срок]» или «[сумма]».",
      "Это сильнее любых выученных правил: правило может менять манеру письма, но не разрешает выдумывать содержание.",
      "Пиши живым деловым языком, как вежливый человек, а не как справка: связные предложения вместо телеграфного стиля, без канцелярита и штампов («условия выполнены», «в рамках данного вопроса»). Не раздавай команды третьим лицам («пусть Ирина оформляет»): скажи, что произойдёт дальше, и от лица отправителя. Три-пять предложений, ровный тёплый тон, без смайликов и восклицаний, кроме приветствия.",
      "Согласие: подтверди по-человечески, назови, что именно согласовано, и скажи следующий шаг. Отказ: вежливо, с причиной, если она есть в письме или правилах, без резкости.",
      `Плохо: «Здравствуйте! ИИ-помощник ${leader.name}. Согласовано. Замена найдена — условия выполнены. Пусть Ирина оформляет отпуск.» Хорошо: «Здравствуйте, Мария! Это ИИ-помощник ${leader.name}. Отпуск Ирины с 20 по 30 декабря согласован, спасибо, что заранее подобрали замену. Можно оформлять заявку в обычном порядке.»`,
      "Коротко, по-русски.",
      leader.stylePrompt ? `Манера руководителя: ${leader.stylePrompt}` : "",
      rules.length ? `Учти выученные правила руководителя:\n${rules.map((r) => `- ${r}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join(" ");

    const res = await llm.generateStructured({
      leaderId,
      pipeline: "DRAFT",
      schema: DraftSchema,
      system,
      prompt: `От: ${email.senderName} <${email.senderEmail}>\nТема: ${email.subject}\n\n${email.body}\n\nСуть: ${summary}`,
      // d2: версия промпта; без неё старые черновики из кэша остались бы в прежнем (роботизированном) стиле.
      cacheKey: `${threadKey(email.senderEmail, email.subject, email.body)}:${memoryHash(rules)}:d2`,
      temperature: 0.2,
    });
    const text = res.text.trim();
    // Две кнопки только если модель дала оба ответа; иначе обычный черновик.
    return res.needsVerdict && res.declineText ? { text, declineText: res.declineText.trim() } : text;
  };
}
