import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmClient, MemoryCache, type LlmProvider } from "@/core/llm";
import type { LeaderEvent } from "@/core/events";
import { MemoryState, type Button, type Messenger } from "@/core/telegram/types";
import { seedTempLeader } from "./helpers/eval-env";

vi.stubEnv("APP_CLOCK_MODE", "real");
vi.stubEnv("TELEGRAM_BOT_USERNAME", "test_bot");
const { db } = await import("@/db/client");
const { clock } = await import("@/core/clock");
const { handleStart, leaderBindSecret } = await import("@/core/telegram/bindings");
const { handleCallback, handleText } = await import("@/core/telegram/handlers");
const { dispatchTask, dispatchPendingForEmployee, ASSIGN_TOOL } = await import("@/core/tasks/dispatch");
const { relayEvent } = await import("@/core/telegram/relay");
const { buildMorningDigest } = await import("@/core/telegram/morning");
const { resolveDecision } = await import("@/core/decisions");
const { ingestEmails } = await import("@/core/email-triage/ingest");

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);
const KEY = "test-bind-key";

interface Sent { chatId: string; text: string; buttons?: Button[][] }
function fakeMessenger() {
  const sent: Sent[] = [];
  const edits: Sent[] = [];
  let n = 0;
  const m: Messenger = {
    async send(chatId, text, buttons) {
      sent.push({ chatId, text, buttons });
      return { messageId: String(++n) };
    },
    async edit(chatId, _id, text, buttons) {
      edits.push({ chatId, text, buttons });
    },
  };
  return { m, sent, edits };
}

