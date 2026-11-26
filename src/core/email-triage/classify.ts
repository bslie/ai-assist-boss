/**
 * Классификация и маршрутизация письма (SPEC 4.2, шаги 2–4).
 * LLM определяет категорию; финальное действие всегда проходит детерминированные проверки:
 * жёсткие сигналы, защищённые категории и низкая уверенность → ASK_LEADER.
 */
import { z } from "zod";
import type { LlmClient } from "../llm";
import {
  CONFIDENCE_THRESHOLD,
  PROTECTED_CATEGORIES,
  detectRiskSignals,
  hasHardSignal,
  type RiskContext,
  type RiskSignal,
} from "../policy-gate";

export const EMAIL_CATEGORIES = [
  "HR", "MANAGEMENT", "MONEY", "CLIENT_COMMITMENT", "INVITATION", "REPORT",
  "STATUS", "SALES", "ACCESS", "CLIENT_SUPPORT", "NEWSLETTER", "CALENDAR",
] as const;
export type EmailCategory = (typeof EMAIL_CATEGORIES)[number];

export const EMAIL_ACTIONS = ["ASK_LEADER", "DIGEST", "DELEGATE", "IGNORE", "AUTO"] as const;
export type EmailAction = (typeof EMAIL_ACTIONS)[number];

export const ClassificationSchema = z.object({
  category: z.enum(EMAIL_CATEGORIES),
  confidence: z.number().min(0).max(1),
  amount: z.number().nullable(),
  client: z.string().nullable(),
  deadline: z.string().nullable(),
  isUrgent: z.boolean(),
  summary: z.string().min(1),
});
export type Classification = z.infer<typeof ClassificationSchema>;

/** Таблица по умолчанию (SPEC 4.2, шаг 3). */
export const DEFAULT_ROUTES: Readonly<Record<EmailCategory, EmailAction>> = {
  HR: "ASK_LEADER",
  MANAGEMENT: "ASK_LEADER",
  MONEY: "ASK_LEADER",
  CLIENT_COMMITMENT: "ASK_LEADER",
  INVITATION: "ASK_LEADER",
  REPORT: "DIGEST",
  STATUS: "DIGEST",
  SALES: "DELEGATE",
  ACCESS: "DELEGATE",
  CLIENT_SUPPORT: "DELEGATE",
  NEWSLETTER: "IGNORE",
  CALENDAR: "AUTO",
};

/** Правило профиля/пользователя: может менять действие, но не ослаблять защиту. */
export interface CategoryRule {
  category: EmailCategory;
  action: EmailAction;
}

export interface RouteDecision {
  action: EmailAction;
  reasons: string[];
}

export function routeEmail(args: {
  category: EmailCategory | null;
  confidence: number;
  signals: readonly RiskSignal[];
  rules?: readonly CategoryRule[];
}): RouteDecision {
  const reasons: string[] = [];

  if (hasHardSignal(args.signals)) {
    reasons.push(`Жёсткие сигналы: ${args.signals.join(", ")}`);
    return { action: "ASK_LEADER", reasons };
  }
  if (args.category === null) {
    return { action: "ASK_LEADER", reasons: ["Категория не определена"] };
  }
  if ((PROTECTED_CATEGORIES as readonly string[]).includes(args.category)) {
    return { action: "ASK_LEADER", reasons: [`Защищённая категория ${args.category}`] };
  }
  if (args.confidence < CONFIDENCE_THRESHOLD) {
    return { action: "ASK_LEADER", reasons: ["Уверенность ниже порога"] };
  }

  let action = DEFAULT_ROUTES[args.category];
  const rule = args.rules?.find((r) => r.category === args.category);
  // Правила не могут вернуть защищённое письмо в авто: сюда попадают только незащищённые категории.
  if (rule) {
    action = rule.action;
    reasons.push("Применено правило");
  }
  return { action, reasons };
}

const SYSTEM = [
  "Ты классифицируешь входящее письмо руководителя. Верни категорию из списка, уверенность 0..1,",
  "сумму в рублях (число или null), клиента, срок, срочность и суть одним предложением.",
  "Если сомневаешься — снижай confidence. Категории: " + EMAIL_CATEGORIES.join(", ") + ".",
].join(" ");

export interface TriageInput {
  leaderId: string;
  threadKey: string;
  senderEmail: string;
  subject: string;
  body: string;
  recipients?: readonly string[];
}

export interface TriageResult {
  classification: Classification;
  signals: RiskSignal[];
  decision: RouteDecision;
}

/** Классифицирует первое письмо треда (кэш по threadKey) и выбирает действие. */
export async function triageEmail(
  llm: LlmClient,
  input: TriageInput,
  risk: RiskContext,
  rules?: readonly CategoryRule[],
): Promise<TriageResult> {
  const classification = await llm.generateStructured({
    leaderId: input.leaderId,
    pipeline: "EMAIL_TRIAGE",
    schema: ClassificationSchema,
    system: SYSTEM,
    prompt: `От: ${input.senderEmail}\nТема: ${input.subject}\n\n${input.body}`,
    cacheKey: input.threadKey,
    temperature: 0,
  });
  const signals = detectRiskSignals(input, risk);
  const decision = routeEmail({
    category: classification.category,
    confidence: classification.confidence,
    signals,
    rules,
  });
  return { classification, signals, decision };
}
