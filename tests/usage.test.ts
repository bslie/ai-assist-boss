import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LlmClient, MemoryCache, pricingFromEnv, type LlmProvider } from "@/core/llm";
import { z } from "zod";

vi.stubEnv("APP_CLOCK_MODE", "real");

const { db } = await import("@/db/client");
const { clock } = await import("@/core/clock");
const { dbUsageSink } = await import("@/core/llm/usage-db");
const { costReportCsv, getCostReport, recallCostRub, recordServiceUsage } = await import("@/core/usage");

describe("цены из env", () => {
  it("нет цен или мусор → undefined", () => {
    expect(pricingFromEnv({})).toBeUndefined();
    expect(pricingFromEnv({ LLM_PRICE_INPUT_RUB_PER_M: "abc" })).toBeUndefined();
    expect(pricingFromEnv({ LLM_PRICE_INPUT_RUB_PER_M: "-1", LLM_PRICE_OUTPUT_RUB_PER_M: "1" })).toBeUndefined();
  });
  it("читает пару цен", () => {
    expect(pricingFromEnv({ LLM_PRICE_INPUT_RUB_PER_M: "100", LLM_PRICE_OUTPUT_RUB_PER_M: "300" })).toEqual({ inputPerMillionRub: 100, outputPerMillionRub: 300 });
  });
  it("Recall: ₽ за час → ₽ за секунды", () => {
    expect(recallCostRub(1800, { RECALL_PRICE_RUB_PER_HOUR: "60" })).toBe(30);
    expect(recallCostRub(1800, {})).toBe(0);
  });
});

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);

describe.skipIf(!dbUp)("отчёт стоимости (Postgres)", () => {
  let leaderId = "";
  beforeAll(async () => {
    await clock.init();
    leaderId = (
      await db.leader.create({
        data: { slug: `test-usage-${Date.now()}`, name: "Тест Цен", role: "x", email: `usage-${Date.now()}@corp.ru`, quarterGoals: [], stylePrompt: "", savedMinutesConfig: {}, profileMarkdown: "" },
      })
    ).id;
  });
  afterAll(async () => {
    await db.leader.delete({ where: { id: leaderId } });
    await db.$disconnect();
  });

  it("платный вызов считается по ценам, кэшированный бесплатен; среднее — на платный вызов", async () => {
    const provider: LlmProvider = { name: "fake", model: "m", generate: async () => ({ object: { ok: true }, promptTokens: 1000, completionTokens: 500 }) };
    const llm = new LlmClient({ provider, cache: new MemoryCache(), usage: dbUsageSink(db), pricing: { inputPerMillionRub: 100, outputPerMillionRub: 400 } });
    const req = { leaderId, pipeline: "EMAIL_TRIAGE" as const, schema: z.object({ ok: z.boolean() }), system: "s", prompt: "p", cacheKey: "k1" };
    await llm.generateStructured(req);
    await llm.generateStructured(req); // из кэша
    await llm.generateStructured({ ...req, cacheKey: "k2" });
    await recordServiceUsage(db, { leaderId, pipeline: "AVATAR_SESSION", provider: "recall.ai", model: "bot", audioSeconds: 1800, costRub: 30 });

    const report = await getCostReport(db, leaderId);
    const triage = report.rows.find((r) => r.pipeline === "EMAIL_TRIAGE")!;
    expect(triage).toMatchObject({ calls: 3, cachedCalls: 1, promptTokens: 2000, completionTokens: 1000 });
    expect(triage.costRub).toBeCloseTo(0.6, 6); // 2 × (1000×100 + 500×400) / 1e6
    expect(triage.avgCostRub).toBeCloseTo(0.3, 6);
    expect(report.rows.find((r) => r.pipeline === "AVATAR_SESSION")).toMatchObject({ audioSeconds: 1800, costRub: 30 });
    expect(report.totalRub).toBeCloseTo(30.6, 6);
    expect(report.paidCalls).toBe(3);

    const csv = costReportCsv(report);
    expect(csv.split("\n")[0]).toContain("avg_cost_rub_per_paid_call");
    expect(csv).toContain("EMAIL_TRIAGE,fake,m,3,1,2000,1000");
    expect(csv).toContain("TOTAL");
  });

  it("чужой руководитель не попадает в отчёт", async () => {
    const other = await getCostReport(db, "no-such-leader");
    expect(other.rows).toEqual([]);
    expect(other.perRequestRub).toBeNull();
  });
});
