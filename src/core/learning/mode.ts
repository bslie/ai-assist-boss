/**
 * Режим обучения (SPEC 1.1, «осторожный ИИ»). Пока он включён, Policy Gate любое внешнее действие
 * переводит на подтверждение. Выход — по областям: после серии решений, принятых без правок,
 * помощник предлагает «такие решать без вас?». Защищённые категории и деньги не отпускаются никогда.
 */
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { clock } from "../clock";
import { EMAIL_CATEGORIES } from "../email-triage/classify";
import { publishEvent } from "../events";
import { isLockedCategory } from "../policy-gate";
import { ASSIGN_TOOL, TASK_ASSIGN_SCOPE } from "../tasks/dispatch";

/** Сколько подряд решений без правок нужно, чтобы предложить доверие. */
export const TRUST_STREAK = 3;

export const TRUST_SCOPES = [...EMAIL_CATEGORIES, TASK_ASSIGN_SCOPE] as const;
export type TrustScope = (typeof TRUST_SCOPES)[number];

/** Что именно отпускается: формулировка для вопроса «… решать без вас?». */
export const SCOPE_LABEL: Record<TrustScope, string> = {
  HR: "Кадровые письма",
  MANAGEMENT: "Письма руководству",
  MONEY: "Денежные вопросы",
  CLIENT_COMMITMENT: "Обязательства клиентам",
  INVITATION: "Приглашения",
  REPORT: "Отчёты",
  STATUS: "Статусы",
  SALES: "Запросы КП",
  ACCESS: "Запросы доступов",
  CLIENT_SUPPORT: "Типовые обращения клиентов",
  NEWSLETTER: "Рассылки",
  CALENDAR: "Согласования встреч",
  TASK_ASSIGN: "Поручения сотрудникам",
};

export const canTrust = (scope: string): scope is TrustScope =>
  (TRUST_SCOPES as readonly string[]).includes(scope) && !isLockedCategory(scope);

export interface TrustSuggestion {
  scope: TrustScope;
  label: string;
  /** Подряд принято без правок. */
  streak: number;
}

export interface LearningStatus {
  learningMode: boolean;
  /** Принято без правок. */
  clean: number;
  /** Всего решено (принято, принято с правкой, отклонено). */
  resolved: number;
  trusted: { scope: TrustScope; label: string }[];
  suggestions: TrustSuggestion[];
}

const RESOLVED = ["APPROVED", "EDITED_APPROVED", "REJECTED"] as const;

export async function getLearningStatus(db: PrismaClient, leaderId: string): Promise<LearningStatus> {
  const [leader, decisions] = await Promise.all([
    db.leader.findFirstOrThrow({ where: { id: leaderId }, select: { learningMode: true, trustedScopes: true } }),
    db.decision.findMany({
      where: { leaderId, status: { in: [...RESOLVED] } },
      orderBy: [{ resolvedAt: "desc" }, { createdAt: "desc" }],
      select: { id: true, type: true, status: true, proposedPayload: true },
      take: 300,
    }),
  ]);

  // Область решения: категория письма, из которого карточка, или «поручения» для отправки задачи.
  const emails = await db.emailItem.findMany({
    where: { leaderId, decisionId: { in: decisions.map((d) => d.id) } },
    select: { decisionId: true, category: true },
  });
  const categoryOf = new Map(emails.map((e) => [e.decisionId, e.category]));
  const scopeOf = (d: (typeof decisions)[number]): string | null => {
    const tool = (d.proposedPayload as { tool?: string } | null)?.tool;
    if (d.type === "TOOL_CALL" && tool === ASSIGN_TOOL) return TASK_ASSIGN_SCOPE;
    return categoryOf.get(d.id) ?? null;
  };

  const trustedSet = new Set(leader.trustedScopes);
  const streaks = new Map<TrustScope, { streak: number; broken: boolean }>();
  for (const d of decisions) {
    const scope = scopeOf(d);
    if (!scope || !canTrust(scope) || trustedSet.has(scope)) continue;
    const s = streaks.get(scope) ?? { streak: 0, broken: false };
    if (!s.broken) {
      if (d.status === "APPROVED") s.streak++;
      else s.broken = true;
    }
    streaks.set(scope, s);
  }

  return {
    learningMode: leader.learningMode,
    clean: decisions.filter((d) => d.status === "APPROVED").length,
    resolved: decisions.length,
    trusted: leader.trustedScopes.filter(canTrust).map((scope) => ({ scope, label: SCOPE_LABEL[scope] })),
    suggestions: leader.learningMode
      ? [...streaks.entries()]
          .filter(([, s]) => s.streak >= TRUST_STREAK)
          .map(([scope, s]) => ({ scope, label: SCOPE_LABEL[scope], streak: s.streak }))
          .sort((a, b) => b.streak - a.streak)
      : [],
  };
}

export const LearningPatchSchema = z.discriminatedUnion("kind", [
  /** Включить или выключить режим целиком. Выключение — только явным действием руководителя. */
  z.object({ kind: z.literal("mode"), enabled: z.boolean() }),
  /** Отпустить область или вернуть её на подтверждение. */
  z.object({ kind: z.literal("trust"), scope: z.string().min(1).max(40), trusted: z.boolean() }),
]);
export type LearningPatch = z.infer<typeof LearningPatchSchema>;

export type LearningPatchResult = { ok: true; message: string } | { ok: false; message: string };

export async function patchLearning(db: PrismaClient, leaderId: string, input: LearningPatch): Promise<LearningPatchResult> {
  const leader = await db.leader.findFirstOrThrow({ where: { id: leaderId }, select: { learningMode: true, trustedScopes: true } });
  let message: string;

  if (input.kind === "mode") {
    if (leader.learningMode === input.enabled) return { ok: true, message: input.enabled ? "Режим обучения уже включён." : "Режим обучения уже выключен." };
    await db.leader.update({ where: { id: leaderId }, data: { learningMode: input.enabled } });
    message = input.enabled
      ? "Снова учусь: ничего не отправляю без вашего подтверждения."
      : "Режим обучения выключен. Действую по правилам и правам подключений; кадры, руководство, обещания клиентам и деньги выше порога по-прежнему только с вами.";
  } else {
    // Защищённое не отпускается ни кнопкой, ни словами: fail closed.
    if (input.trusted && !canTrust(input.scope)) return { ok: false, message: "Эту область я всегда согласую с вами: её нельзя отпустить." };
    const set = new Set(leader.trustedScopes);
    if (input.trusted) set.add(input.scope);
    else set.delete(input.scope);
    await db.leader.update({ where: { id: leaderId }, data: { trustedScopes: [...set] } });
    const label = canTrust(input.scope) ? SCOPE_LABEL[input.scope] : input.scope;
    message = input.trusted ? `${label}: дальше решаю сама по вашим правилам.` : `${label}: снова спрашиваю вас.`;
  }

  await db.activityLog.create({
    data: { leaderId, createdAt: clock.now(), pipeline: "GATE", action: "LEARNING_CHANGED", reason: message, metadata: input },
  });
  await publishEvent(leaderId, { type: "metrics.updated", data: {} });
  return { ok: true, message };
}