describe.skipIf(!dbUp)("поручения сотрудникам через Policy Gate", () => {
  let leaderId = "";
  let otherLeaderId = "";
  let slug = "";
  let leaderName = "";
  let olga: { id: string; inviteToken: string; name: string };
  let other: { id: string; inviteToken: string };
  const chat = (s: string) => `${s}-${leaderId.slice(-6)}`;

  const setPermission = (perm: "AUTO" | "APPROVE" | "DENY" | null) =>
    db.connector.updateMany({
      where: { leaderId, type: "BUILTIN_TELEGRAM" },
      data: { toolPermissions: perm ? { [ASSIGN_TOOL]: perm } : {} },
    });

  const newTask = (over: Record<string, unknown> = {}) =>
    db.task.create({
      data: {
        leaderId,
        assigneeId: olga.id,
        title: "Подготовить КП",
        description: "d",
        acceptanceCriteria: "КП отправлено клиенту",
        sourceType: "CHAT",
        dueAt: new Date("2026-12-10T15:00:00Z"),
        ...over,
      },
    });

  const bindEmployee = (c: string, token = olga.inviteToken) => handleStart(db, c, token, KEY);
  const bindLeader = (c: string) => handleStart(db, c, `${slug}_${leaderBindSecret(slug, KEY)}`, KEY);

  beforeAll(async () => {
    await clock.init();
    leaderId = await seedTempLeader(db, "disp");
    otherLeaderId = await seedTempLeader(db, "disp-other");
    const leader = await db.leader.findUniqueOrThrow({ where: { id: leaderId } });
    slug = leader.slug;
    leaderName = leader.name;
    olga = await db.employee.findFirstOrThrow({ where: { leaderId, name: "Ольга Смирнова" } });
    other = await db.employee.findFirstOrThrow({ where: { leaderId: otherLeaderId, name: "Ольга Смирнова" } });
  }, 60_000);

  afterAll(async () => {
    await db.leader.deleteMany({ where: { id: { in: [leaderId, otherLeaderId].filter(Boolean) } } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    await db.telegramBinding.deleteMany({ where: { leaderId: { in: [leaderId, otherLeaderId] } } });
    await db.task.deleteMany({ where: { leaderId, sourceType: { not: "DATASET" } } });
    await db.decision.deleteMany({ where: { leaderId } });
    await db.activityLog.deleteMany({ where: { leaderId } });
    await setPermission("AUTO");
  });

  it("профиль с правилом «передавать ответственному» создаёт коннектор Telegram с AUTO", async () => {
    const c = await db.connector.findFirstOrThrow({ where: { leaderId, type: "BUILTIN_TELEGRAM" } });
    expect(c.toolPermissions).toMatchObject({ [ASSIGN_TOOL]: "AUTO" });
    expect(c.encryptedConfig).toBe(""); // секретов в БД нет
  });

  describe("вердикты шлюза", () => {
    it("ALLOW: поручение уходит сразу, представляется ИИ-помощником, с тремя кнопками; повтор — пропуск", async () => {
      await bindEmployee(chat("E"));
      const { m, sent } = fakeMessenger();
      const t = await newTask();

      expect(await dispatchTask({ db, messenger: m }, leaderId, t.id)).toEqual({ status: "sent", chats: 1 });
      expect(sent).toHaveLength(1);
      expect(sent[0].chatId).toBe(chat("E"));
      expect(sent[0].text).toContain(`ИИ-помощник ${leaderName}`);
      expect(sent[0].text).toContain("Новая задача: <b>Подготовить КП</b>");
      expect(sent[0].text).toContain("Критерий готовности: КП отправлено клиенту");
      expect(sent[0].buttons?.flat().map((b) => b.data)).toEqual([`t:a:${t.id}`, `t:c:${t.id}`, `t:r:${t.id}`]);

      const row = await db.task.findUniqueOrThrow({ where: { id: t.id } });
      expect(row.notifiedAt).not.toBeNull();
      expect(row.telegramMessageId).toBe(`${chat("E")}:1`);
      expect(await dispatchTask({ db, messenger: m }, leaderId, t.id)).toMatchObject({ status: "skipped" });
      expect(sent).toHaveLength(1);

      const gate = await db.activityLog.findFirstOrThrow({ where: { leaderId, pipeline: "GATE" } });
      expect(gate.action).toBe(`ALLOW:${ASSIGN_TOOL}`);
    });

    it("APPROVE (права по умолчанию): карточка руководителю один раз, сообщение сотруднику не уходит", async () => {
      await setPermission(null); // нет записи → APPROVE
      await bindEmployee(chat("E"));
      const { m, sent } = fakeMessenger();
      const t = await newTask();

      const first = await dispatchTask({ db, messenger: m }, leaderId, t.id);
      expect(first.status).toBe("awaiting_approval");
      const second = await dispatchTask({ db, messenger: m }, leaderId, t.id);
      expect(second).toEqual(first);
      expect(sent).toHaveLength(0);

      const cards = await db.decision.findMany({ where: { leaderId, type: "TOOL_CALL" } });
      expect(cards).toHaveLength(1);
      expect(cards[0].proposedPayload).toMatchObject({ tool: ASSIGN_TOOL, args: { taskId: t.id } });
      expect((await db.task.findUniqueOrThrow({ where: { id: t.id } })).notifiedAt).toBeNull();
    });

    it("после «Утвердить» поручение уходит; повторное событие второго сообщения не создаёт", async () => {
      await setPermission("APPROVE");
      await bindEmployee(chat("E"));
      const { m, sent } = fakeMessenger();
      const t = await newTask();
      const r = await dispatchTask({ db, messenger: m }, leaderId, t.id);
      if (r.status !== "awaiting_approval") throw new Error("expected approval");

      expect(await resolveDecision(db, leaderId, r.decisionId, { action: "APPROVE" })).toMatchObject({ ok: true });
      const ev: LeaderEvent = { type: "decision.updated", data: { id: r.decisionId } };
      expect(await relayEvent({ db, messenger: m }, leaderId, ev)).toContain("sent");
      expect(sent.filter((s) => s.chatId === chat("E"))).toHaveLength(1);
      expect(await relayEvent({ db, messenger: m }, leaderId, ev)).toContain("skipped");
      expect(sent.filter((s) => s.chatId === chat("E"))).toHaveLength(1);
    });

    it("отклонённая карточка поручение не отправляет", async () => {
      await setPermission("APPROVE");
      await bindEmployee(chat("E"));
      const { m, sent } = fakeMessenger();
      const t = await newTask();
      const r = await dispatchTask({ db, messenger: m }, leaderId, t.id);
      if (r.status !== "awaiting_approval") throw new Error("expected approval");
      await resolveDecision(db, leaderId, r.decisionId, { action: "REJECTED" });
      await relayEvent({ db, messenger: m }, leaderId, { type: "decision.updated", data: { id: r.decisionId } });
      expect(sent).toHaveLength(0);
      expect((await db.task.findUniqueOrThrow({ where: { id: t.id } })).notifiedAt).toBeNull();
    });

    it("DENY: ничего не уходит, в журнале GATE причина; запрет сильнее одобрения руководителя", async () => {
      await bindEmployee(chat("E"));
      const { m, sent } = fakeMessenger();
      await setPermission("DENY");
      const t = await newTask();
      expect(await dispatchTask({ db, messenger: m }, leaderId, t.id)).toEqual({ status: "denied" });
      expect(await dispatchTask({ db, messenger: m }, leaderId, t.id, { approved: true })).toEqual({ status: "denied" });
      expect(sent).toHaveLength(0);
      const logs = await db.activityLog.findMany({ where: { leaderId, pipeline: "GATE" } });
      expect(logs.every((l) => l.action === `DENY:${ASSIGN_TOOL}`)).toBe(true);
      expect(logs[0].reason).toContain("запрещён");
    });

    it("обязательство клиенту всегда на подтверждении, даже при AUTO", async () => {
      await bindEmployee(chat("E"));
      const { m, sent } = fakeMessenger();
      const t = await newTask({ isClientCommitment: true });
      expect((await dispatchTask({ db, messenger: m }, leaderId, t.id)).status).toBe("awaiting_approval");
      expect(sent).toHaveLength(0);
      const gate = await db.activityLog.findFirstOrThrow({ where: { leaderId, pipeline: "GATE" } });
      expect(gate.reason).toContain("CLIENT_COMMITMENT");
    });

    it("задачи без исполнителя, чужие и уже принятые не отправляются", async () => {
      const { m } = fakeMessenger();
      const noAssignee = await newTask({ assigneeId: null });
      expect(await dispatchTask({ db, messenger: m }, leaderId, noAssignee.id)).toMatchObject({ status: "skipped" });
      const accepted = await newTask({ status: "ACCEPTED" });
      expect(await dispatchTask({ db, messenger: m }, leaderId, accepted.id)).toMatchObject({ status: "skipped" });
      const t = await newTask();
      expect(await dispatchTask({ db, messenger: m }, otherLeaderId, t.id)).toMatchObject({ status: "skipped" }); // чужой leaderId
    });
  });

  describe("сотрудник ещё не подключил бота", () => {
    it("поручение ждёт, утренний план даёт ссылку-приглашение, после /start поручение уходит", async () => {
      const { m, sent } = fakeMessenger();
      const t = await newTask();
      expect(await dispatchTask({ db, messenger: m }, leaderId, t.id)).toEqual({ status: "awaiting_binding" });
      expect(sent).toHaveLength(0);
      expect((await db.task.findUniqueOrThrow({ where: { id: t.id } })).notifiedAt).toBeNull();
      expect(await db.activityLog.count({ where: { leaderId, action: "TASK_WAITING_BINDING" } })).toBe(1);

      const digest = await buildMorningDigest(db, leaderId);
      expect(digest).toContain("Ольга Смирнова");
      expect(digest).toContain(`t.me/test_bot?start=${olga.inviteToken}`);

      await bindEmployee(chat("E"));
      expect(await dispatchPendingForEmployee({ db, messenger: m }, leaderId, olga.id)).toBe(1);
      expect(sent).toHaveLength(1);
      expect(await dispatchPendingForEmployee({ db, messenger: m }, leaderId, olga.id)).toBe(0);
      expect(await buildMorningDigest(db, leaderId)).not.toContain("ждут, пока сотрудник");
    });

    it("приглашение другого руководителя не даёт доступа к нашим поручениям", async () => {
      await handleStart(db, chat("X"), other.inviteToken, KEY); // Ольга из другой команды
      const { m, sent } = fakeMessenger();
      const t = await newTask();
      expect(await dispatchTask({ db, messenger: m }, leaderId, t.id)).toEqual({ status: "awaiting_binding" });
      expect(sent).toHaveLength(0);
    });
  });

  describe("кнопки сотрудника", () => {
    async function setup() {
      await bindEmployee(chat("E"));
      await bindLeader(chat("L"));
      const { m, sent, edits } = fakeMessenger();
      const deps = { db, messenger: m, state: new MemoryState() };
      const t = await newTask();
      await dispatchTask({ db, messenger: m }, leaderId, t.id);
      sent.length = 0;
      return { deps, sent, edits, t };
    }
    const press = (deps: Awaited<ReturnType<typeof setup>>["deps"], chatId: string, data: string) =>
      handleCallback(deps, { chatId, messageId: "1", data });

    it("«Принял»: NEW → ACCEPTED, руководитель уведомлён, повтор — «Уже принято»", async () => {
      const { deps, sent, edits, t } = await setup();
      expect(await press(deps, chat("E"), `t:a:${t.id}`)).toBe("Принято");
      expect((await db.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("ACCEPTED");
      expect(edits.at(-1)?.text).toContain("Принято в работу");
      expect(edits.at(-1)?.buttons).toBeUndefined();
      expect(sent.find((s) => s.chatId === chat("L"))?.text).toContain("Ольга Смирнова принял задачу");
      expect(await press(deps, chat("E"), `t:a:${t.id}`)).toBe("Уже принято");
    });

    it("чужой чат, чат руководителя и чат сотрудника другой команды не могут трогать поручение", async () => {
      const { deps, t } = await setup();
      await handleStart(db, chat("X"), other.inviteToken, KEY);
      for (const c of [chat("X"), chat("L"), "stranger"]) {
        expect(await press(deps, c, `t:a:${t.id}`)).toBe("Нет доступа к этой задаче");
        expect(await press(deps, c, `t:c:${t.id}`)).toBe("Нет доступа к этой задаче");
        expect(await press(deps, c, `t:r:${t.id}`)).toBe("Нет доступа к этой задаче");
      }
      expect((await db.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("NEW");
    });

    it("«Уточнить»: вопрос уходит руководителю с экранированием; /cancel отменяет", async () => {
      const { deps, sent, t } = await setup();
      expect(await press(deps, chat("E"), `t:c:${t.id}`)).toBe("Жду ваш вопрос");
      expect(await handleText(deps, chat("E"), "/cancel")).toContain("Отменила");
      expect(await handleText(deps, chat("E"), "вопрос")).not.toContain("Передала");

      await press(deps, chat("E"), `t:c:${t.id}`);
      expect(await handleText(deps, chat("E"), "Какой <срок> реален?")).toContain("Передала");
      const msg = sent.find((s) => s.chatId === chat("L"));
      expect(msg?.text).toContain("Вопрос от Ольга Смирнова");
      expect(msg?.text).toContain("Какой &lt;срок&gt; реален?");
      expect((await db.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("NEW");
    });

    it("«Не успею»: руководителю уходит уведомление, статус и срок не меняются", async () => {
      const { deps, sent, t } = await setup();
      const before = await db.task.findUniqueOrThrow({ where: { id: t.id } });
      expect(await press(deps, chat("E"), `t:r:${t.id}`)).toBe("Сообщила руководителю");
      expect(sent.find((s) => s.chatId === chat("L"))?.text).toContain("не успеет");
      const after = await db.task.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.status).toBe(before.status);
      expect(after.dueAt.getTime()).toBe(before.dueAt.getTime());
    });
  });

  describe("из письма: событие после создания EmailItem", () => {
    it("ingest создаёт задачу, связывает с письмом и воркер сразу отправляет её исполнителю", async () => {
      await bindEmployee(chat("E"));
      const { m, sent } = fakeMessenger();
      const provider: LlmProvider = {
        name: "fake",
        model: "m",
        async generate() {
          return { object: { category: "SALES", confidence: 0.95, amount: null, client: null, deadline: null, isUrgent: false, summary: "Нужно КП" }, promptTokens: 0, completionTokens: 0 };
        },
      };
      const handled: string[] = [];
      const pending: Promise<unknown>[] = [];
      const stats = await ingestEmails(
        db,
        new LlmClient({ provider, cache: new MemoryCache() }),
        leaderId,
        [{ externalId: "disp-m1", senderName: "Покупатель", senderEmail: "buyer@client.example", subject: "Запрос КП для проверки", body: "Просим КП на лицензии", receivedAt: new Date("2026-12-07T09:00:00+03:00") }],
        {
          emit: async (e) => {
            // как воркер: сразу по событию. К этому моменту письмо должно быть связано с задачей.
            if (e.type === "task.updated" && e.data.created === true) {
              pending.push(relayEvent({ db, messenger: m }, leaderId, e).then((r) => void handled.push(r ?? "")));
            }
          },
        },
      );
      await Promise.all(pending);

      expect(stats.tasksCreated).toBe(1);
      const task = await db.task.findFirstOrThrow({ where: { leaderId, sourceType: "EMAIL" } });
      expect(task.sourceRefId).toBe("disp-m1");
      expect(task.notifiedAt).not.toBeNull();
      expect(handled[0]).toContain("sent");
      expect(sent.filter((s) => s.chatId === chat("E"))).toHaveLength(1);
      // шлюз видел категорию исходного письма
      expect((await db.emailItem.findFirstOrThrow({ where: { leaderId, taskId: task.id } })).category).toBe("SALES");
    });
  });
});
