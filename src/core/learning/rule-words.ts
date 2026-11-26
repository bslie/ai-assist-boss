/**
 * Правила словами (SPEC 4.4.2, P1): «Письма от Орлова присылай сразу» → LLM строит черновик Rule →
 * руководитель видит его человекочитаемо и выбирает [Сохранить] [Только на неделю] [Отмена].
 * Здесь только разбор и запись. Попытка ослабить защиту отклоняется с объяснением (fail closed):
 * проверки те же, что у страницы «Правила» (`createRule`).
 */
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { clock } from "../clock";
import { CATEGORY_HELP, EMAIL_ACTIONS, EMAIL_CATEGORIES } from "../email-triage/classify";
import type { LlmClient } from "../llm";
import { isLockedCategory } from "../policy-gate";
import { createRule } from "../rules";

const WEEK_MS = 7 * 86_400_000;

export const RuleDraftSchema = z.object({
  /** false — реплика не про правило (вопрос, просьба о другом). */
  isRule: z.boolean(),
  name: z.string().max(120),
  category: z.enum(EMAIL_CATEGORIES).nullable(),
  /** Кого касается, как назвал руководитель («Орлов», «логисты»); ищется среди сотрудников. */
  senderName: z.string().max(120).nullable(),
  action: z.enum(EMAIL_ACTIONS),
  /** Кому передавать (область ответственности) при действии DELEGATE. */
  delegateToArea: z.string().max(80).nullable(),
  notifyImmediately: z.boolean(),
  /** Слова руководителя о сроке: «только на неделю». */
  weekOnly: z.boolean(),
});
export type RuleDraft = z.infer<typeof RuleDraftSchema>;

export interface RuleProposal {
  name: string;
  description: string;
  category?: (typeof EMAIL_CATEGORIES)[number];
  senderEmail?: string;
  action: (typeof EMAIL_ACTIONS)[number];
  delegateToArea?: string | null;
  notifyImmediately: boolean;
  weekOnly: boolean;
  /** Человекочитаемый разбор для карточки подтверждения. */
  summary: string;
}

export type ProposeResult = { ok: true; proposal: RuleProposal } | { ok: false; message: string; notARule?: boolean };

const ACTION_TEXT: Record<string, string> = {
  ASK_LEADER: "показывать вам с готовым черновиком",
  DIGEST: "складывать в сводку",
  DELEGATE: "передавать ответственному сотруднику",
  IGNORE: "отправлять в архив",
  AUTO: "решать самой",
};

const SYSTEM = [
  "Ты превращаешь фразу руководителя в правило обработки писем. Если это не правило, верни isRule=false.",
  "Правило строится по категории письма, по отправителю или по обоим. Действие: ASK_LEADER — спросить руководителя (в том числе «присылай сразу»), DIGEST — в сводку, DELEGATE — передать ответственному, IGNORE — в архив, AUTO — решать самой.",
  "«Присылай сразу», «сообщай сразу» = ASK_LEADER и notifyImmediately=true. «Только на неделю», «на этой неделе» = weekOnly=true.",
  "senderName — как руководитель назвал человека или компанию, без домысливания. Ничего не выдумывай.",
  "Категории: " + EMAIL_CATEGORIES.map((c) => `${c} (${CATEGORY_HELP[c]})`).join("; ") + ".",
].join(" ");

const norm = (s: string) => s.toLowerCase().replaceAll("ё", "е");
/** Основа слова: «Орлова» ↔ «Орлов», «Павловой» ↔ «Павлова». */
const stem = (w: string) => norm(w).slice(0, Math.max(3, norm(w).length - 2));

export async function proposeRuleFromText(db: PrismaClient, llm: LlmClient, leaderId: string, text: string): Promise<ProposeResult> {
  const draft = await llm.generateStructured({
    leaderId,
    pipeline: "RULE_EXTRACTION",
    schema: RuleDraftSchema,
    system: SYSTEM,
    prompt: text,
    cacheKey: `rule-words\u0000${norm(text)}`,
    temperature: 0,
  });
  if (!draft.isRule) return { ok: false, notARule: true, message: "Это не похоже на правило." };
  if (!draft.category && !draft.senderName) return { ok: false, message: "Не поняла, к каким письмам это относится: назовите отправителя или тип письма." };

  let senderEmail: string | undefined;
  if (draft.senderName) {
    const keys = draft.senderName.split(/\s+/).map(stem);
    const people = await db.employee.findMany({ where: { leaderId }, select: { name: true, email: true } });
    const hits = people.filter((p) => keys.some((k) => norm(p.name).includes(k)));
    if (hits.length === 0) return { ok: false, message: `Не нашла среди ваших контактов «${draft.senderName}». Назовите сотрудника по имени или скажите про тип писем.` };
    if (hits.length > 1) return { ok: false, message: `Под «${draft.senderName}» подходят несколько человек: ${hits.map((h) => h.name).join(", ")}. Уточните, о ком речь.` };
    senderEmail = hits[0].email;
  }

  const who = senderEmail ? `письма от ${draft.senderName}` : `письма вида «${draft.category}»`;
  const proposal: RuleProposal = {
    name: draft.name.trim() || `Правило: ${who}`,
    description: text.slice(0, 500),
    category: draft.category ?? undefined,
    senderEmail,
    action: draft.action,
    delegateToArea: draft.action === "DELEGATE" ? draft.delegateToArea : null,
    notifyImmediately: draft.notifyImmediately,
    weekOnly: draft.weekOnly,
    summary: `${who[0].toUpperCase()}${who.slice(1)}: ${ACTION_TEXT[draft.action]}${draft.notifyImmediately ? ", сообщать сразу" : ""}${draft.weekOnly ? ", только на неделю" : ""}.`,
  };

  // Проверка заранее, не после «Сохранить»: руководитель сразу видит, что так нельзя и почему.
  const probe = await checkAllowed(db, leaderId, proposal);
  return probe ? { ok: false, message: probe } : { ok: true, proposal };
}


async function checkAllowed(db: PrismaClient, leaderId: string, p: RuleProposal): Promise<string | null> {
  if (p.action === "ASK_LEADER") return null;
  if (p.category && isLockedCategory(p.category)) {
    return `Категория ${p.category} защищена: её нельзя перевести в авто ни правилом, ни словами. Допустимо только «спросить руководителя».`;
  }
  if (p.senderEmail) {
    const person = await db.employee.findFirst({ where: { leaderId, email: { equals: p.senderEmail, mode: "insensitive" } }, select: { relationType: true } });
    if (person?.relationType === "MANAGER") return "Письма руководства нельзя перевести в авто: допустимо только «спросить руководителя».";
  }
  return null;
}

/** Запись подтверждённого правила. `weekOnly` — срок действия 7 дней по демо-времени. */
export async function saveRuleProposal(db: PrismaClient, leaderId: string, p: RuleProposal, opts: { weekOnly?: boolean } = {}) {
  const week = opts.weekOnly ?? p.weekOnly;
  return createRule(db, leaderId, {
    name: p.name,
    description: p.description,
    category: p.category,
    senderEmail: p.senderEmail,
    action: p.action,
    delegateToArea: p.delegateToArea ?? null,
    notifyImmediately: p.notifyImmediately,
    expiresAt: week ? new Date(clock.now().getTime() + WEEK_MS) : null,
  });
}
