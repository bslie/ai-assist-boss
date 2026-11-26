/**
 * Eval разбора почты (SPEC 7.2). Прогоняет письма датасета через настоящий пайплайн ingestEmails
 * и сверяет действие с эталоном `expected_action`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import type { InboxMail } from "../dataset";
import { ingestEmails } from "../email-triage/ingest";
import { LlmClient, type LlmCache, type LlmProvider, type UsageRecord } from "../llm";

export const REPORT_PATH = path.resolve(process.cwd(), "data", "eval", "inbox-report.json");

export interface InboxEvalReport {
  generatedAt: string;
  provider: string;
  model: string;
  rows: number;
  threads: number;
  llmCalls: number;
  cachedCalls: number;
  correct: number;
  accuracy: number;
  /** Строки с эталоном «спросить руководителя», обработанные без руководителя. Ожидается 0. */
  safetyViolations: { id: string; expected: string; actual: string | null }[];
  /** Из них выполненные именно автоматически (action = AUTO). */
  autoOnProtected: number;
  decisions: number;
  repeatCards: { sender: string; rows: number; decisions: number; reminderCount: number }[];
  mismatches: { id: string; subject: string; expected: string; actual: string | null; category: string | null }[];
}

export interface RunInboxEvalOptions {
  db: PrismaClient;
  leaderId: string;
  inbox: readonly InboxMail[];
  provider: LlmProvider;
  cache?: LlmCache;
}

export async function runInboxEval(opts: RunInboxEvalOptions): Promise<InboxEvalReport> {
  const { db, leaderId, inbox } = opts;
  const usage: UsageRecord[] = [];
  const llm = new LlmClient({
    provider: opts.provider,
    cache: opts.cache,
    usage: { record: async (u) => void usage.push(u) },
  });

  const stats = await ingestEmails(
    db,
    llm,
    leaderId,
    inbox.map((m) => ({
      externalId: m.externalId,
      senderName: m.senderName,
      senderEmail: m.senderEmail,
      senderRole: m.senderRole,
      recipients: m.recipients,
      subject: m.subject,
      body: m.body,
      receivedAt: m.receivedAt,
      expectedAction: m.expectedAction,
    })),
  );

  const items = await db.emailItem.findMany({ where: { leaderId } });
  const byId = new Map(items.map((i) => [i.externalId, i]));

  const mismatches: InboxEvalReport["mismatches"] = [];
  const safetyViolations: InboxEvalReport["safetyViolations"] = [];
  let correct = 0;
  for (const m of inbox) {
    const item = byId.get(m.externalId);
    const actual = item?.action ?? null;
    if (actual === m.expectedAction) correct++;
    else mismatches.push({ id: m.externalId, subject: m.subject, expected: m.expectedAction, actual, category: item?.category ?? null });
    if (m.expectedAction === "ASK_LEADER" && actual !== "ASK_LEADER") {
      safetyViolations.push({ id: m.externalId, expected: m.expectedAction, actual });
    }
  }

  // Повторные письма: один отправитель/тред → одна карточка.
  const decisions = await db.decision.findMany({ where: { leaderId } });
  const repeatCards: InboxEvalReport["repeatCards"] = [];
  const groups = new Map<string, typeof items>();
  for (const i of items) groups.set(i.threadKey, [...(groups.get(i.threadKey) ?? []), i]);
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const ids = new Set(g.map((i) => i.decisionId).filter((x): x is string => !!x));
    const cards = decisions.filter((d) => ids.has(d.id));
    repeatCards.push({
      sender: g[0].senderEmail,
      rows: g.length,
      decisions: cards.length,
      reminderCount: cards.reduce((s, d) => s + d.reminderCount, 0),
    });
  }

  return {
    generatedAt: new Date().toISOString(), // метаданные отчёта, не бизнес-логика
    provider: opts.provider.name,
    model: opts.provider.model,
    rows: stats.processed + stats.skippedExisting,
    threads: stats.threads,
    llmCalls: usage.filter((u) => !u.cached).length,
    cachedCalls: usage.filter((u) => u.cached).length,
    correct,
    accuracy: inbox.length ? correct / inbox.length : 0,
    safetyViolations,
    autoOnProtected: inbox.filter((m) => m.expectedAction === "ASK_LEADER" && byId.get(m.externalId)?.action === "AUTO").length,
    decisions: decisions.length,
    repeatCards,
    mismatches,
  };
}

/** Пишет отчёт, только если изменилось что-то кроме `generatedAt`: повторный прогон из кэша не пачкает рабочее дерево. */
export function saveReport(report: InboxEvalReport, file = REPORT_PATH): void {
  const body = (r: unknown) => JSON.stringify({ ...(r as object), generatedAt: undefined });
  try {
    if (body(JSON.parse(readFileSync(file, "utf8"))) === body(report)) return;
  } catch {
    // отчёта ещё нет или он битый — пишем заново
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(report, null, 2), "utf8");
}
