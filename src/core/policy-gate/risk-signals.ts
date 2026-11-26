/**
 * Детерминированные сигналы риска (SPEC 4.1, шаг 1).
 * Не зависят от LLM: работают по тексту, адресатам и оргструктуре.
 *
 * Жёсткий сигнал  → действие всегда с подтверждением руководителя (APPROVE / ASK_LEADER).
 * Мягкий сигнал   → подтверждение только для действий, которые отвечают наружу,
 *                   что-то согласуют или берут обязательство (решает Policy Gate).
 */

export const RISK_SIGNALS = [
  "MANAGER_PARTY",
  "HR_PARTY",
  "FINANCE_PARTY",
  "HR_TERMS",
  "COMMITMENT_TERMS",
  "MONEY_APPROVAL",
  "EXTERNAL_INVITATION",
  "MONEY_TERMS",
] as const;

export type RiskSignal = (typeof RISK_SIGNALS)[number];

export const HARD_SIGNALS: ReadonlySet<RiskSignal> = new Set<RiskSignal>([
  "MANAGER_PARTY",
  "HR_PARTY",
  "FINANCE_PARTY",
  "HR_TERMS",
  "COMMITMENT_TERMS",
  "MONEY_APPROVAL",
  "EXTERNAL_INVITATION",
]);

export type RelationType = "SUBORDINATE" | "MANAGER" | "PEER";

/** Человек из оргструктуры (Employee). Роли берутся отсюда, а не из кода. */
export interface OrgPerson {
  email: string;
  position: string;
  relationType: RelationType;
}

export interface RiskContext {
  /** Почта руководителя; по её домену определяется «внутренний» домен. */
  leaderEmail: string;
  org: readonly OrgPerson[];
  /** Явный список внутренних доменов; по умолчанию — домен руководителя. */
  internalDomains?: readonly string[];
  /** Какие должности считать HR-партнёром / финансовым контролем. */
  hrPositionPattern?: RegExp;
  financePositionPattern?: RegExp;
}

export interface RiskInput {
  senderEmail: string;
  recipients?: readonly string[];
  subject: string;
  body: string;
}

const DEFAULT_HR_POSITION = /(^|[^a-zа-яё])hr([^a-zа-яё]|$)|кадр|персонал|подбор/i;
const DEFAULT_FINANCE_POSITION = /финанс|финконтрол|бухгалтер|cfo/i;

const HR_TERMS = /отпуск|оффер|найм|увольн|больничн|зарплат|кандидат/;
const COMMITMENT_TERMS = /срок|гарантир|подтвердите|запуск|sla/;
const INVITATION_TERMS = /приглаша|выступить|спикер/;
const MONEY_TERMS = /₽|руб|тыс|млн|\d+\s?%|бюджет|скидк|закупк|оплат/;
const APPROVAL_REQUEST =
  /согласу(й|ешь|йте)|нужно согласование|прошу[^.]{0,30}(подтвердить|согласовать|утвердить)/;

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const domainOf = (email: string): string => normalizeEmail(email).split("@")[1] ?? "";

export function detectRiskSignals(input: RiskInput, ctx: RiskContext): RiskSignal[] {
  const text = `${input.subject} ${input.body}`.toLowerCase();
  const sender = normalizeEmail(input.senderEmail);
  const leader = normalizeEmail(ctx.leaderEmail);
  const people = new Map(ctx.org.map((p) => [normalizeEmail(p.email), p]));

  const internalDomains = new Set(
    (ctx.internalDomains ?? [domainOf(ctx.leaderEmail)]).map((d) => d.toLowerCase()),
  );
  const isExternal = !internalDomains.has(domainOf(sender));

  const hrPosition = ctx.hrPositionPattern ?? DEFAULT_HR_POSITION;
  const financePosition = ctx.financePositionPattern ?? DEFAULT_FINANCE_POSITION;

  const senderPerson = people.get(sender);
  const parties = [sender, ...(input.recipients ?? []).map(normalizeEmail)].filter((e) => e !== leader);

  const found = new Set<RiskSignal>();

  if (parties.some((email) => people.get(email)?.relationType === "MANAGER")) {
    found.add("MANAGER_PARTY");
  }
  if (senderPerson && hrPosition.test(senderPerson.position)) found.add("HR_PARTY");
  if (senderPerson && financePosition.test(senderPerson.position)) found.add("FINANCE_PARTY");

  if (HR_TERMS.test(text)) found.add("HR_TERMS");
  if (isExternal && COMMITMENT_TERMS.test(text)) found.add("COMMITMENT_TERMS");
  if (isExternal && INVITATION_TERMS.test(text)) found.add("EXTERNAL_INVITATION");

  const hasMoney = MONEY_TERMS.test(text);
  const asksApproval = APPROVAL_REQUEST.test(text);
  if (hasMoney && asksApproval) found.add("MONEY_APPROVAL");
  else if (hasMoney) found.add("MONEY_TERMS");

  return RISK_SIGNALS.filter((s) => found.has(s));
}

export function hasHardSignal(signals: readonly RiskSignal[]): boolean {
  return signals.some((s) => HARD_SIGNALS.has(s));
}
