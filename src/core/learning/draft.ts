/**
 * Черновик ответа руководителю на письмо (SPEC 4.2.3): стиль из профиля + активная Memory.
 * Черновик пишет ИИ-помощник от своего имени и подписывается им (этика, инвариант 7).
 * Решение «отправлять ли» остаётся за руководителем и Policy Gate.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import type { IngestOptions } from "../email-triage/ingest";
import { threadKey } from "../email-triage/threads";
import type { LlmClient } from "../llm";

export const DraftSchema = z.object({ text: z.string().min(1).max(4000) });

/** Активные правила руководителя для области (GLOBAL всегда). Только его, только включённые. */
export async function activeMemoryRules(db: PrismaClient, leaderId: string, scope: "EMAIL" | "MEETING" | "TASK" = "EMAIL"): Promise<string[]> {
  const rows = await db.memory.findMany({
    where: { leaderId, isActive: true, scope: { in: ["GLOBAL", scope] } },
    orderBy: { createdAt: "asc" },
    select: { ruleText: true },
  });
  return rows.map((r) => r.ruleText);
}

export function ensureSignature(text: string, leaderName: string): string {
  const sig = `ИИ-помощник ${leaderName}`;
  // Модель иногда ставит подпись и первой строкой: оставляем только конечную, чтобы не было дубля.
  const lines = text.trim().split("\n");
  while (lines.length > 1 && lines[0]!.trim() === sig) lines.shift();
  const body = lines.join("\n").trim();
  return body.includes(sig) ? body : `${body}\n\n${sig}`;
}

const memoryHash = (rules: readonly string[]) => createHash("sha256").update(rules.join("\n")).digest("hex").slice(0, 12);

/** Хук `draft` для ingestEmails. Кэш по треду и набору правил: новое правило даёт новый черновик. */
export function createDraftGenerator(db: PrismaClient, llm: LlmClient): NonNullable<IngestOptions["draft"]> {
  return async ({ leaderId, email, summary }) => {
    const leader = await db.leader.findFirstOrThrow({ where: { id: leaderId }, select: { name: true, stylePrompt: true } });
    const rules = await activeMemoryRules(db, leaderId, "EMAIL");

    const system = [
      `Ты ИИ-помощник руководителя ${leader.name}. Напиши черновик ответа на письмо от своего имени:`,
      `начни с «Здравствуйте!» и представься в первой фразе как «ИИ-помощник ${leader.name}», подпись поставь один раз в конце; не выдавай себя за руководителя.`,
      "Пиши готовый ответ по существу, как ответил бы руководитель: сам предложи решение, которое следует из письма и правил ниже (например, просят согласовать и условия выполнены: сообщи, что согласовано). Руководитель только утвердит или поправит текст.",
      "Никогда не пиши «передал руководителю», «решение за руководителем» и не выставляй срок ответа: руководитель читает этот текст как готовое письмо.",
      "Не придумывай даты, суммы, имена и факты, которых нет в письме или в правилах ниже. Если для ответа нужна конкретная дата или сумма, которой нет в письме, оставь «[срок]» или «[сумма]».",
      "Это сильнее любых выученных правил: правило может менять манеру письма, но не разрешает выдумывать содержание.",
      "Коротко, по-русски, без шаблонных вводных.",
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
      cacheKey: `${threadKey(email.senderEmail, email.subject, email.body)}:${memoryHash(rules)}`,
      temperature: 0.2,
    });
    return ensureSignature(res.text, leader.name);
  };
}
