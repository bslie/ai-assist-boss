import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PROFILES_DIR, loadAreas, loadInbox, loadOrg, loadProfileMarkdown, loadTasks } from "@/core/dataset";
import { BUDGET_TOOL, budgetAutoApproval } from "@/core/email-triage/budget";
import { routeEmail, type Classification } from "@/core/email-triage/classify";
import { LlmClient, MemoryCache, type LlmProvider } from "@/core/llm";
import { ProfileDraftSchema, sanitizeDraft } from "@/core/profile";

vi.stubEnv("APP_CLOCK_MODE", "real");

const { db } = await import("@/db/client");
const { clock } = await import("@/core/clock");
const { ingestEmails } = await import("@/core/email-triage/ingest");
const { seedLeader } = await import("@/db/seed-leader");

const draft = ProfileDraftSchema.parse(JSON.parse(readFileSync(path.join(PROFILES_DIR, "leader2_profile.draft.json"), "utf8")));
const org = loadOrg(PROFILES_DIR, "company.example", "leader2_org.csv");

describe("второй руководитель: данные", () => {
  it("оргструктура: свои сотрудники и общие руководство и коллеги", () => {
    expect(org.leader.name).toBe("Татьяна Громова");
    expect(org.members.filter((m) => m.relationType === "SUBORDINATE")).toHaveLength(5);
    expect(org.members.filter((m) => m.relationType === "MANAGER")).toHaveLength(1);
    expect(org.members.filter((m) => m.relationType === "PEER")).toHaveLength(3);
    expect(new Set([org.leader, ...org.members].map((m) => m.email)).size).toBe(org.members.length + 1);
  });

  it("профиль: другие цели и порог, защищённые категории на месте, предупреждений нет", () => {
    expect(draft.budgetAutoLimit).toBe(30000);
    expect(draft.goals).toHaveLength(3);
    expect(sanitizeDraft(draft).warnings).toEqual([]);
    expect(draft.neverWithoutApproval.map((r) => r.category).sort()).toEqual(["CLIENT_COMMITMENT", "HR", "MANAGEMENT", "MONEY"]);
    expect(loadProfileMarkdown(path.join(PROFILES_DIR, "leader2_profile.md"))).toContain("30 000");
  });

  it("зоны ответственности находят исполнителей по правилам профиля", () => {
    const areas = loadAreas(path.join(PROFILES_DIR, "leader2_areas.json"));
    expect(areas).not.toHaveProperty("_comment");
    const byArea = (needle: string) => org.members.filter((m) => (areas[m.externalId] ?? "").toLowerCase().includes(needle));
    for (const rule of draft.allowed.filter((r) => r.delegateToArea)) {
      expect(byArea(rule.delegateToArea!), `правило «${rule.name}»`).toHaveLength(1);
    }
  });

  it("задачи и дополнительные письма читаются; дополнительные не пересекаются с эталоном", () => {
    expect(loadTasks(PROFILES_DIR, "leader2_tasks.csv")).toHaveLength(4);
    const extra = loadInbox(PROFILES_DIR, "extra_inbox.csv");
    expect(extra.map((m) => m.externalId)).toEqual(["x001", "x002", "x003"]);
    expect(loadInbox().some((m) => extra.some((x) => x.externalId === m.externalId))).toBe(false);
    expect(loadInbox()).toHaveLength(80);
  });
});

const baseClass: Classification = { category: "MONEY", confidence: 0.95, amount: 18000, client: null, deadline: null, isUrgent: false, summary: "счёт" };
const input = { leaderId: "l", threadKey: "k", senderEmail: "p07@company.example", subject: "Оплата", body: "Счёт 18 000 ₽, оплата в течение пяти дней." };
const risk = { leaderEmail: "p13@company.example", org: [] };
const ask = routeEmail({ category: "MONEY", confidence: 0.95, signals: ["MONEY_TERMS"] });

