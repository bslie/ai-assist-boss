/**
 * Policy Gate (SPEC 4.1): детерминированное решение ALLOW / APPROVE / DENY.
 * Чистая функция: без БД и LLM. Запись в ActivityLog делает вызывающий слой.
 * Fail closed: любая неопределённость → APPROVE.
 */
import { z } from "zod";
import {
  detectRiskSignals,
  hasHardSignal,
  type RiskContext,
  type RiskInput,
  type RiskSignal,
} from "./risk-signals";

export const PROTECTED_CATEGORIES = ["HR", "MANAGEMENT", "CLIENT_COMMITMENT"] as const;
export const CONFIDENCE_THRESHOLD = 0.7;

/** Категории, которые правилом нельзя перевести в авто: защищённые + деньги (порог решает Gate). */
export const isLockedCategory = (c: string): boolean =>
  (PROTECTED_CATEGORIES as readonly string[]).includes(c) || c === "MONEY";

export const ToolPermissionSchema = z.enum(["AUTO", "APPROVE", "DENY"]);
export type ToolPermission = z.infer<typeof ToolPermissionSchema>;

export type Verdict = "ALLOW" | "APPROVE" | "DENY";

export interface GateResult {
  verdict: Verdict;
  reasons: string[];
  signals: RiskSignal[];
}

export interface GateLeader {
  budgetAutoLimit: number;
  protectedBlocks: readonly string[];
  shadowMode?: boolean;
  /** Режим обучения (SPEC 1.1): пока включён, сама ничего наружу не делаю. */
  learningMode?: boolean;
  /** Области, где руководитель разрешил действовать без него: категории писем или TASK_ASSIGN. */
  trustedScopes?: readonly string[];
}

export interface GateContext {
  leader: GateLeader;
  /** Письмо/сообщение, из-за которого вызывается инструмент. Нет текста → сигналы не считаются. */
  message?: RiskInput;
  risk?: RiskContext;
  category?: string | null;
  confidence?: number | null;
  /** Сумма в ₽, извлечённая классификатором. */
  amount?: number | null;
  /** Название календарного слота, которого касается операция. */
  calendarSlotTitle?: string | null;
  /** Действие отвечает наружу, что-то согласует или берёт обязательство. */
  isOutbound?: boolean;
  /** Права инструмента из Connector.toolPermissions; нет записи → APPROVE. */
  toolPermission?: ToolPermission | null;
  /** Руководитель уже согласился: утвердил карточку или сам задал разрешение (порог бюджета, аватар на встрече). */
  approvedByLeader?: boolean;
  /** Область доверия для режима обучения, если она не совпадает с категорией (например, TASK_ASSIGN). */
  trustScope?: string | null;
}

/** Область, которую руководитель отпустил из режима обучения. Защищённые категории и деньги не отпускаются никогда. */
function isTrusted(ctx: GateContext): boolean {
  const scope = ctx.trustScope ?? ctx.category;
  if (!scope || isLockedCategory(scope)) return false;
  if (ctx.category && isLockedCategory(ctx.category)) return false;
  return (ctx.leader.trustedScopes ?? []).includes(scope);
}

const SOFT_ONLY_OK = new Set<RiskSignal>(["MONEY_TERMS", "FINANCE_PARTY"]);

export function evaluate(toolName: string, ctx: GateContext): GateResult {
  const reasons: string[] = [];
  let deny = false;
  let approve = false;

  const signals =
    ctx.message && ctx.risk ? detectRiskSignals(ctx.message, ctx.risk) : [];

  // Шаг 1. Сигналы риска.
  if (hasHardSignal(signals)) {
    approve = true;
    reasons.push(`Жёсткие сигналы риска: ${signals.filter((s) => s !== "MONEY_TERMS").join(", ")}`);
  } else if (signals.includes("MONEY_TERMS") && ctx.isOutbound) {
    approve = true;
    reasons.push("Деньги в исходящем действии");
  }

  // Шаг 2. Защищённые категории и неуверенность. Нет категории — тоже не авто.
  if (ctx.category == null) {
    if (ctx.message) {
      approve = true;
      reasons.push("Категория не определена");
    }
  } else if ((PROTECTED_CATEGORIES as readonly string[]).includes(ctx.category)) {
    approve = true;
    reasons.push(`Защищённая категория ${ctx.category}`);
  }
  if (ctx.category != null && (ctx.confidence ?? 0) < CONFIDENCE_THRESHOLD) {
    approve = true;
    reasons.push("Уверенность классификатора ниже порога");
  }

  // Шаг 3. Деньги. Порог 0 = всегда спрашивать; сумма не извлечена → спрашивать.
  if (ctx.category === "MONEY" || signals.includes("MONEY_APPROVAL")) {
    const { budgetAutoLimit } = ctx.leader;
    const amount = ctx.amount;
    const underLimit =
      budgetAutoLimit > 0 && amount != null && Number.isFinite(amount) && amount <= budgetAutoLimit;
    const onlySoft = signals.every((s) => SOFT_ONLY_OK.has(s));
    if (!(underLimit && onlySoft)) {
      approve = true;
      reasons.push(
        amount == null ? "Сумма не извлечена" : `Сумма ${amount} ₽ выше порога автоответа ${budgetAutoLimit} ₽`,
      );
    }
  }

  // Шаг 4. Защищённое время.
  const slot = ctx.calendarSlotTitle?.toLowerCase();
  if (slot && ctx.leader.protectedBlocks.some((b) => slot.includes(b.toLowerCase()))) {
    approve = true;
    reasons.push("Затронут защищённый блок календаря");
  }

  // Шаг 5. Права инструмента.
  const perm = ctx.toolPermission ?? "APPROVE";
  if (perm === "DENY") {
    deny = true;
    reasons.push(`Инструмент ${toolName} запрещён`);
  } else if (perm === "APPROVE") {
    approve = true;
    reasons.push(`Инструмент ${toolName} требует подтверждения`);
  }

  if (deny) return { verdict: "DENY", reasons, signals };
  if (approve) return { verdict: "APPROVE", reasons, signals };

  // Шаг 6 (P2). Режим тени.
  if (ctx.leader.shadowMode) {
    return { verdict: "APPROVE", reasons: ["Режим тени"], signals };
  }
  // Шаг 7 (SPEC 1.1). Режим обучения: только ужесточает вердикт.
  if (ctx.leader.learningMode && !ctx.approvedByLeader && !isTrusted(ctx)) {
    return { verdict: "APPROVE", reasons: ["Режим обучения: без вашего подтверждения ничего не делаю"], signals };
  }
  return { verdict: "ALLOW", reasons: ["Правила не требуют подтверждения"], signals };
}
