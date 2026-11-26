import { describe, expect, it } from "vitest";
import { LlmClient, MemoryCache, type LlmProvider, type UsageRecord } from "@/core/llm";
import { routeEmail, triageEmail } from "@/core/email-triage/classify";

const risk = { leaderEmail: "boss@corp.ru", org: [] };

function fakeProvider(object: unknown) {
  const calls = { n: 0 };
  const provider: LlmProvider = {
    name: "fake",
    model: "m",
    async generate() {
      calls.n++;
      return { object, promptTokens: 10, completionTokens: 5 };
    },
  };
  return { provider, calls };
}

const cls = (over: Record<string, unknown> = {}) => ({
  category: "STATUS", confidence: 0.9, amount: null, client: null, deadline: null, isUrgent: false, summary: "s", ...over,
});
const input = { leaderId: "l1", threadKey: "k1", senderEmail: "a@corp.ru", subject: "Статус", body: "всё ок" };

describe("LlmClient", () => {
  it("кэширует по ключу и пишет usage", async () => {
    const { provider, calls } = fakeProvider(cls());
    const usage: UsageRecord[] = [];
    const llm = new LlmClient({ provider, cache: new MemoryCache(), usage: { record: async (u) => void usage.push(u) } });
    await triageEmail(llm, input, risk);
    await triageEmail(llm, input, risk);
    expect(calls.n).toBe(1);
    expect(usage.map((u) => u.cached)).toEqual([false, true]);
  });

  it("невалидный ответ LLM — ошибка", async () => {
    const llm = new LlmClient({ provider: fakeProvider({ category: "NOPE" }).provider });
    await expect(triageEmail(llm, input, risk)).rejects.toThrow();
  });
});

describe("routeEmail", () => {
  it("таблица по умолчанию", () => {
    expect(routeEmail({ category: "NEWSLETTER", confidence: 0.9, signals: [] }).action).toBe("IGNORE");
    expect(routeEmail({ category: "SALES", confidence: 0.9, signals: [] }).action).toBe("DELEGATE");
  });

  it("жёсткий сигнал перебивает категорию LLM", () => {
    expect(routeEmail({ category: "STATUS", confidence: 0.99, signals: ["HR_TERMS"] }).action).toBe("ASK_LEADER");
  });

  it("правило не ослабляет защищённую категорию", () => {
    const r = routeEmail({ category: "HR", confidence: 0.99, signals: [], rules: [{ category: "HR", action: "AUTO" }] });
    expect(r.action).toBe("ASK_LEADER");
  });

  it("низкая уверенность и неизвестная категория — ASK_LEADER", () => {
    expect(routeEmail({ category: "NEWSLETTER", confidence: 0.4, signals: [] }).action).toBe("ASK_LEADER");
    expect(routeEmail({ category: null, confidence: 1, signals: [] }).action).toBe("ASK_LEADER");
  });

  it("правило может изменить действие незащищённой категории", () => {
    expect(routeEmail({ category: "REPORT", confidence: 0.9, signals: [], rules: [{ category: "REPORT", action: "IGNORE" }] }).action).toBe("IGNORE");
  });
});
