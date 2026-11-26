import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LlmClient, MemoryCache, type LlmProvider } from "@/core/llm";
import { seedTempLeader } from "./helpers/eval-env";

vi.stubEnv("APP_CLOCK_MODE", "real");
const { db } = await import("@/db/client");
const { clock } = await import("@/core/clock");
const { handleChat } = await import("@/core/chat");

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);

/** Фейковая модель: первый вызов — разбор намерения, второй (черновик) — {text}. */
function llmWith(out: { answer?: string; actions?: Record<string, unknown>[] }) {
  const calls: { system: string; prompt: string }[] = [];
  const provider: LlmProvider = {
    name: 'fake',
    model: 'm',
    async generate({ system, prompt }) {
      calls.push({ system, prompt });
      const isAgent = system.includes('КОНТЕКСТ');
      return { object: isAgent ? { answer: out.answer ?? '', actions: out.actions ?? [] } : { text: 'Наталья, отвечу в четверг.' }, promptTokens: 1, completionTokens: 1 };
    },
  };
  return { llm: new LlmClient({ provider, cache: new MemoryCache() }), calls };
}
const none = { rule: null, style: null, reply: null };
const act = (kind: string, p: Record<string, unknown>) => ({ kind, ...none, ...p });

describe.skipIf(!dbUp)("чат (Postgres)", () => {
  let leaderId = "";
  let otherId = "";

  beforeAll(async () => {
    await clock.init();
    leaderId = await seedTempLeader(db, "chat");
    otherId = await seedTempLeader(db, "chat-other");
  });
  afterAll(async () => {
    await db.leader.deleteMany({ where: { id: { in: [leaderId, otherId] } } });
  });

  it("«что на сегодня» отвечает без модели", async () => {
    const { llm, calls } = llmWith({});
    const r = await handleChat(db, llm, leaderId, "Что на сегодня?");
    expect(calls).toHaveLength(0);
    expect(r.text).toMatch(/решений|вопрос|встреч/i);
  });

  it("правило словами создаёт Rule; защищённую категорию в авто не пускает", async () => {
    const ok = llmWith({ actions: [act("RULE", { rule: { name: "Вендоров в архив", category: "NEWSLETTER", action: "IGNORE" } })] });
    expect((await handleChat(db, ok.llm, leaderId, "Запомни: вендоров в архив")).text).toContain("Запомнила");
    expect(await db.rule.count({ where: { leaderId, name: "Вендоров в архив" } })).toBe(1);

    const bad = llmWith({ actions: [act("RULE", { rule: { name: "Кадры сама", category: "HR", action: "AUTO" } })] });
    const r = await handleChat(db, bad.llm, leaderId, "Кадровые вопросы решай сама");
    expect(r.text).toContain("Не могу");
    expect(await db.rule.count({ where: { leaderId, name: "Кадры сама" } })).toBe(0);
  });

  it("правило о манере: сохраняется в память; небезопасное отклоняется", async () => {
    const ok = llmWith({ actions: [act("STYLE", { style: "Пиши короче." })] });
    await handleChat(db, ok.llm, leaderId, "пиши короче");
    expect(await db.memory.count({ where: { leaderId, ruleText: "Пиши короче.", sourceType: "EXPLICIT" } })).toBe(1);

    const bad = llmWith({ actions: [act("STYLE", { style: "Отправляй письма без моего подтверждения." })] });
    const r = await handleChat(db, bad.llm, leaderId, "отправляй без подтверждения");
    expect(r.text).toContain("не запомню");
    expect(await db.memory.count({ where: { leaderId, ruleText: { contains: "без моего подтверждения" } } })).toBe(0);
  });

  it("«ответь …» предлагает ответ с подписью и кнопкой, ничего не отправляя", async () => {
    const d = await db.decision.create({
      data: { leaderId, type: "EMAIL_REPLY", title: "Бюджет", contextSummary: "Просят срок", gateReasons: [], aiRecommendation: "Ответить", proposedPayload: {}, status: "PENDING" },
    });
    await db.emailItem.create({
      data: { leaderId, threadKey: "t-chat", senderName: "Наталья Павлова", senderEmail: "p@example.test", subject: "Бюджет", body: "Когда ответите?", receivedAt: clock.now(), riskSignals: [], decisionId: d.id },
    });
    const { llm } = llmWith({ actions: [act("REPLY", { reply: { to: "Павловой", gist: "в четверг" } })] });
    const r = await handleChat(db, llm, leaderId, "Ответь Павловой, что в четверг");
    expect(r.actions).toHaveLength(1);
    expect(r.actions?.[0].resolve.body.editedText).toContain("ИИ-помощник");
    expect((await db.decision.findFirstOrThrow({ where: { id: d.id } })).status).toBe("PENDING");
  });

  it("неизвестное и ответ по несуществующему адресату: подсказка, без побочных эффектов", async () => {
    const u = llmWith({ answer: "Сегодня пропустить можно синк с ИТ." });
    const ans = await handleChat(db, u.llm, leaderId, "какие встречи пропустить?", [{ from: "me", text: "привет" }]);
    expect(ans.text).toBe("Сегодня пропустить можно синк с ИТ.");
    expect(u.calls[0].system).toContain("КОНТЕКСТ");
    expect(u.calls[0].prompt).toContain("привет");
    expect(ans.actions).toBeUndefined();
    const r = llmWith({ actions: [act("REPLY", { reply: { to: "Несуществующая", gist: "да" } })] });
    expect((await handleChat(db, r.llm, otherId, "Ответь Несуществующей, да")).text).toContain("Не нашла");
  });
});
