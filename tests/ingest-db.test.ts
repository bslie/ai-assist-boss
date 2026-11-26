import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LlmClient, MemoryCache, type LlmProvider } from "@/core/llm";

vi.stubEnv("APP_CLOCK_MODE", "real");

// Интеграционный тест: нужен Postgres из docker-compose с применёнными миграциями.
const { db } = await import("@/db/client");
const { clock } = await import("@/core/clock");
const { ingestEmails } = await import("@/core/email-triage/ingest");

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);

const slug = `test-ingest-${Date.now()}`;
let leaderId = "";

// Фейковая модель отвечает по теме письма.
const answers: Record<string, { category: string; confidence: number }> = {
  "Подписка": { category: "NEWSLETTER", confidence: 0.95 },
  "Заявка на КП": { category: "SALES", confidence: 0.95 },
  "Регламент": { category: "STATUS", confidence: 0.9 }, // LLM ошиблась: письмо про деньги/согласование
};
const calls = { n: 0 };
const provider: LlmProvider = {
  name: "fake",
  model: "m",
  async generate({ prompt }) {
    calls.n++;
    const subject = /Тема: (.*)/.exec(prompt)?.[1] ?? "";
    const a = answers[subject] ?? { category: "STATUS", confidence: 0.9 };
    return { object: { ...a, amount: null, client: null, deadline: null, isUrgent: false, summary: `суть: ${subject}` }, promptTokens: 1, completionTokens: 1 };
  },
};

const at = (m: number) => new Date(Date.UTC(2026, 11, 7, 8, m));
const mail = (id: string, m: number, subject: string, body: string, senderEmail = "ext@client.ru") => ({
  externalId: id, senderName: "Отправитель", senderEmail, subject, body, receivedAt: at(m),
});

describe.skipIf(!dbUp)("ingestEmails (Postgres)", () => {
  beforeAll(async () => {
    await clock.init();
    const leader = await db.leader.create({
      data: {
        slug, name: "Тест Тестов", role: "CEO", email: `${slug}@corp.ru`,
        quarterGoals: [], stylePrompt: "", savedMinutesConfig: {}, profileMarkdown: "",
      },
    });
    leaderId = leader.id;
    await db.employee.create({
      data: { leaderId, name: "Продажник", email: "sales@corp.ru", position: "Директор по продажам", relationType: "SUBORDINATE", responsibilityArea: "продажи, КП" },
    });
    await db.rule.create({
      data: { leaderId, name: "КП → продажи", description: "КП", condition: { category: "SALES" }, action: "DELEGATE", delegateToArea: "продажи", source: "MANUAL" },
    });
  });

  afterAll(async () => {
    if (leaderId) await db.leader.delete({ where: { id: leaderId } });
    await db.$disconnect();
  });

  it("повторы привязываются к одной карточке; жёсткий сигнал перебивает LLM; повторный запуск идемпотентен", async () => {
    const reminder = "Прошу согласовать бюджет 500 тыс. руб. по регламенту";
    const emails = [
      mail("m1", 1, "Подписка", "Скидки недели"),
      mail("m2", 2, "Заявка на КП", "Подготовьте КП", "buyer@client.ru"),
      mail("m3", 3, "Регламент", reminder),
      mail("m4", 4, "Регламент", reminder),
      mail("m5", 5, "Регламент", reminder),
    ];
    const llm = new LlmClient({ provider, cache: new MemoryCache() });

    const stats = await ingestEmails(db, llm, leaderId, emails);
    expect(stats.processed).toBe(5);
    expect(stats.threads).toBe(3);
    expect(calls.n).toBe(3);
    expect(stats.byAction).toMatchObject({ IGNORE: 1, DELEGATE: 1, ASK_LEADER: 1 });
    expect(stats.tasksCreated).toBe(1);

    const decisions = await db.decision.findMany({ where: { leaderId } });
    expect(decisions).toHaveLength(1);
    expect(decisions[0].reminderCount).toBe(2);
    expect(decisions[0].status).toBe("PENDING");

    const items = await db.emailItem.findMany({ where: { leaderId, subject: "Регламент" }, orderBy: { occurrence: "asc" } });
    expect(items.map((i) => i.occurrence)).toEqual([1, 2, 3]);
    expect(new Set(items.map((i) => i.decisionId)).size).toBe(1);
    expect(items.every((i) => i.action === "ASK_LEADER")).toBe(true);

    const again = await ingestEmails(db, llm, leaderId, emails);
    expect(again.skippedExisting).toBe(5);
    expect(await db.decision.count({ where: { leaderId } })).toBe(1);
  });
});
