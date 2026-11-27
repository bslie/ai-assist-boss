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
  /** Правило по категории; нет категории — правило по отправителю. */
  category?: EmailCategory;
  /** Правило по отправителю («письма от Орлова присылай сразу»); важнее правила по категории. */
  senderEmail?: string;
  action: EmailAction;
}

/** Какое правило применимо к письму: сначала по отправителю, затем по категории. */
export function matchRule<T extends { category?: string; senderEmail?: string }>(
  rules: readonly T[] | undefined,
  category: string | null,
  senderEmail: string | undefined,
): T | undefined {
  const sender = senderEmail?.trim().toLowerCase();
  return (
    rules?.find((r) => r.senderEmail && sender && r.senderEmail.trim().toLowerCase() === sender) ??
    rules?.find((r) => !r.senderEmail && r.category && r.category === category)
  );
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
  senderEmail?: string;
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
  // Деньги: правило может только оставить ASK_LEADER. Порог бюджета решает Policy Gate, не правило.
  const rule = args.category === "MONEY" ? undefined : matchRule(args.rules, args.category, args.senderEmail);
  // Остальные защищённые категории отсечены выше, сюда попадают только незащищённые.
  if (rule) {
    action = rule.action;
    reasons.push("Применено правило");
  }
  return { action, reasons };
}

export const CATEGORY_HELP: Record<EmailCategory, string> = {
  HR: "кадровые вопросы: найм, офферы, отпуска, увольнения, больничные, зарплаты",
  MANAGEMENT: "письма и просьбы от вышестоящего руководства к руководителю",
  MONEY: "бюджеты, скидки, закупки, оплаты, согласование сумм",
  CLIENT_COMMITMENT: "клиент просит подтвердить сроки, условия или гарантии",
  INVITATION: "внешнее приглашение выступить, участвовать в мероприятии, стать спикером",
  REPORT: "отчёты, прогнозы, дашборды, итоги: информация для сведения, в том числе с рисками",
  STATUS: "статусные обновления по ходу работы",
  SALES: "запрос коммерческого предложения (КП) или продажная заявка",
  ACCESS: "запрос на доступы и ИТ-обслуживание",
  CLIENT_SUPPORT: "типовые обращения и жалобы клиентов",
  NEWSLETTER: "рассылки, новости вендоров, вебинары",
  CALENDAR: "подтверждение, перенос или согласование времени внутренней встречи коллегами",
};

const SYSTEM = [
  "Ты классифицируешь входящее письмо руководителя. Верни категорию, уверенность 0..1,",
  "сумму в рублях (число или null), клиента, срок, срочность и суть одним предложением.",
  "confidence — это уверенность в выборе именно категории, а не важность или срочность письма:",
  "если категория очевидна из текста, ставь не ниже 0.85; снижай только при реальной неоднозначности между категориями.",
  "Категории: " + EMAIL_CATEGORIES.map((c) => `${c} (${CATEGORY_HELP[c]})`).join("; ") + ".",
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
    senderEmail: input.senderEmail,
  });
  return { classification, signals, decision };
}
