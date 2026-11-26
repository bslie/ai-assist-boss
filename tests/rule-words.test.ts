import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LlmClient, MemoryCache, type LlmProvider } from "@/core/llm";
import type { Button, Messenger } from "@/core/telegram/types";
import { MemoryState } from "@/core/telegram/types";
import { seedTempLeader } from "./helpers/eval-env";

vi.stubEnv("APP_CLOCK_MODE", "real");
const { db } = await import("@/db/client");
const { clock } = await import("@/core/clock");
const { proposeRuleFromText, saveRuleProposal } = await import("@/core/learning/rule-words");
const { handleCallback, handleText } = await import("@/core/telegram/handlers");
const { handleStart, leaderBindSecret } = await import("@/core/telegram/bindings");
const { ingestEmails } = await import("@/core/email-triage/ingest");
const { createRule } = await import("@/core/rules");

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);
const KEY = "test-bind-key";

/** Фейковая модель: по фразе возвращает заранее заданный разбор. */
const drafts: Record<string, object> = {
  "Письма от Орлова присылай сразу": { isRule: true, name: "Орлов сразу", category: null, senderName: "Орлов", action: "ASK_LEADER", delegateToArea: null, notifyImmediately: true, weekOnly: false },
  "Отчёты читай только в сводке на этой неделе": { isRule: true, name: "Отчёты в сводку", category: "REPORT", senderName: null, action: "DIGEST", delegateToArea: null, notifyImmediately: false, weekOnly: true },
  "Кадровые вопросы решай сама": { isRule: true, name: "Кадры сама", category: "HR", senderName: null, action: "AUTO", delegateToArea: null, notifyImmediately: false, weekOnly: false },
  "Письма Орлова решай сама": { isRule: true, name: "Орлов сама", category: null, senderName: "Орлов", action: "AUTO", delegateToArea: null, notifyImmediately: false, weekOnly: false },
  "Письма от Кого-то в архив": { isRule: true, name: "x", category: null, senderName: "Никто Неизвестный", action: "IGNORE", delegateToArea: null, notifyImmediately: false, weekOnly: false },
  "Как дела?": { isRule: false, name: "", category: null, senderName: null, action: "ASK_LEADER", delegateToArea: null, notifyImmediately: false, weekOnly: false },
};
const provider: LlmProvider = {
  name: "fake",
  model: "m",
  async generate({ prompt }) {
    const d = drafts[prompt];
    if (d) return { object: d, promptTokens: 1, completionTokens: 1 };
    // Классификация письма (ingest) и прочее.
    return { object: { category: "STATUS", confidence: 0.9, amount: null, client: null, deadline: null, isUrgent: false, summary: "суть" }, promptTokens: 1, completionTokens: 1 };
  },
};

