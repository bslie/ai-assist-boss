import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadInbox } from "@/core/dataset";
import { DATASET_CATEGORY } from "@/core/dataset/categories";
import { LlmClient, MemoryCache, type LlmProvider } from "@/core/llm";
import type { LeaderEvent } from "@/core/events";
import { seedTempLeader } from "./helpers/eval-env";

vi.stubEnv("APP_CLOCK_MODE", "real");
const { db } = await import("@/db/client");
const { clock } = await import("@/core/clock");
const { ingestEmails } = await import("@/core/email-triage/ingest");
const { getToday } = await import("@/core/dashboard");
const { resolveDecision } = await import("@/core/decisions");
const { createRule, patchRules, listRules } = await import("@/core/rules");
const { publishEvent, subscribeEvents } = await import("@/core/events");

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);

const inbox = loadInbox();
const truth = new Map(inbox.map((m) => [`${m.subject}\n${m.body}`, m.datasetCategory]));
const oracle: LlmProvider = {
  name: "oracle",
  model: "dataset-category",
  async generate({ prompt }) {
    const m = /^От: .*\nТема: (.*)\n\n([\s\S]*)$/.exec(prompt);
    const cat = m && truth.get(`${m[1]}\n${m[2]}`);
    if (!cat) throw new Error("oracle: письмо не найдено");
    return {
      object: { category: DATASET_CATEGORY[cat], confidence: 0.95, amount: null, client: null, deadline: null, isUrgent: false, summary: `суть: ${m[1]}` },
      promptTokens: 0,
      completionTokens: 0,
    };
  },
};

describe.skipIf(!dbUp)("ядро API (Postgres, Redis)", () => {
  let leaderId = "";
  let otherLeaderId = "";
  const events: LeaderEvent[] = [];
  let unsubscribe: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    await clock.init();
    leaderId = await seedTempLeader(db, "api");
    otherLeaderId = await seedTempLeader(db, "api-other");
    unsubscribe = await subscribeEvents(leaderId, (e) => void events.push(e));
    const llm = new LlmClient({ provider: oracle, cache: new MemoryCache() });
    await ingestEmails(db, llm, leaderId, inbox, { emit: (e) => publishEvent(leaderId, e) });
  }, 60_000);

  afterAll(async () => {
    await unsubscribe?.();
    await db.leader.deleteMany({ where: { id: { in: [leaderId, otherLeaderId].filter(Boolean) } } });
    await db.$disconnect();
  });

  it("ingest публикует decision.created и email.processed", async () => {
    await vi.waitFor(() => {
      expect(events.filter((e) => e.type === "decision.created")).toHaveLength(8);
      expect(events.filter((e) => e.type === "email.processed")).toHaveLength(80);
    });
  });

  it("дашборд: 8 карточек, повторы собраны, данные другого руководителя не видны", async () => {
    const today = await getToday(db, leaderId);
    expect(today.decisions).toHaveLength(8);
    expect(today.headline).toMatchObject({ total: 80, waiting: 8 });
    const pavlova = today.decisions.find((d) => d.from.includes("Павлова"));
    expect(pavlova?.reminderCount).toBe(5);
    expect(pavlova?.tag).toContain("повтор ×6");
    expect(today.metrics.autoEmailsPct).toBe(50);

    const other = await getToday(db, otherLeaderId);
    expect(other.decisions).toHaveLength(0);
    expect(other.headline.total).toBe(0);
  });

  it("resolve: утверждение один раз, повтор — ALREADY_RESOLVED, чужая карточка — NOT_FOUND", async () => {
    const [card] = (await getToday(db, leaderId)).decisions;
    const foreign = await resolveDecision(db, otherLeaderId, card.id, { action: "APPROVE" });
    expect(foreign).toMatchObject({ ok: false, code: "NOT_FOUND" });

    const first = await resolveDecision(db, leaderId, card.id, { action: "APPROVE" });
    expect(first).toEqual({ ok: true, status: "APPROVED" });
    const second = await resolveDecision(db, leaderId, card.id, { action: "APPROVE" });
    expect(second).toMatchObject({ ok: false, code: "ALREADY_RESOLVED" });

    const row = await db.decision.findUniqueOrThrow({ where: { id: card.id } });
    expect(row.status).toBe("APPROVED");
    expect(row.resolvedAt).not.toBeNull();
    expect((await getToday(db, leaderId)).decisions).toHaveLength(7);
    await vi.waitFor(() => expect(events.some((e) => e.type === "decision.updated" && e.data.id === card.id)).toBe(true));
  });

  it("resolve: правка сохраняет текст; делегирование — только своему сотруднику", async () => {
    const cards = (await getToday(db, leaderId)).decisions;
    const edited = await resolveDecision(db, leaderId, cards[0].id, { action: "EDITED_APPROVED", editedText: "Мой текст" });
    expect(edited).toEqual({ ok: true, status: "EDITED_APPROVED" });
    expect((await db.decision.findUniqueOrThrow({ where: { id: cards[0].id } })).editedText).toBe("Мой текст");

    const foreignEmp = await db.employee.findFirstOrThrow({ where: { leaderId: otherLeaderId } });
    const bad = await resolveDecision(db, leaderId, cards[1].id, { action: "DELEGATE", delegateToId: foreignEmp.id });
    expect(bad).toMatchObject({ ok: false, code: "BAD_DELEGATE" });
    const own = await db.employee.findFirstOrThrow({ where: { leaderId } });
    expect(await resolveDecision(db, leaderId, cards[1].id, { action: "DELEGATE", delegateToId: own.id })).toEqual({ ok: true, status: "DELEGATED" });
  });
});

