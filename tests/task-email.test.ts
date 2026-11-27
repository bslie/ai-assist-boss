import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailConnector, OutgoingReply } from "@/core/mail/types";
import type { Messenger } from "@/core/telegram/types";
import { seedTempLeader } from "./helpers/eval-env";

vi.stubEnv("APP_CLOCK_MODE", "real");
vi.stubEnv("CONNECTOR_SECRET", "test-secret-test-secret-1234");
vi.stubEnv("APP_URL", "https://boss.example.test/");
vi.stubEnv("TELEGRAM_BOT_USERNAME", "test_bot");
const { db } = await import("@/db/client");
const { clock } = await import("@/core/clock");
const { dispatchTask, ASSIGN_TOOL } = await import("@/core/tasks/dispatch");
const { taskLinkToken, verifyTaskLink, answerTaskByLink, viewTaskByLink, TaskLinkAnswerSchema } = await import("@/core/tasks/email-link");
const { relayEvent } = await import("@/core/telegram/relay");

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);

const noTelegram: Messenger = {
  send: async () => {
    throw new Error("Telegram не должен вызываться");
  },
  edit: async () => {},
};

function fakeMail(fail = false) {
  const sent: OutgoingReply[] = [];
  const mail: MailConnector = {
    verify: async () => {},
    listNew: async () => ({ emails: [], cursor: "" }),
    archive: async () => {},
    async send(r) {
      if (fail) throw new Error("SMTP недоступен");
      sent.push(r);
    },
  };
  return { mail, sent };
}

describe("ссылка на поручение", () => {
  it("токен подписан: подмена и чужой ключ не проходят", () => {
    const t = taskLinkToken("task-1")!;
    expect(verifyTaskLink(t)).toBe("task-1");
    expect(verifyTaskLink(t.slice(0, -2) + "xx")).toBeNull();
    expect(verifyTaskLink(Buffer.from("task1:task-1.0000").toString("base64url"))).toBeNull();
    vi.stubEnv("CONNECTOR_SECRET", "another-secret-another-secret");
    expect(verifyTaskLink(t)).toBeNull();
    vi.stubEnv("CONNECTOR_SECRET", "");
    expect(taskLinkToken("task-1")).toBeNull(); // без секрета ссылок нет — fail closed
    vi.stubEnv("CONNECTOR_SECRET", "test-secret-test-secret-1234");
  });
});

