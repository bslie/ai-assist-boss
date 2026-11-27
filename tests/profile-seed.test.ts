import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DATASET_DIR, loadInbox, loadOrg, loadProfileMarkdown, loadTasks } from "@/core/dataset";
import { loadCalendar } from "@/core/dataset/ics";
import { routeEmail } from "@/core/email-triage/classify";
import { ProfileDraftSchema, sanitizeDraft } from "@/core/profile";
import { db } from "@/db/client";
import { seedLeader, slugify } from "@/db/seed-leader";

const draft = ProfileDraftSchema.parse(
  JSON.parse(readFileSync(path.join(DATASET_DIR, "leader_profile.draft.json"), "utf8")),
);

describe("датасет", () => {
  it("календарь: 50 встреч, задачи: 12, оргструктура: 11 человек вокруг руководителя", () => {
    expect(loadCalendar()).toHaveLength(50);
    expect(loadTasks()).toHaveLength(12);
    const org = loadOrg();
    expect(org.members).toHaveLength(11);
    expect(org.members.filter((m) => m.relationType === "MANAGER")).toHaveLength(1);
    expect(loadInbox()).toHaveLength(80);
  });

  it("slugify", () => {
    expect(slugify("Иван Петров")).toBe("ivan-petrov");
  });
});

describe("профиль", () => {
  it("черновик из файла валиден", () => {
    expect(sanitizeDraft(draft).warnings).toEqual([]);
  });

  it("правило «можно авто» для защищённой категории отбрасывается", () => {
    const bad = {
      ...draft,
      allowed: [
        ...draft.allowed,
        { name: "Кадры сама", description: "x", category: "HR" as const, action: "AUTO" as const, delegateToArea: null },
        { name: "Деньги сама", description: "x", category: "MONEY" as const, action: "AUTO" as const, delegateToArea: null },
      ],
    };
    const { draft: safe, warnings } = sanitizeDraft(bad);
    expect(warnings.map((w) => w.rule)).toEqual(["Кадры сама", "Деньги сама"]);
    expect(safe.allowed.some((r) => r.category === "HR" || r.category === "MONEY")).toBe(false);
  });

  it("маршрутизатор игнорирует правило AUTO для MONEY", () => {
    const r = routeEmail({ category: "MONEY", confidence: 0.99, signals: [], rules: [{ category: "MONEY", action: "AUTO" }] });
    expect(r.action).toBe("ASK_LEADER");
  });
});

describe("seedLeader (Postgres)", () => {
  const name = `Тест Сидов ${Date.now()}`;
  const ids: string[] = [];
  afterAll(async () => {
    await db.leader.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });

  it("создаёт руководителя с профилем и идемпотентен", async () => {
    const org = loadOrg();
    const input = {
      leader: { name, role: org.leader.position, email: `seed-${Date.now()}@company.example` },
      members: org.members,
      areas: JSON.parse(readFileSync(path.join(DATASET_DIR, "responsibility_areas.json"), "utf8")) as Record<string, string>,
      profileMarkdown: loadProfileMarkdown(),
      draft,
      meetings: loadCalendar(),
      tasks: loadTasks(),
    };
    const first = await seedLeader(db, input);
    ids.push(first.leaderId);
    const second = await seedLeader(db, input);
    expect(second.leaderId).toBe(first.leaderId);

    const id = first.leaderId;
    const leader = await db.leader.findUniqueOrThrow({ where: { id } });
    expect(leader.profileVersion).toBe(3); // 1 по умолчанию + по одному импорту на каждый из двух запусков
    expect(leader.quarterGoals).toHaveLength(3);
    expect(await db.employee.count({ where: { leaderId: id } })).toBe(11);
    expect(await db.meeting.count({ where: { leaderId: id } })).toBe(50);
    expect(await db.task.count({ where: { leaderId: id } })).toBe(12);
    expect(await db.routine.count({ where: { leaderId: id } })).toBe(3); // утренний план, итог недели и контроль сроков

    const locked = await db.rule.findMany({ where: { leaderId: id, isSystemLocked: true } });
    expect(locked.map((r) => (r.condition as { category: string }).category).sort()).toEqual(
      ["CLIENT_COMMITMENT", "HR", "MANAGEMENT", "MONEY"],
    );
    expect(locked.every((r) => r.action === "ASK_LEADER")).toBe(true);
    expect(await db.rule.count({ where: { leaderId: id, source: "PROFILE_IMPORT" } })).toBe(11);
    // Задачи руководителя без исполнителя; остальные привязаны.
    expect(await db.task.count({ where: { leaderId: id, assigneeId: null } })).toBe(2);
  });
});