describe.skipIf(!dbUp)("правила: защита от ослабления", () => {
  let leaderId = "";
  beforeAll(async () => {
    leaderId = await seedTempLeader(db, "rules");
  });
  afterAll(async () => {
    if (leaderId) await db.leader.delete({ where: { id: leaderId } });
  });

  it("защищённые категории и деньги нельзя перевести в авто", async () => {
    for (const category of ["HR", "MANAGEMENT", "CLIENT_COMMITMENT", "MONEY"] as const) {
      const res = await createRule(db, leaderId, { name: "x", description: "y", category, action: "AUTO" });
      expect(res).toMatchObject({ ok: false, code: "LOCKED" });
    }
    expect(await createRule(db, leaderId, { name: "x", description: "y", category: "HR", action: "ASK_LEADER" })).toMatchObject({ ok: true });
  });

  it("обычное правило создаётся и меняется; системное — нет", async () => {
    const created = await createRule(db, leaderId, { name: "Логисты", description: "в сводку", category: "STATUS", action: "DIGEST" });
    if (!created.ok) throw new Error("expected ok");
    expect(await patchRules(db, leaderId, { kind: "rule", id: created.value.id, patch: { action: "IGNORE" } })).toMatchObject({ ok: true });

    const locked = await db.rule.findFirstOrThrow({ where: { leaderId, isSystemLocked: true } });
    expect(await patchRules(db, leaderId, { kind: "rule", id: locked.id, patch: { action: "AUTO" } })).toMatchObject({ ok: false, code: "LOCKED" });
    expect(await patchRules(db, leaderId, { kind: "rule", id: "nope", patch: { name: "z" } })).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("правило защищённой категории нельзя ослабить PATCH-ем; настройки меняются", async () => {
    const ask = await createRule(db, leaderId, { name: "Кадры строго", description: "y", category: "HR", action: "ASK_LEADER" });
    if (!ask.ok) throw new Error("expected ok");
    expect(await patchRules(db, leaderId, { kind: "rule", id: ask.value.id, patch: { action: "AUTO" } })).toMatchObject({ ok: false, code: "LOCKED" });

    expect(await patchRules(db, leaderId, { kind: "settings", budgetAutoLimit: 5000, protectedBlocks: ["Стратегия"] })).toMatchObject({ ok: true });
    expect((await listRules(db, leaderId)).settings).toEqual({ budgetAutoLimit: 5000, protectedBlocks: ["Стратегия"] });
  });
});