describe.skipIf(!dbUp)("поручение письмом и ответ по ссылке (Postgres)", () => {
  let leaderId = "";
  let olga: { id: string; email: string; name: string };
  let connectorId = "";

  const newTask = (over: Record<string, unknown> = {}) =>
    db.task.create({
      data: {
        leaderId,
        assigneeId: olga.id,
        title: "Подготовить КП",
        description: "d",
        acceptanceCriteria: "КП отправлено клиенту",
        sourceType: "CHAT",
        dueAt: new Date(clock.now().getTime() + 5 * 86_400_000),
        ...over,
      },
    });

  beforeAll(async () => {
    await clock.init();
    leaderId = await seedTempLeader(db, "task-mail");
    await db.leader.update({ where: { id: leaderId }, data: { learningMode: false } });
    await db.connector.updateMany({ where: { leaderId, type: "BUILTIN_TELEGRAM" }, data: { toolPermissions: { [ASSIGN_TOOL]: "AUTO" } } });
    olga = await db.employee.findFirstOrThrow({ where: { leaderId, name: "Ольга Смирнова" } });
    connectorId = (await db.connector.create({ data: { leaderId, name: "Почта", type: "BUILTIN_IMAP", encryptedConfig: "", toolPermissions: { "mail.send_reply": "APPROVE" } } })).id;
  }, 60_000);

  afterAll(async () => {
    await db.leader.deleteMany({ where: { id: leaderId } });
  });

  beforeEach(async () => {
    await db.task.deleteMany({ where: { leaderId, sourceType: { not: "DATASET" } } });
    await db.decision.deleteMany({ where: { leaderId } });
    await db.connector.update({ where: { id: connectorId }, data: { isActive: true, toolPermissions: { "mail.send_reply": "APPROVE" } } });
  });

  it("без Telegram поручение уходит письмом: представление, срок, критерий, ссылка; повтор не дублирует", async () => {
    const { mail, sent } = fakeMail();
    const t = await newTask();
    const r = await dispatchTask({ db, messenger: noTelegram, mail: () => mail }, leaderId, t.id);
    expect(r).toEqual({ status: "emailed", to: olga.email });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(olga.email);
    expect(sent[0].subject).toBe("Поручение: Подготовить КП");
    expect(sent[0].text.split("\n")[0]).toMatch(/^Здравствуйте, я ИИ-помощник /);
    expect(sent[0].text).toContain("Критерий готовности: КП отправлено клиенту");
    expect(sent[0].text).toMatch(/https:\/\/boss\.example\.test\/t\/[\w-]+/);
    expect(sent[0].text).toContain("https://t.me/test_bot?start=");
    expect((await db.task.findUniqueOrThrow({ where: { id: t.id } })).notifiedAt).not.toBeNull();
    expect(await db.activityLog.count({ where: { leaderId, action: "TASK_SENT_EMAIL" } })).toBeGreaterThan(0);

    expect((await dispatchTask({ db, messenger: noTelegram, mail: () => mail }, leaderId, t.id)).status).toBe("skipped");
    expect(sent).toHaveLength(1);
  });

  it("запрет отправки в правах почты, выключенная почта или сбой SMTP → поручение ждёт, как раньше", async () => {
    const { mail, sent } = fakeMail();
    await db.connector.update({ where: { id: connectorId }, data: { toolPermissions: { "mail.send_reply": "DENY" } } });
    const t = await newTask();
    expect((await dispatchTask({ db, messenger: noTelegram, mail: () => mail }, leaderId, t.id)).status).toBe("awaiting_binding");

    await db.connector.update({ where: { id: connectorId }, data: { isActive: false, toolPermissions: {} } });
    expect((await dispatchTask({ db, messenger: noTelegram, mail: () => mail }, leaderId, t.id)).status).toBe("awaiting_binding");
    expect(sent).toHaveLength(0);

    await db.connector.update({ where: { id: connectorId }, data: { isActive: true } });
    const broken = fakeMail(true);
    expect((await dispatchTask({ db, messenger: noTelegram, mail: () => broken.mail }, leaderId, t.id)).status).toBe("awaiting_binding");
    expect((await db.task.findUniqueOrThrow({ where: { id: t.id } })).notifiedAt).toBeNull(); // можно повторить
  });

  it("ответы по ссылке: «Принял» как кнопка, вопрос руководителю, перенос по правилам", async () => {
    const t = await newTask();
    const token = taskLinkToken(t.id)!;
    expect(await viewTaskByLink(db, token)).toMatchObject({ title: "Подготовить КП", status: "NEW", assigneeName: olga.name });

    expect(await answerTaskByLink(db, token, { action: "accept" })).toMatchObject({ ok: true });
    expect((await db.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("ACCEPTED");
    expect(await answerTaskByLink(db, token, { action: "accept" })).toMatchObject({ ok: true, message: expect.stringContaining("уже принята") });

    await answerTaskByLink(db, token, { action: "clarify", question: "Какой формат КП?" });
    expect(await db.activityLog.findFirst({ where: { leaderId, action: "TASK_QUESTION" } })).toMatchObject({ reason: expect.stringContaining("Какой формат КП?") });

    // Перенос на 1 рабочий день у не клиентской задачи — сама; обязательство клиенту — карточка руководителю.
    const due = (await db.task.findUniqueOrThrow({ where: { id: t.id } })).dueAt;
    let next = new Date(due.getTime() + 86_400_000);
    while ([0, 6].includes(next.getUTCDay())) next = new Date(next.getTime() + 86_400_000);
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(next);
    expect(await answerTaskByLink(db, token, { action: "reschedule", date: day, reason: "жду данные" })).toMatchObject({ ok: true, message: expect.stringContaining("Перенесла") });

    const c = await newTask({ title: "Сроки для клиента", isClientCommitment: true });
    const res = await answerTaskByLink(db, taskLinkToken(c.id)!, { action: "reschedule", date: day, reason: "клиент молчит" });
    expect(res).toMatchObject({ ok: true, message: expect.stringContaining("Передала руководителю") });
    expect(await db.decision.count({ where: { leaderId, type: "TASK_RESCHEDULE", status: "PENDING" } })).toBe(1);
  });

  it("чужая или битая ссылка ничего не меняет; ввод проверяется схемой", async () => {
    expect(await answerTaskByLink(db, "garbage", { action: "accept" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await viewTaskByLink(db, taskLinkToken("no-such-task")!)).toBeNull();
    expect(TaskLinkAnswerSchema.safeParse({ action: "reschedule", date: "завтра", reason: "x" }).success).toBe(false);
    expect(TaskLinkAnswerSchema.safeParse({ action: "delete" }).success).toBe(false);
  });

  it("воркер пересылает руководителю уведомление из веба в его Telegram-чаты", async () => {
    const sent: string[] = [];
    const m: Messenger = { send: async (_c, text) => (sent.push(text), { messageId: "1" }), edit: async () => {} };
    await db.leader.update({ where: { id: leaderId }, data: { quietHoursStart: "00:00", quietHoursEnd: "00:00" } });
    await db.telegramBinding.create({ data: { chatId: `L-${leaderId.slice(-6)}`, role: "LEADER", leaderId } });
    await relayEvent({ db, messenger: m }, leaderId, { type: "leader.notify", data: { text: "Ольга <принял> задачу" } });
    expect(sent).toEqual(["Ольга &lt;принял&gt; задачу"]);
  });
});
