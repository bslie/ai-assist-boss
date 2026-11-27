import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { describeTools, runAgent } from "@/core/agent/loop";
import type { ReadTool, Tool, ToolCtx, WriteTool } from "@/core/agent/types";
import { seedTempLeader } from "./helpers/eval-env";
import { scriptedLlm } from "./helpers/scripted-llm";

vi.stubEnv("APP_CLOCK_MODE", "real");
const { db } = await import("@/db/client");
const { clock } = await import("@/core/clock");
const { handleChat, TOOLS } = await import("@/core/chat");

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);

const EchoArgs = z.object({ word: z.string().min(1) });
const echo: ReadTool<typeof EchoArgs> = { kind: "read", name: "test.echo", description: "Возвращает слово.", args: EchoArgs, run: async (_c, a) => ({ said: a.word }) };
const boom: ReadTool = { kind: "read", name: "test.boom", description: "Падает.", args: z.object({}), run: async () => { throw new Error("сломалось"); } };
const doIt: WriteTool = { kind: "write", name: "test.do", description: "Действие.", args: z.object({}), propose: async () => ({ text: "ok" }) };
const fakeCtx = { db: null as never, llm: null as never, leaderId: "l", text: "вопрос" } satisfies ToolCtx;

const run = (steps: Parameters<typeof scriptedLlm>[0], tools: Tool[] = [echo, boom, doIt], maxSteps?: number) => {
  const f = scriptedLlm(steps);
  return { f, p: runAgent(f.llm, { ctx: fakeCtx, system: "КОНТЕКСТ", dialog: "", tools, maxSteps }) };
};

describe("цикл агента", () => {
  it("выполняет инструмент чтения и отдаёт результат модели на следующем шаге", async () => {
    const { f, p } = run([{ call: { tool: "test.echo", args: { word: "привет" } } }, { answer: "Готово" }]);
    const out = await p;
    expect(out.answer).toBe("Готово");
    expect(out.calls).toEqual([{ tool: "test.echo", args: { word: "привет" } }]);
    expect(f.calls[1].prompt).toContain('"said":"привет"');
  });

  it("ошибки инструментов и модели — наблюдения, а не падение: нет инструмента, не JSON, не те аргументы, исключение, действие в call", async () => {
    const { f, p } = run(
      [
        { call: { tool: "nope.none" } },
        { call: { tool: "test.echo", args: {} } },
        { call: { tool: "test.boom" } },
        { call: { tool: "test.do" } },
        { answer: "Разобралась" },
      ],
      undefined,
      6,
    );
    expect((await p).answer).toBe("Разобралась");
    const last = f.calls.at(-1)!.prompt;
    expect(last).toContain("такого инструмента нет");
    expect(last).toContain("ошибка аргументов");
    expect(last).toContain("ошибка выполнения: сломалось");
    expect(last).toContain("это действие, его указывают в actions");
  });

  it("повтор того же вызова не выполняется второй раз", async () => {
    const same = { call: { tool: "test.echo", args: { word: "a" } } };
    const { f, p } = run([same, same, { answer: "ок" }]);
    const out = await p;
    expect(out.calls).toHaveLength(1);
    expect(f.calls[2].prompt).toContain("этот вызов уже был");
  });

  it("лимит шагов: на последнем шаге вызов игнорируется и берётся ответ, цикл не бесконечен", async () => {
    const { f, p } = run([{ call: { tool: "test.echo", args: { word: "x" } }, answer: "хватит" }], undefined, 2);
    const out = await p;
    expect(f.agentCalls()).toBe(2);
    expect(out.answer).toBe("хватит");
    expect(f.calls[1].prompt).toContain("Больше инструменты вызывать нельзя");
  });

  it("действия отдаются как предложения и сами не выполняются", async () => {
    const { p } = run([{ actions: [{ tool: "test.do", args: {} }] }]);
    expect((await p).actions).toEqual([{ tool: "test.do", argsJson: "{}" }]);
  });

  it("описание инструментов для модели содержит имя, вид и схему аргументов", () => {
    const d = describeTools([echo, doIt]);
    expect(d).toMatch(/- test\.echo: Возвращает слово\. Аргументы: \{.*"word"/);
    expect(d.indexOf("test.echo")).toBeLessThan(d.indexOf("test.do"));
  });
});

describe("реестр инструментов чата", () => {
  it("имена уникальны и точечные, у каждого есть описание и схема, которую можно отдать модели", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOLS) {
      expect(t.name, t.name).toMatch(/^[a-z]+\.[a-z_]+$/);
      expect(t.description.length, t.name).toBeGreaterThan(20);
      expect(() => z.toJSONSchema(t.args), t.name).not.toThrow();
    }
    expect(names).toEqual(expect.arrayContaining(["mail.search", "mail.check_now", "meetings.list", "tasks.list", "meeting.join", "rule.create"]));
  });
});

