/**
 * Учёт стоимости (SPEC инвариант 8, 7.4): отчёт по UsageLog и запись не-LLM сервисов (Recall).
 * Все запросы по leaderId. Стоимость одного запроса = стоимость / число платных (некэшированных) вызовов.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { clock } from "./clock";

export interface CostRow {
  pipeline: string;
  provider: string;
  model: string;
  calls: number;
  cachedCalls: number;
  promptTokens: number;
  completionTokens: number;
  audioSeconds: number;
  costRub: number;
  /** Стоимость одного платного вызова; null, если платных вызовов не было. */
  avgCostRub: number | null;
}

export interface CostReport {
  rows: CostRow[];
  totalRub: number;
  paidCalls: number;
  perRequestRub: number | null;
}

const round = (n: number, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits;

export async function getCostReport(db: PrismaClient, leaderId: string, opts: { since?: Date } = {}): Promise<CostReport> {
  const groups = await db.usageLog.groupBy({
    by: ["pipeline", "provider", "model", "cached"],
    where: { leaderId, ...(opts.since ? { createdAt: { gte: opts.since } } : {}) },
    _count: { _all: true },
    _sum: { promptTokens: true, completionTokens: true, audioSeconds: true, costRub: true },
  });
  const byKey = new Map<string, CostRow>();
  for (const g of groups) {
    const key = [g.pipeline, g.provider, g.model].join("\u0000");
    const row =
      byKey.get(key) ??
      { pipeline: g.pipeline, provider: g.provider, model: g.model, calls: 0, cachedCalls: 0, promptTokens: 0, completionTokens: 0, audioSeconds: 0, costRub: 0, avgCostRub: null };
    row.calls += g._count._all;
    if (g.cached) row.cachedCalls += g._count._all;
    row.promptTokens += g._sum.promptTokens ?? 0;
    row.completionTokens += g._sum.completionTokens ?? 0;
    row.audioSeconds += g._sum.audioSeconds ?? 0;
    row.costRub += g._sum.costRub ?? 0;
    byKey.set(key, row);
  }
  const rows = [...byKey.values()]
    .map((r) => {
      const paid = r.calls - r.cachedCalls;
      return { ...r, costRub: round(r.costRub), avgCostRub: paid > 0 ? round(r.costRub / paid) : null };
    })
    .sort((a, b) => a.pipeline.localeCompare(b.pipeline) || a.model.localeCompare(b.model));
  const totalRub = round(rows.reduce((s, r) => s + r.costRub, 0));
  const paidCalls = rows.reduce((s, r) => s + r.calls - r.cachedCalls, 0);
  return { rows, totalRub, paidCalls, perRequestRub: paidCalls > 0 ? round(totalRub / paidCalls) : null };
}

const csvCell = (v: string | number | null) => {
  const s = v === null ? "" : String(v);
  return /[",\n;]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** Выгрузка для расчёта по шаблону организатора: одна строка на конвейер и модель. */
export function costReportCsv(report: CostReport): string {
  const head = ["pipeline", "provider", "model", "calls", "cached_calls", "prompt_tokens", "completion_tokens", "audio_seconds", "cost_rub", "avg_cost_rub_per_paid_call"];
  const lines = report.rows.map((r) =>
    [r.pipeline, r.provider, r.model, r.calls, r.cachedCalls, r.promptTokens, r.completionTokens, r.audioSeconds, r.costRub, r.avgCostRub].map(csvCell).join(","),
  );
  lines.push(["TOTAL", "", "", report.rows.reduce((s, r) => s + r.calls, 0), "", "", "", "", report.totalRub, report.perRequestRub].map(csvCell).join(","));
  return [head.join(","), ...lines].join("\n") + "\n";
}

/** Стоимость минут бота Recall: цена за час из RECALL_PRICE_RUB_PER_HOUR (нет → 0). */
export function recallCostRub(seconds: number, env: Record<string, string | undefined> = process.env): number {
  const perHour = Number(env.RECALL_PRICE_RUB_PER_HOUR ?? 0);
  return Number.isFinite(perHour) && perHour > 0 ? round((seconds / 3600) * perHour) : 0;
}

/** Запись использования не-LLM сервиса (Recall, STT, TTS). Время — демо-часы. */
export async function recordServiceUsage(
  db: PrismaClient,
  e: { leaderId: string; pipeline: "AVATAR_SESSION" | "STT" | "TTS"; provider: string; model: string; audioSeconds: number; costRub: number },
): Promise<void> {
  await db.usageLog.create({ data: { ...e, createdAt: clock.now(), cached: false } });
}
