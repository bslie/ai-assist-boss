import "dotenv/config";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadInbox } from "@/core/dataset";
import { runInboxEval, saveReport, type InboxEvalReport } from "@/core/eval/inbox";
import { FileCache } from "@/core/llm/file-cache";
import { createProviderFromEnv } from "@/core/llm/providers";
import { seedTempLeader } from "./helpers/eval-env";

/**
 * SPEC 7.2. Модель вызывается с temperature 0 через кэш `tests/fixtures/llm-cache.json`:
 * при попадании — без сети. `LLM_REFRESH=1` заново спрашивает модель и обновляет кэш.
 * Нужны LLM_BASE_URL + LLM_MODEL (живая модель) либо LLM_MODEL + готовый кэш (повтор без сети).
 * Иначе тест пропускается: качество модели при этом НЕ проверено.
 */
vi.stubEnv("APP_CLOCK_MODE", "real");
const { db } = await import("@/db/client");
const { clock } = await import("@/core/clock");

const CACHE_FILE = path.resolve(process.cwd(), "tests", "fixtures", "llm-cache.json");
const refresh = process.env.LLM_REFRESH === "1";
const hasLlm = Boolean(process.env.LLM_BASE_URL && process.env.LLM_MODEL);
// Повтор из кэша без сети: ключ кэша включает провайдера и модель, поэтому LLM_MODEL (и LLM_PROVIDER_NAME) нужны и тут.
const canReplay = Boolean(process.env.LLM_MODEL) && existsSync(CACHE_FILE) && !refresh;
const canRun = hasLlm || canReplay;
const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);

describe.skipIf(!dbUp || !canRun)("eval-inbox: 80 писем, настоящая LLM (через кэш)", () => {
  let leaderId = "";
  let report: InboxEvalReport;

  beforeAll(async () => {
    await clock.init();
    leaderId = await seedTempLeader(db, "eval");
    // Без LLM-окружения провайдер не нужен: все ответы берутся из кэша. Промах кэша — явная ошибка.
    const provider = hasLlm
      ? createProviderFromEnv()
      : {
          name: process.env.LLM_PROVIDER_NAME ?? "openai-compatible",
          model: process.env.LLM_MODEL ?? "",
          async generate(): Promise<never> {
            throw new Error("Нет ответа в llm-cache.json, а LLM_BASE_URL/LLM_MODEL не заданы");
          },
        };
    report = await runInboxEval({ db, leaderId, inbox: loadInbox(), provider, cache: new FileCache(CACHE_FILE, refresh) });
    saveReport(report);
  }, 600_000);

  afterAll(async () => {
    if (leaderId) await db.leader.delete({ where: { id: leaderId } });
    await db.$disconnect();
  });

  it("80 строк → 17 тредов, каждая строка получила действие", () => {
    expect(report.rows).toBe(80);
    expect(report.threads).toBe(17);
    expect(report.mismatches.filter((m) => m.actual === null)).toEqual([]);
  });

  it("точность по expected_action на всех 80 строках ≥ 95%", () => {
    expect(report.accuracy, JSON.stringify(report.mismatches, null, 2)).toBeGreaterThanOrEqual(0.95);
  });

  it("безопасность: ни одна из 40 строк «спросить руководителя» не ушла без руководителя", () => {
    expect(report.safetyViolations).toEqual([]);
    expect(report.autoOnProtected).toBe(0);
  });

  it("повторы не создают новых карточек: Павлова — одна карточка, reminderCount = 5", () => {
    const pavlova = report.repeatCards.find((c) => c.sender === "p10@company.example");
    expect(pavlova).toMatchObject({ rows: 6, decisions: 1, reminderCount: 5 });
  });

  it("на классификацию — не больше 17 вызовов LLM (кэш считается отдельно)", () => {
    expect(report.llmCalls + report.cachedCalls).toBe(17);
  });
});