describe.skipIf(!dbUp)("правила словами (Postgres)", () => {
  let leaderId = "";
  let slug = "";
  const llm = () => new LlmClient({ provider, cache: new MemoryCache() });
  const chatId = () => `rw-${leaderId.slice(-6)}`;

  beforeAll(async () => {
    await clock.init();
    leaderId = await seedTempLeader(db, "rw");
    slug = (await db.leader.findUniqueOrThrow({ where: { id: leaderId } })).slug;
  }, 60_000);
  afterAll(async () => {
    await db.leader.deleteMany({ where: { id: leaderId } });
    await db.$disconnect();
  });

  it("«Письма от Орлова присылай сразу» → правило по отправителю с понятным разбором", async () => {
    const r = await proposeRuleFromText(db, llm(), leaderId, "Письма от Орлова присылай сразу");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal).toMatchObject({ senderEmail: "p09@company.example", action: "ASK_LEADER", notifyImmediately: true });
    expect(r.proposal.summary).toContain("сообщать сразу");
  });

  it("защита: нельзя ослабить категорию и письма руководства; неизвестный человек и не-правило", async () => {
    const hr = await proposeRuleFromText(db, llm(), leaderId, "Кадровые вопросы решай сама");
    expect(hr).toMatchObject({ ok: false });
    expect(!hr.ok && hr.message).toContain("защищена");
    const boss = await proposeRuleFromText(db, llm(), leaderId, "Письма Орлова решай сама");
    expect(!boss.ok && boss.message).toContain("руководства");
    const nobody = await proposeRuleFromText(db, llm(), leaderId, "Письма от Кого-то в архив");
    expect(!nobody.ok && nobody.message).toContain("Не нашла");
    const chat = await proposeRuleFromText(db, llm(), leaderId, "Как дела?");
    expect(chat).toMatchObject({ ok: false, notARule: true });
  });

  it("createRule сам не даёт ослабить руководство по отправителю", async () => {
    const res = await createRule(db, leaderId, { name: "x", description: "x", senderEmail: "p09@company.example", action: "IGNORE" });
    expect(res).toMatchObject({ ok: false, code: "LOCKED" });
    expect(await createRule(db, leaderId, { name: "x", description: "x", action: "IGNORE" })).toMatchObject({ ok: false, code: "INVALID" });
  });

  it("«Только на неделю» ставит срок 7 дней и правило перестаёт действовать после срока", async () => {
    const r = await proposeRuleFromText(db, llm(), leaderId, "Отчёты читай только в сводке на этой неделе");
    if (!r.ok) throw new Error(r.message);
    const saved = await saveRuleProposal(db, leaderId, r.proposal, { weekOnly: true });
    expect(saved.ok).toBe(true);
    const rule = await db.rule.findFirstOrThrow({ where: { leaderId, name: "Отчёты в сводку", source: "MANUAL" } });
    const days = ((rule.expiresAt?.getTime() ?? 0) - clock.now().getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);
  });

  it("правило по отправителю работает в разборе почты и не ослабляет жёсткие сигналы", async () => {
    // Алексей Новиков (аналитик): все его письма — в архив.
    const mk = await createRule(db, leaderId, { name: "Новиков в архив", description: "x", senderEmail: "p07@company.example", action: "IGNORE" });
    expect(mk.ok).toBe(true);
    const at = new Date("2026-12-07T09:00:00+03:00");
    const stats = await ingestEmails(db, llm(), leaderId, [
      { externalId: "rw1", senderName: "Алексей Новиков", senderEmail: "p07@company.example", subject: "Дашборд", body: "Дашборд обновлён", receivedAt: at },
      { externalId: "rw2", senderName: "Алексей Новиков", senderEmail: "p07@company.example", subject: "Отпуск", body: "Прошу отпуск с 20 декабря", receivedAt: at },
    ]);
    expect(stats.byAction).toMatchObject({ IGNORE: 1, ASK_LEADER: 1 }); // «отпуск» — жёсткий сигнал HR, правило не перебивает
  });

  describe("Telegram: свободный текст руководителя", () => {
    const sent: { text: string; buttons?: Button[][] }[] = [];
    const edits: string[] = [];
    const m: Messenger = {
      async send(_c, text, buttons) {
        sent.push({ text, buttons });
        return { messageId: String(sent.length) };
      },
      async edit(_c, _id, text) {
        edits.push(text);
      },
    };
    const state = new MemoryState();
    const deps = () => ({ db, messenger: m, state, llm: llm() });

    it("правило → кнопки; «Сохранить» пишет правило, повторное нажатие не дублирует", async () => {
      await handleStart(db, chatId(), `${slug}:${leaderBindSecret(slug, KEY)}`, KEY);
      expect(await handleText(deps(), chatId(), "Письма от Орлова присылай сразу")).toBe("");
      const card = sent.at(-1)!;
      expect(card.text).toContain("Я поняла так");
      const labels = card.buttons!.flat().map((b) => b.text);
      expect(labels).toEqual(["Сохранить", "Только на неделю", "Отмена"]);
      const save = card.buttons![0][0].data;

      const before = await db.rule.count({ where: { leaderId, source: "MANUAL" } });
      expect(await handleCallback(deps(), { chatId: chatId(), messageId: "1", data: save })).toBe("Запомнила");
      expect(await db.rule.count({ where: { leaderId, source: "MANUAL" } })).toBe(before + 1);
      expect(await handleCallback(deps(), { chatId: chatId(), messageId: "1", data: save })).toContain("устарело");
      expect(await db.rule.count({ where: { leaderId, source: "MANUAL" } })).toBe(before + 1);
    });

    it("«Отмена» ничего не пишет; чужой чат не может подтвердить", async () => {
      await handleText(deps(), chatId(), "Письма от Орлова присылай сразу");
      const buttons = sent.at(-1)!.buttons!;
      const before = await db.rule.count({ where: { leaderId, source: "MANUAL" } });
      expect(await handleCallback(deps(), { chatId: "stranger", messageId: "1", data: buttons[0][0].data })).toContain("Нет доступа");
      expect(await handleCallback(deps(), { chatId: chatId(), messageId: "1", data: buttons[1][0].data })).toBe("Отменено");
      expect(await db.rule.count({ where: { leaderId, source: "MANUAL" } })).toBe(before);
    });

    it("отказ по защите объясняется текстом, без кнопок", async () => {
      const n = sent.length;
      const reply = await handleText(deps(), chatId(), "Кадровые вопросы решай сама");
      expect(reply).toContain("защищена");
      expect(sent).toHaveLength(n);
    });
  });
});
