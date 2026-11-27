import { describe, expect, it } from "vitest";
import { loadInbox } from "@/core/dataset";
import { claimedSender } from "@/core/mail/types";
import { Clock } from "@/core/clock";
import { buildPlan, parseArgs } from "../scripts/send-dataset-emails";

describe("send-dataset-emails: план", () => {
  const inbox = loadInbox();
  it("по умолчанию 17 уникальных тредов в порядке получения", () => {
    const plan = buildPlan(inbox, { all: false, speed: 1 });
    expect(plan.mails).toHaveLength(17);
    const times = plan.mails.map((m) => m.receivedAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(plan.pauseMs).toBe(30_000);
  });
  it("--all — все 80 строк, --speed сжимает паузу, 0 — без пауз", () => {
    expect(buildPlan(inbox, { all: true, speed: 10 })).toMatchObject({ pauseMs: 3000 });
    expect(buildPlan(inbox, { all: true, speed: 10 }).mails).toHaveLength(80);
    expect(buildPlan(inbox, { all: false, speed: 0 }).pauseMs).toBe(0);
  });
  it("разбор аргументов, мусор в --speed отклоняется", () => {
    expect(parseArgs(["--all", "--speed", "5", "--to", "a@b.ru", "--dry-run"])).toEqual({ all: true, speed: 5, to: "a@b.ru", dryRun: true });
    expect(parseArgs([])).toEqual({ all: false, speed: 1, to: null, dryRun: false });
    expect(() => parseArgs(["--speed", "fast"])).toThrow();
    expect(() => parseArgs(["--speed", "-3"])).toThrow();
  });
});

describe("заголовок X-Dataset-From", () => {
  const trusted = "sender@test.ru";
  it("принимается только от доверенного адреса", () => {
    expect(claimedSender("sender@test.ru", '"Виктор Орлов" <P09@company.example>', trusted)).toEqual({ address: "p09@company.example", name: "Виктор Орлов" });
    expect(claimedSender("SENDER@test.ru", "p09@company.example", trusted)).toEqual({ address: "p09@company.example", name: "p09@company.example" });
    expect(claimedSender("evil@test.ru", '"Виктор Орлов" <p09@company.example>', trusted)).toBeNull();
  });
  it("без доверенного адреса или с мусором игнорируется", () => {
    expect(claimedSender("sender@test.ru", "<p09@company.example>", undefined)).toBeNull();
    expect(claimedSender("sender@test.ru", "не адрес", trusted)).toBeNull();
    expect(claimedSender("sender@test.ru", undefined, trusted)).toBeNull();
  });
});

describe("Clock.toDemo", () => {
  it("переводит реальное время письма в демо-время", async () => {
    const real = Date.UTC(2026, 10, 27, 12, 0);
    const clk = new Clock({ mode: "demo", demoStart: new Date("2026-12-07T08:30:00+03:00"), realNow: () => real });
    await clk.init();
    expect(clk.toDemo(new Date(real - 60_000)).toISOString()).toBe("2026-12-07T05:29:00.000Z");
    expect(clk.toDemo(new Date(real)).getTime()).toBe(clk.now().getTime());
  });
});
