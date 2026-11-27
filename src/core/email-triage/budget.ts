/**
 * Порог автосогласования денег (SPEC 4.1, шаг 3; инвариант 2).
 * Маршрутизатор отправляет MONEY руководителю всегда. Исключение одно: у руководителя задан
 * `budgetAutoLimit > 0`, сумма извлечена и не выше порога, жёстких сигналов нет. Решение принимает
 * Policy Gate (`evaluate`), а не этот модуль: тут только подготовка контекста и разбор вердикта.
 * Сумма не извлечена, порог 0 или любая неопределённость → остаётся ASK_LEADER (fail closed).
 */
import {
  evaluate,
  hasHardSignal,
  type GateLeader,
  type GateResult,
  type RiskContext,
  type RiskSignal,
} from "../policy-gate";
import type { Classification, RouteDecision, TriageInput } from "./classify";

export const BUDGET_TOOL = "budget.auto_approve";

export interface BudgetAuto {
  decision: RouteDecision;
  verdict: GateResult;
}

export function budgetAutoApproval(args: {
  leader: GateLeader;
  risk: RiskContext;
  input: TriageInput;
  classification: Classification;
  signals: readonly RiskSignal[];
  decision: RouteDecision;
}): BudgetAuto | null {
  const { leader, classification: c, signals } = args;
  if (c.category !== "MONEY" || args.decision.action !== "ASK_LEADER") return null;
  if (!(leader.budgetAutoLimit > 0) || hasHardSignal(signals)) return null;

  const verdict = evaluate(BUDGET_TOOL, {
    leader,
    message: args.input,
    risk: args.risk,
    category: c.category,
    confidence: c.confidence,
    amount: c.amount,
    // Порог в профиле и есть разрешение руководителя; прав коннектора у «бюджета» нет.
    toolPermission: "AUTO",
  });
  if (verdict.verdict !== "ALLOW") return null;
  return {
    verdict,
    decision: {
      action: "AUTO",
      reasons: [`Сумма ${c.amount} ₽ в пределах порога автосогласования ${leader.budgetAutoLimit} ₽`],
    },
  };
}
