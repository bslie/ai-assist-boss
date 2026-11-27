import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LlmClient, MemoryCache, type LlmProvider } from "@/core/llm";
import { seedTempLeader } from "./helpers/eval-env";

vi.stubEnv("APP_CLOCK_MODE", "real");
const { db } = await import("@/db/client");
const { clock } = await import("@/core/clock");
const { createTask, listTasks, CreateTaskSchema } = await import("@/core/tasks/registry");
const { describeCron, patchRoutine, listRoutines, validCron, PatchRoutineSchema } = await import("@/core/routines");

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);

const provider: LlmProvider = {
  name: "fake",
  model: "m",
  async generate() {
    return { object: { criteria: "Отчёт за ноябрь выслан руководителю в виде таблицы." }, promptTokens: 1, completionTokens: 1 };
  },
};

describe("рутины: расписание", () => {
  it("cron проверяется планировщиковым парсером", () => {
    expect(validCron("30 8 * * 1-5")).toBe(true);
    expect(validCron("*/30 * * * *")).toBe(true);
    expect(validCron("99 99 * * *")).toBe(false);
    expect(PatchRoutineSchema.safeParse({ id: "x" }).success).toBe(false);
    expect(PatchRoutineSchema.safeParse({ id: "x", cronExpression: "раз в день" }).success).toBe(false);
  });
  it("describeCron читается человеком", () => {
    expect(describeCron("30 8 * * 1-5")).toBe("по будням в 08:30");
    expect(describeCron("0 17 * * 5")).toBe("по пятницам в 17:00");
    expect(describeCron("*/30 * * * *")).toBe("каждые 30 мин");
    expect(describeCron("0 9 1 * *")).toBe("0 9 1 * *");
  });
});

describe("создание поручения: валидация", () => {
  it("схема отклоняет короткое название и мусорную дату", () => {
    expect(CreateTaskSchema.safeParse({ title: "ab", assigneeId: "x", dueAt: "2026-12-10" }).success).toBe(false);
    expect(CreateTaskSchema.safeParse({ title: "Отчёт", assigneeId: "x", dueAt: "не дата" }).success).toBe(false);
    expect(CreateTaskSchema.safeParse({ title: "Отчёт", assigneeId: "x", dueAt: "2026-12-10" }).success).toBe(true);
  });
});

describe.skipIf(!dbUp)("реестр поручений и рутины (Postgres)", () => {
  let a = "";
  let b = "";
  let assigneeId = "";
  let otherEmployeeId = "";
  beforeAll(async () => {
    await clock.init();
    a = await seedTempLeader(db, "reg-a");
    b = await seedTempLeader(db, "reg-b");
    assigneeId = (await db.employee.findFirstOrThrow({ where: { leaderId: a, relationType: "SUBORDINATE" } })).id;
    otherEmployeeId = (await db.employee.findFirstOrThrow({ where: { leaderId: b, relationType: "SUBORDINATE" } })).id;
    await db.task.deleteMany({ where: { leaderId: a } });
  }, 60_000);
  afterAll(async () => {
    await db.leader.deleteMany({ where: { id: { in: [a, b].filter(Boolean) } } });
    await db.$disconnect();
  });

  const input = (over: object = {}) =>
    CreateTaskSchema.parse({ title: "Подготовить отчёт", description: "по продажам", assigneeId, dueAt: new Date(clock.now().getTime() + 86_400_000), ...over });

  it("исполнитель чужого руководителя и прошедший срок отклоняются", async () => {
    expect(await createTask(db, null, a, input({ assigneeId: otherEmployeeId }))).toMatchObject({ ok: false, code: "BAD_ASSIGNEE" });
    expect(await createTask(db, null, a, input({ dueAt: new Date(clock.now().getTime() - 1000) }))).toMatchObject({ ok: false, code: "PAST_DUE" });
    expect(await db.task.count({ where: { leaderId: a } })).toBe(0);
  });

  it("критерий: явный, из модели или по умолчанию", async () => {
    const llm = new LlmClient({ provider, cache: new MemoryCache() });
    const own = await createTask(db, llm, a, input({ acceptanceCriteria: "Файл во вложении" }));
    const gen = await createTask(db, llm, a, input({ title: "Свести данные" }));
    const none = await createTask(db, null, a, input({ title: "Позвонить клиенту" }));
    if (!own.ok || !gen.ok || !none.ok) throw new Error("создание не удалось");
    expect((await db.task.findUniqueOrThrow({ where: { id: own.id } })).acceptanceCriteria).toBe("Файл во вложении");
    expect((await db.task.findUniqueOrThrow({ where: { id: gen.id } })).acceptanceCriteria).toContain("таблицы");
    expect((await db.task.findUniqueOrThrow({ where: { id: none.id } })).acceptanceCriteria).toContain("Позвонить клиенту");
    const t = await db.task.findUniqueOrThrow({ where: { id: own.id } });
    expect(t).toMatchObject({ status: "NEW", sourceType: "CHAT", notifiedAt: null });
  });

  it("список: только свои, просроченные помечены, закрытые в конце", async () => {
    const past = await db.task.create({
      data: { leaderId: a, assigneeId, title: "Старая", description: "", acceptanceCriteria: "x", sourceType: "CHAT", dueAt: new Date(clock.now().getTime() - 86_400_000), status: "IN_PROGRESS" },
    });
    await db.task.create({ data: { leaderId: a, assigneeId, title: "Готовая", description: "", acceptanceCriteria: "x", sourceType: "CHAT", dueAt: new Date(clock.now().getTime() - 86_400_000), status: "DONE" } });
    const rows = await listTasks(db, a);
    expect(rows.find((r) => r.id === past.id)?.overdue).toBe(true);
    expect(rows.find((r) => r.title === "Готовая")?.overdue).toBe(false);
    expect(rows.at(-1)?.status).toBe("DONE");
    expect(await listTasks(db, b)).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: past.id })]));
  });

  it("рутины: свою можно выключить и перенастроить, чужую нельзя, кривой cron отклоняется", async () => {
    const mine = (await listRoutines(db, a))[0];
    const theirs = (await listRoutines(db, b))[0];
    expect(await patchRoutine(db, a, { id: mine.id, isActive: false })).toEqual({ ok: true });
    expect((await db.routine.findUniqueOrThrow({ where: { id: mine.id } })).isActive).toBe(false);
    expect(await patchRoutine(db, a, { id: mine.id, cronExpression: "0 10 * * 1-5" })).toEqual({ ok: true });
    expect(await patchRoutine(db, a, { id: mine.id, cronExpression: "99 99 * * *" })).toMatchObject({ ok: false, code: "BAD_CRON" });
    expect(await patchRoutine(db, a, { id: theirs.id, isActive: false })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect((await db.routine.findUniqueOrThrow({ where: { id: theirs.id } })).isActive).toBe(true);
  });
});
