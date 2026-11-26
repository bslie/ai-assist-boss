import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadInbox } from "@/core/dataset";
import { DATASET_CATEGORY } from "@/core/dataset/categories";
import { runInboxEval, type InboxEvalReport } from "@/core/eval/inbox";
import type { LlmProvider } from "@/core/llm";
import { seedTempLeader } from "./helpers/eval-env";

vi.stubEnv("APP_CLOCK_MODE", "real");
const { db } = await import("@/db/client");
const { clock } = await import("@/core/clock");

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);

/**
 * «Оракул»: вместо LLM отдаёт категорию из inbox.csv. Это НЕ оценка качества модели:
 * тест проверяет всё остальное в пайплайне (треды, маршрутизацию, сигналы, карточки, повторы).
 * Качество модели меряет tests/eval-inbox.test.ts.
 */
const inbox = loadInbox();
const key = (subject: string, body: string) => `${subject}\n${body}`;
const truth = new Map(inbox.map((m) => [key(m.subject, m.body), m.datasetCategory]));

const oracle: LlmProvider = {
  name: "oracle",
  model: "dataset-category",
  async generate({ prompt }) {
    const m = /^От: .*\nТема: (.*)\n\n([\s\S]*)$/.exec(prompt);
    const cat = m && truth.get(key(m[1], m[2]));
    if (!cat) throw new Error("oracle: письмо не найдено в датасете");
    return {
      object: { category: DATASET_CATEGORY[cat], confidence: 0.95, amount: null, client: null, deadline: null, isUrgent: false, summary: `суть: ${m[1]}` },
      promptTokens: 0,
      completionTokens: 0,
    };
  },
};

describe.skipIf(!dbUp)("пайплайн на 80 письмах (оракул вместо LLM)", () => {
  let leaderId = "";
  let report: InboxEvalReport;

  beforeAll(async () => {
    await clock.init();
    leaderId = await seedTempLeader(db, "oracle");
    report = await runInboxEval({ db, leaderId, inbox, provider: oracle });
  });
  afterAll(async () => {
    if (leaderId) await db.leader.delete({ where: { id: leaderId } });
    await db.$disconnect();
  });

  it("80 строк → 17 тредов, 17 вызовов LLM", () => {
    expect(report.rows).toBe(80);
    expect(report.threads).toBe(17);
    expect(report.llmCalls).toBe(17);
  });

  it("безопасность: все 40 «спросить руководителя» ушли руководителю", () => {
    expect(report.safetyViolations).toEqual([]);
    expect(report.autoOnProtected).toBe(0);
  });

  it("повторы Павловой: 6 строк → одна карточка, reminderCount = 5", () => {
    const pavlova = report.repeatCards.find((c) => c.sender === "p10@company.example");
    expect(pavlova).toEqual({ sender: "p10@company.example", rows: 6, decisions: 1, reminderCount: 5 });
  });

  it("точность на 80 строках с идеальной классификацией — 100%", () => {
    expect(report.mismatches).toEqual([]);
    expect(report.accuracy).toBe(1);
  });
});
