import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedTempLeader } from "./helpers/eval-env";

vi.stubEnv("APP_CLOCK_MODE", "real");
const { db } = await import("@/db/client");
const { clock } = await import("@/core/clock");
const { inQuietHours, minutesOfDay, shouldNotifyNow } = await import("@/core/telegram/antispam");
const { relayEvent } = await import("@/core/telegram/relay");
const { processRoutineJob } = await import("@/core/telegram/morning");
const { handleStart, leaderBindSecret } = await import("@/core/telegram/bindings");

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);
const msk = (hhmm: string) => new Date(`2026-12-08T${hhmm}:00+03:00`);

describe("тихие часы", () => {
  it("интервал через полночь и обычный", () => {
    expect(minutesOfDay(msk("08:30"))).toBe(8 * 60 + 30);
    expect(inQuietHours("20:00", "08:00", msk("23:15"))).toBe(true);
    expect(inQuietHours("20:00", "08:00", msk("03:00"))).toBe(true);
    expect(inQuietHours("20:00", "08:00", msk("08:00"))).toBe(false); // конец не включён
    expect(inQuietHours("20:00", "08:00", msk("12:00"))).toBe(false);
    expect(inQuietHours("13:00", "14:00", msk("13:30"))).toBe(true);
  });
  it("кривые значения и пустой интервал → тихих часов нет", () => {
    expect(inQuietHours("25:00", "08:00", msk("23:00"))).toBe(false);
    expect(inQuietHours("abc", "08:00", msk("23:00"))).toBe(false);
    expect(inQuietHours("20:00", "20:00", msk("23:00"))).toBe(false);
  });
});

describe.skipIf(!dbUp)("антиспам (Postgres)", () => {
  let leaderId = "";
  let slug = "";
  const sent: string[] = [];
  const m = {
    async send(_c: string, text: string) {
      sent.push(text);
      return { messageId: String(sent.length) };
    },
    async edit() {},
  };

  const card = async (over: { category: string; signals?: string[]; sender?: string }) => {
    const d = await db.decision.create({ data: { leaderId, type: "EMAIL_REPLY", title: `Тема ${over.category}`, contextSummary: "с", gateReasons: [], aiRecommendation: "Спросить", proposedPayload: {} } });
    await db.emailItem.create({
      data: { leaderId, externalId: `as-${d.id}`, threadKey: d.id, senderName: "Кто-то", senderEmail: over.sender ?? "who@x.example", subject: "s", body: "b", receivedAt: new Date(), category: over.category as never, riskSignals: over.signals ?? [], action: "ASK_LEADER", decisionId: d.id },
    });
    return d.id;
  };

  beforeAll(async () => {
    await clock.init();
    leaderId = await seedTempLeader(db, "as");
    slug = (await db.leader.findUniqueOrThrow({ where: { id: leaderId } })).slug;
  }, 60_000);
  afterAll(async () => {
    await db.leader.deleteMany({ where: { id: leaderId } });
    await db.$disconnect();
  });

  it("днём карточки идут сразу, ночью только защищённые, с жёстким сигналом или помеченные «сразу»", async () => {
    const hr = await card({ category: "HR" });
    const signal = await card({ category: "STATUS", signals: ["MANAGER_PARTY"] });
    const plain = await card({ category: "INVITATION" });
    const flagged = await card({ category: "SALES", sender: "vip@x.example" });
    await db.rule.create({ data: { leaderId, name: "VIP сразу", description: "x", condition: { senderEmail: "vip@x.example" }, action: "ASK_LEADER", notifyImmediately: true, source: "MANUAL" } });
    const expired = await card({ category: "REPORT", sender: "old@x.example" });
    await db.rule.create({ data: { leaderId, name: "Старое", description: "x", condition: { senderEmail: "old@x.example" }, action: "ASK_LEADER", notifyImmediately: true, expiresAt: new Date(0), source: "MANUAL" } });

    const day = msk("12:00");
    const night = msk("23:30");
    for (const id of [hr, signal, plain, flagged, expired]) expect(await shouldNotifyNow(db, leaderId, id, day)).toEqual({ now: true });
    expect(await shouldNotifyNow(db, leaderId, hr, night)).toEqual({ now: true });
    expect(await shouldNotifyNow(db, leaderId, signal, night)).toEqual({ now: true });
    expect(await shouldNotifyNow(db, leaderId, flagged, night)).toEqual({ now: true });
    expect(await shouldNotifyNow(db, leaderId, plain, night)).toMatchObject({ now: false });
    expect(await shouldNotifyNow(db, leaderId, expired, night)).toMatchObject({ now: false }); // срок правила вышел
  });

  it("карточка не из письма ночью ждёт утра; свои тихие часы руководителя уважаются", async () => {
    const d = await db.decision.create({ data: { leaderId, type: "TASK_ACCEPT", title: "t", contextSummary: "c", gateReasons: [], aiRecommendation: "x", proposedPayload: {} } });
    expect(await shouldNotifyNow(db, leaderId, d.id, msk("22:00"))).toMatchObject({ now: false });
    await db.leader.update({ where: { id: leaderId }, data: { quietHoursStart: "23:00", quietHoursEnd: "23:30" } });
    expect(await shouldNotifyNow(db, leaderId, d.id, msk("22:00"))).toEqual({ now: true });
    await db.leader.update({ where: { id: leaderId }, data: { quietHoursStart: "20:00", quietHoursEnd: "08:00" } });
  });

  it("утренний план отправляет накопленные карточки; повтор не дублирует", async () => {
    await handleStart(db, `as-${leaderId.slice(-6)}`, `${slug}:${leaderBindSecret(slug, "test-bind-key")}`, "test-bind-key");
    await db.decision.deleteMany({ where: { leaderId } });
    const queued = await db.decision.create({ data: { leaderId, type: "TASK_ACCEPT", title: "Накопилась за ночь", contextSummary: "c", gateReasons: [], aiRecommendation: "x", proposedPayload: {} } });
    // событие ночью: relay ничего не шлёт только если сейчас тихие часы; проверяем само накопление через утро
    const n = sent.length;
    const res = await processRoutineJob({ db, messenger: m }, { routineId: "r", leaderId, code: "MORNING_DIGEST", firedAt: new Date().toISOString() });
    expect(res).toEqual({ sent: 1 });
    expect(sent.slice(n).some((t) => t.includes("Накопилась за ночь"))).toBe(true);
    const n2 = sent.length;
    await processRoutineJob({ db, messenger: m }, { routineId: "r", leaderId, code: "MORNING_DIGEST", firedAt: new Date().toISOString() });
    expect(sent.slice(n2).filter((t) => t.includes("Накопилась за ночь"))).toHaveLength(0);
    expect((await db.decision.findUniqueOrThrow({ where: { id: queued.id } })).telegramMessageId).not.toBeNull();
    expect(typeof relayEvent).toBe("function");
  });
});