describe("порог бюджета (SPEC 4.1, шаг 3)", () => {
  const run = (limit: number, c: Partial<Classification> = {}, signals: Parameters<typeof budgetAutoApproval>[0]["signals"] = ["MONEY_TERMS"]) =>
    budgetAutoApproval({ leader: { budgetAutoLimit: limit, protectedBlocks: [] }, risk, input, classification: { ...baseClass, ...c }, signals, decision: ask });

  it("по умолчанию MONEY всегда уходит руководителю", () => {
    expect(ask.action).toBe("ASK_LEADER");
    expect(run(0)).toBeNull();
  });

  it("сумма не выше порога и только мягкий сигнал → AUTO через Policy Gate", () => {
    const r = run(30000);
    expect(r?.decision.action).toBe("AUTO");
    expect(r?.verdict.verdict).toBe("ALLOW");
    expect(BUDGET_TOOL).toBe("budget.auto_approve");
    expect(run(18000)?.decision.action).toBe("AUTO"); // ровно порог
  });

  it("выше порога, сумма не извлечена или не MONEY → остаётся у руководителя", () => {
    expect(run(30000, { amount: 30001 })).toBeNull();
    expect(run(30000, { amount: null })).toBeNull();
    expect(run(30000, { amount: Number.NaN })).toBeNull();
    expect(run(30000, { category: "STATUS" })).toBeNull();
  });

  it("любой жёсткий сигнал запрещает авто, даже под порогом", () => {
    expect(run(30000, {}, ["MONEY_APPROVAL"])).toBeNull();
    expect(run(30000, {}, ["MONEY_TERMS", "FINANCE_PARTY"])).toBeNull();
    expect(run(30000, {}, ["HR_TERMS"])).toBeNull();
  });

  it("низкая уверенность → вопрос руководителю", () => {
    expect(run(30000, { confidence: 0.5 })).toBeNull();
    const lowConf = routeEmail({ category: "MONEY", confidence: 0.5, signals: ["MONEY_TERMS"] });
    expect(budgetAutoApproval({ leader: { budgetAutoLimit: 30000, protectedBlocks: [] }, risk, input, classification: { ...baseClass, confidence: 0.5 }, signals: ["MONEY_TERMS"], decision: lowConf })).toBeNull();
  });
});

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);
const calls = { n: 0 };
const provider: LlmProvider = {
  name: "fake",
  model: "m",
  async generate({ prompt }) {
    calls.n++;
    const subject = /Тема: (.*)/.exec(prompt)?.[1] ?? "";
    const money = subject.startsWith("Оплата");
    return {
      object: {
        category: money ? "MONEY" : "CLIENT_SUPPORT",
        confidence: 0.95,
        amount: money ? 18000 : null,
        client: null,
        deadline: null,
        isUrgent: false,
        summary: `суть: ${subject}`,
      },
      promptTokens: 1,
      completionTokens: 1,
    };
  },
};

describe.skipIf(!dbUp)("один и тот же батч у двух руководителей (Postgres)", () => {
  const ids: string[] = [];
  const stamp = Date.now();
  const seed = async (limit: number, tag: string) => {
    const r = await seedLeader(db, {
      leader: { name: `Тест Порогов ${tag} ${stamp}`, role: "Директор", email: `p13-${tag}-${stamp}@company.example` },
      members: org.members,
      areas: loadAreas(path.join(PROFILES_DIR, "leader2_areas.json")),
      profileMarkdown: "# профиль",
      draft: { ...draft, budgetAutoLimit: limit },
      meetings: [],
      tasks: [],
    });
    ids.push(r.leaderId);
    // seedLeader не снижает порог до 0 (null в профиле = «не менять»), поэтому выставляем явно.
    await db.leader.update({ where: { id: r.leaderId }, data: { budgetAutoLimit: limit } });
    return r.leaderId;
  };

  beforeAll(async () => {
    await clock.init();
  });
  afterAll(async () => {
    await db.leader.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });

  it("порог 30 000 ₽: письмо на 18 000 ₽ закрыто без руководителя, повтор не создаёт карточку", async () => {
    const leaderId = await seed(30000, "a");
    const llm = new LlmClient({ provider, cache: new MemoryCache() });
    const batch = loadInbox(PROFILES_DIR, "extra_inbox.csv").map((m) => ({ ...m, receivedAt: m.receivedAt }));
    const stats = await ingestEmails(db, llm, leaderId, batch);

    expect(stats.threads).toBe(2);
    expect(stats.repeats).toBe(1);
    expect(stats.byAction).toMatchObject({ AUTO: 1, DELEGATE: 1 });
    expect(stats.decisionsCreated).toBe(0);
    expect(await db.decision.count({ where: { leaderId } })).toBe(0);

    const log = await db.activityLog.findFirstOrThrow({ where: { leaderId, action: "AUTO_BUDGET" } });
    expect(log.savedMinutes).toBe(6);
    const gate = await db.activityLog.findFirstOrThrow({ where: { leaderId, pipeline: "GATE", action: "ALLOW:budget.auto_approve" } });
    expect(gate.reason).toBeTruthy();
    // Обращение клиента ушло исполнителю этого руководителя по зоне «поддержка».
    const task = await db.task.findFirstOrThrow({ where: { leaderId }, include: { assignee: true } });
    expect(task.assignee?.name).toBe("Руслан Исаев");
  });

  it("порог 0: то же письмо идёт руководителю карточкой, повтор привязывается", async () => {
    const leaderId = await seed(0, "b");
    const llm = new LlmClient({ provider, cache: new MemoryCache() });
    const stats = await ingestEmails(db, llm, leaderId, loadInbox(PROFILES_DIR, "extra_inbox.csv"));
    expect(stats.byAction).toMatchObject({ ASK_LEADER: 1 });
    const decisions = await db.decision.findMany({ where: { leaderId } });
    expect(decisions).toHaveLength(1);
    expect(decisions[0].reminderCount).toBe(1);
    expect(await db.activityLog.count({ where: { leaderId, action: "AUTO_BUDGET" } })).toBe(0);
  });
});