describe.skipIf(!dbUp)("инструменты чтения (Postgres)", () => {
  let a = "";
  let b = "";
  beforeAll(async () => {
    await clock.init();
    a = await seedTempLeader(db, "agent-a");
    b = await seedTempLeader(db, "agent-b");
    await db.emailItem.deleteMany({ where: { leaderId: { in: [a, b] } } });
    const at = clock.now();
    const mk = (leaderId: string, ext: string, subject: string, name: string, action: "ASK_LEADER" | "DIGEST") =>
      db.emailItem.create({ data: { leaderId, externalId: ext, threadKey: ext, senderName: name, senderEmail: `${ext}@example.com`, subject, body: `Текст ${subject}`, receivedAt: new Date(at.getTime() - 3_600_000), action } });
    await mk(a, "a1", "Договор на подпись", "Иван Петров", "ASK_LEADER");
    await mk(a, "a2", "Отчёт за неделю", "Мария", "DIGEST");
    await mk(b, "b1", "Договор чужой", "Чужой", "ASK_LEADER");
  });
  afterAll(async () => {
    await db.leader.deleteMany({ where: { id: { in: [a, b] } } });
  });

  const tool = (name: string) => TOOLS.find((t) => t.name === name) as ReadTool;
  const ctx = (leaderId: string): ToolCtx => ({ db, llm: null as never, leaderId, text: "" });

  it("mail.search ищет только у своего руководителя и сочетает фильтры", async () => {
    const t = tool("mail.search");
    const mine = (await t.run(ctx(a), t.args.parse({ query: "договор" }))) as { found: number; emails: { subject: string }[] };
    expect(mine.emails.map((e) => e.subject)).toEqual(["Договор на подпись"]);
    const both = (await t.run(ctx(a), t.args.parse({ sender: "иван", query: "договор", action: "ASK_LEADER" }))) as { found: number };
    expect(both.found).toBe(1);
    const none = (await t.run(ctx(a), t.args.parse({ sender: "мария", action: "ASK_LEADER" }))) as { found: number };
    expect(none.found).toBe(0);
    expect(((await t.run(ctx(b), t.args.parse({ query: "договор" }))) as { emails: { subject: string }[] }).emails[0].subject).toBe("Договор чужой");
  });

  it("агент через чат: вызывает mail.search и отвечает по найденному", async () => {
    const f = scriptedLlm([{ call: { tool: "mail.search", args: { sender: "Иван" } } }, { answer: "От Ивана пришёл договор на подпись." }]);
    const r = await handleChat(db, f.llm, a, "Что пришло от Ивана?");
    expect(r.text).toBe("От Ивана пришёл договор на подпись.");
    expect(f.calls[1].prompt).toContain("Договор на подпись");
    expect(f.calls[1].prompt).not.toContain("Договор чужой");
  });

  it("незнакомое действие от модели — понятный отказ, а не падение", async () => {
    const f = scriptedLlm([{ actions: [{ tool: "money.transfer", args: { sum: 1 } }] }]);
    const r = await handleChat(db, f.llm, a, "переведи деньги");
    expect(r.text).toContain("Не поняла");
    expect(r.actions).toBeUndefined();
  });

  it("действие с негодными аргументами не выполняется и просит уточнить", async () => {
    const f = scriptedLlm([{ actions: [{ tool: "task.create", args: { assignee: "Смирнова" } }] }]);
    const r = await handleChat(db, f.llm, a, "поставь задачу");
    expect(r.text).toContain("Не хватает данных");
  });
});
