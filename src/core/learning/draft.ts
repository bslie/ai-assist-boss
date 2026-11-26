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
  return text.includes(sig) ? text.trim() : `${text.trim()}\n\n${sig}`;
}

const memoryHash = (rules: readonly string[]) => createHash("sha256").update(rules.join("\n")).digest("hex").slice(0, 12);

/** Хук `draft` для ingestEmails. Кэш по треду и набору правил: новое правило даёт новый черновик. */
export function createDraftGenerator(db: PrismaClient, llm: LlmClient): NonNullable<IngestOptions["draft"]> {
  return async ({ leaderId, email, summary }) => {
    const leader = await db.leader.findFirstOrThrow({ where: { id: leaderId }, select: { name: true, stylePrompt: true } });
    const rules = await activeMemoryRules(db, leaderId, "EMAIL");

    const system = [
      `Ты ИИ-помощник руководителя ${leader.name}. Напиши черновик ответа на письмо от своего имени:`,
      `представься как «ИИ-помощник ${leader.name}», не выдавай себя за руководителя и не принимай решений за него.`,
      "Не обещай сроков, сумм и согласований, если руководитель их не называл: предложи следующий шаг и скажи, что решение за руководителем.",
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
