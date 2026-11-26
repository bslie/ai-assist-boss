import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Button, Messenger } from "@/core/telegram/types";
import { MemoryState } from "@/core/telegram/types";
import { seedTempLeader } from "./helpers/eval-env";

vi.stubEnv("APP_CLOCK_MODE", "real");
const { db } = await import("@/db/client");
const { clock } = await import("@/core/clock");
const { handleStart, listRoles, switchRole, leaderBindSecret } = await import("@/core/telegram/bindings");
const { sendDecisionCard, refreshDecisionCard } = await import("@/core/telegram/cards");
const { handleCallback, handleText } = await import("@/core/telegram/handlers");
const { processRoutineJob, buildMorningDigest } = await import("@/core/telegram/morning");
const { dueRoutines, tick } = await import("@/core/scheduler");

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);
const KEY = "test-bind-key";

interface Sent { chatId: string; messageId: string; text: string; buttons?: Button[][] }
function fakeMessenger() {
  const sent: Sent[] = [];
  const edits: Sent[] = [];
  let n = 0;
  const m: Messenger = {
    async send(chatId, text, buttons) {
      const messageId = String(++n);
      sent.push({ chatId, messageId, text, buttons });
      return { messageId };
    },
    async edit(chatId, messageId, text, buttons) {
      edits.push({ chatId, messageId, text, buttons });
    },
  };
  return { m, sent, edits };
}

describe.skipIf(!dbUp)("Telegram (Postgres)", () => {
  let leaderId = "";
  let slug = "";
  let otherLeaderId = "";
  let otherSlug = "";
  const chat = (s: string) => `${s}-${leaderId.slice(-6)}`;

  const newDecision = (lid: string, title = "Тема") =>
    db.decision.create({
      data: { leaderId: lid, type: "EMAIL_REPLY", title, contextSummary: "Суть <b>письма</b>", gateReasons: ["Защищённая категория HR"], aiRecommendation: "Спросить", proposedPayload: {}, draftText: "Черновик" },
    });

  beforeAll(async () => {
    await clock.init();
    leaderId = await seedTempLeader(db, "tg");
    otherLeaderId = await seedTempLeader(db, "tg-other");
    slug = (await db.leader.findUniqueOrThrow({ where: { id: leaderId } })).slug;
    otherSlug = (await db.leader.findUniqueOrThrow({ where: { id: otherLeaderId } })).slug;
  }, 60_000);

  afterAll(async () => {
    await db.leader.deleteMany({ where: { id: { in: [leaderId, otherLeaderId].filter(Boolean) } } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    await db.telegramBinding.deleteMany({ where: { leaderId: { in: [leaderId, otherLeaderId] } } });
  });

  describe("привязки и роли", () => {
    it("руководитель: неверный секрет и неизвестный slug отклоняются, верный привязывает", async () => {
      const bad = await handleStart(db, chat("L"), `${slug}:wrong`, KEY);
      expect(bad.text).toContain("Не удалось");
      expect((await handleStart(db, chat("L"), `nope:${leaderBindSecret("nope", KEY)}`, KEY)).text).toContain("Не удалось");
      expect(await db.telegramBinding.count({ where: { chatId: chat("L") } })).toBe(0);

      const ok = await handleStart(db, chat("L"), `${slug}:${leaderBindSecret(slug, KEY)}`, KEY);
      expect(ok.text).toContain("ИИ-помощник");
      const b = await db.telegramBinding.findFirstOrThrow({ where: { chatId: chat("L") } });
      expect(b).toMatchObject({ role: "LEADER", leaderId, isActive: true });
    });

    it("формат ссылки t.me: slug_secret (Telegram не пропускает «:» в start)", async () => {
      expect(/^[A-Za-z0-9_-]+$/.test(`${slug}_${leaderBindSecret(slug, KEY)}`)).toBe(true);
      const ok = await handleStart(db, chat("L"), `${slug}_${leaderBindSecret(slug, KEY)}`, KEY);
      expect(ok.text).toContain("Чат привязан");
      expect(await db.telegramBinding.count({ where: { chatId: chat("L"), role: "LEADER", leaderId } })).toBe(1);
      // неверный секрет в том же формате
      const bad = await handleStart(db, chat("M"), `${slug}_${"0".repeat(24)}`, KEY);
      expect(bad.text).toContain("Не удалось");
    });

    it("без ключа привязка руководителя невозможна (fail closed)", async () => {
      const res = await handleStart(db, chat("L"), `${slug}:anything`, "");
      expect(res.text).toContain("Не удалось");
      expect(await db.telegramBinding.count({ where: { chatId: chat("L") } })).toBe(0);
    });

    it("секрет одного руководителя не подходит другому", async () => {
      const res = await handleStart(db, chat("L"), `${otherSlug}:${leaderBindSecret(slug, KEY)}`, KEY);
      expect(res.text).toContain("Не удалось");
    });

    it("сотрудник: приглашение привязывает, ответ представляется ИИ-помощником руководителя", async () => {
      const emp = await db.employee.findFirstOrThrow({ where: { leaderId } });
      const leader = await db.leader.findUniqueOrThrow({ where: { id: leaderId } });
      const res = await handleStart(db, chat("E"), emp.inviteToken, KEY);
      expect(res.text).toContain(`ИИ-помощник ${leader.name}`);
      expect(await db.telegramBinding.count({ where: { chatId: chat("E"), role: "EMPLOYEE", employeeId: emp.id } })).toBe(1);
      await handleStart(db, chat("E"), emp.inviteToken, KEY); // идемпотентно
      expect(await db.telegramBinding.count({ where: { chatId: chat("E") } })).toBe(1);
      expect((await handleStart(db, chat("E"), "bad-token", KEY)).text).toContain("Не удалось");
    });

    it("один чат — две роли: /role переключает, чужую привязку выбрать нельзя", async () => {
      const emp = await db.employee.findFirstOrThrow({ where: { leaderId } });
      await handleStart(db, chat("X"), `${slug}:${leaderBindSecret(slug, KEY)}`, KEY);
      await handleStart(db, chat("X"), emp.inviteToken, KEY);

      const roles = await listRoles(db, chat("X"));
      expect(roles.buttons).toHaveLength(2);
      const active = await db.telegramBinding.findMany({ where: { chatId: chat("X"), isActive: true } });
      expect(active).toHaveLength(1);
      expect(active[0].role).toBe("EMPLOYEE"); // последняя привязка стала активной

      const leaderBinding = await db.telegramBinding.findFirstOrThrow({ where: { chatId: chat("X"), role: "LEADER" } });
      await switchRole(db, chat("X"), leaderBinding.id);
      expect((await db.telegramBinding.findFirstOrThrow({ where: { chatId: chat("X"), isActive: true } })).role).toBe("LEADER");

      await handleStart(db, chat("Y"), `${otherSlug}:${leaderBindSecret(otherSlug, KEY)}`, KEY);
      const foreign = await db.telegramBinding.findFirstOrThrow({ where: { chatId: chat("Y") } });
      expect((await switchRole(db, chat("X"), foreign.id)).text).toContain("недоступна");
    });
  });

  describe("карточки и колбэки", () => {
    async function bindLeader(c: string, s = slug) {
      await handleStart(db, c, `${s}:${leaderBindSecret(s, KEY)}`, KEY);
    }

    it("карточка уходит руководителю один раз, с экранированием и кнопками", async () => {
      await bindLeader(chat("L"));
      const d = await newDecision(leaderId);
      const { m, sent } = fakeMessenger();
      expect(await sendDecisionCard(db, m, leaderId, d.id)).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0].text).toContain("Суть &lt;b&gt;письма&lt;/b&gt;");
      expect(sent[0].buttons?.flat().map((b) => b.data)).toEqual([`d:a:${d.id}`, `d:e:${d.id}`, `d:d:${d.id}`, `d:s:${d.id}`]);
      expect(sent[0].buttons!.flat().every((b) => Buffer.byteLength(b.data) <= 64)).toBe(true);
      expect(await sendDecisionCard(db, m, leaderId, d.id)).toBe(false); // идемпотентно
      expect(sent).toHaveLength(1);
    });

    it("чат не привязан → карточка остаётся в вебе", async () => {
      const d = await newDecision(leaderId);
      const { m, sent } = fakeMessenger();
      expect(await sendDecisionCard(db, m, leaderId, d.id)).toBe(false);
      expect(sent).toHaveLength(0);
    });

    it("повтор обновляет карточку: «Напоминание №N»", async () => {
      await bindLeader(chat("L"));
      const d = await newDecision(leaderId);
      const { m, edits } = fakeMessenger();
      await sendDecisionCard(db, m, leaderId, d.id);
      await db.decision.update({ where: { id: d.id }, data: { reminderCount: 2 } });
      expect(await refreshDecisionCard(db, m, leaderId, d.id)).toBe(true);
      expect(edits[0].text).toContain("Напоминание №2");
      expect(edits[0].buttons).toBeDefined();
    });

    it("«Утвердить» решает карточку, обновляет сообщение; повтор — «Уже решено»", async () => {
      await bindLeader(chat("L"));
      const d = await newDecision(leaderId);
      const { m, sent, edits } = fakeMessenger();
      await sendDecisionCard(db, m, leaderId, d.id);
      const deps = { db, messenger: m, state: new MemoryState() };

      const cb = { chatId: chat("L"), messageId: sent[0].messageId, data: `d:a:${d.id}` };
      expect(await handleCallback(deps, cb)).toBe("Готово");
      expect((await db.decision.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("APPROVED");
      expect(edits.at(-1)?.text).toContain("Утверждено");
      expect(edits.at(-1)?.buttons).toBeUndefined();
      expect(await handleCallback(deps, cb)).toBe("Уже решено");
    });

    it("изоляция: чат другого руководителя и непривязанный чат не могут трогать карточку", async () => {
      await bindLeader(chat("L"));
      await bindLeader(chat("Z"), otherSlug);
      const d = await newDecision(leaderId);
      const { m } = fakeMessenger();
      const deps = { db, messenger: m, state: new MemoryState() };
      expect(await handleCallback(deps, { chatId: chat("Z"), messageId: "1", data: `d:a:${d.id}` })).toBe("Нет доступа к этой карточке");
      expect(await handleCallback(deps, { chatId: "stranger", messageId: "1", data: `d:a:${d.id}` })).toBe("Нет доступа к этой карточке");
      expect(await handleCallback(deps, { chatId: chat("Z"), messageId: "1", data: `d:e:${d.id}` })).toBe("Нет доступа к этой карточке");
      expect((await db.decision.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("PENDING");
    });

    it("«Поправить»: ждёт текст, применяет правку; /cancel отменяет; чужой чат правку не применит", async () => {
      await bindLeader(chat("L"));
      const d = await newDecision(leaderId);
      const { m, sent } = fakeMessenger();
      const deps = { db, messenger: m, state: new MemoryState() };
      await sendDecisionCard(db, m, leaderId, d.id);

      expect(await handleCallback(deps, { chatId: chat("L"), messageId: "1", data: `d:e:${d.id}` })).toBe("Жду ваш текст");
      expect(sent.at(-1)?.text).toContain("Ответьте на карточку своим текстом");
      expect(sent.at(-1)?.text).toContain("<code>Черновик</code>"); // черновик можно скопировать и поправить
      expect(await handleText(deps, chat("L"), "/cancel")).toContain("Отменила");
      expect((await db.decision.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("PENDING");

      await handleCallback(deps, { chatId: chat("L"), messageId: "1", data: `d:e:${d.id}` });
      const reply = await handleText(deps, chat("L"), "Мой <вариант>");
      expect(reply).toContain("Мой &lt;вариант&gt;");
      const row = await db.decision.findUniqueOrThrow({ where: { id: d.id } });
      expect(row).toMatchObject({ status: "EDITED_APPROVED", editedText: "Мой <вариант>" });

      // состояние «жду текст» одноразовое: следующий текст — обычное сообщение
      expect(await handleText(deps, chat("L"), "ещё")).toContain("кнопками");
    });

    it("«Передать»: список своих сотрудников; чужого сотрудника выбрать нельзя", async () => {
      await bindLeader(chat("L"));
      const d = await newDecision(leaderId);
      const { m, sent, edits } = fakeMessenger();
      const deps = { db, messenger: m, state: new MemoryState() };
      await sendDecisionCard(db, m, leaderId, d.id);

      await handleCallback(deps, { chatId: chat("L"), messageId: sent[0].messageId, data: `d:d:${d.id}` });
      const subs = await db.employee.count({ where: { leaderId, relationType: "SUBORDINATE" } });
      expect(edits.at(-1)?.buttons).toHaveLength(subs + 1); // + «Назад»

      const foreign = await db.employee.findFirstOrThrow({ where: { leaderId: otherLeaderId } });
      expect(await handleCallback(deps, { chatId: chat("L"), messageId: "1", data: `d:t:${d.id}:${foreign.id}` })).toBe("Этот сотрудник недоступен");
      expect((await db.decision.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("PENDING");

      const own = await db.employee.findFirstOrThrow({ where: { leaderId, relationType: "SUBORDINATE" } });
      expect(await handleCallback(deps, { chatId: chat("L"), messageId: "1", data: `d:t:${d.id}:${own.id}` })).toBe("Готово");
      expect((await db.decision.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("DELEGATED");
    });

    it("текст от непривязанного чата — подсказка про приглашение", async () => {
      const { m } = fakeMessenger();
      expect(await handleText({ db, messenger: m, state: new MemoryState() }, "nobody", "привет")).toContain("ссылку-приглашение");
    });
  });

  describe("планировщик и утренний план", () => {
    const routine = (over: Record<string, unknown> = {}) =>
      ({ id: "r1", leaderId: "l", code: "MORNING_DIGEST", title: "t", cronExpression: "30 8 * * 1-5", promptInstruction: "", isActive: true, lastRunAt: null, ...over }) as Parameters<typeof dueRoutines>[0][number];

    it("cron в МСК: понедельник 08:30 срабатывает, повторно — нет, суббота — нет", () => {
      const mon0830 = new Date("2026-12-07T08:30:00+03:00");
      expect(dueRoutines([routine()], mon0830)).toHaveLength(1);
      expect(dueRoutines([routine({ lastRunAt: mon0830 })], mon0830)).toHaveLength(0);
      expect(dueRoutines([routine()], new Date("2026-12-07T08:29:59.500+03:00"))).toHaveLength(0);
      expect(dueRoutines([routine()], new Date("2026-12-07T08:30:00.400+03:00"))).toHaveLength(1);
      expect(dueRoutines([routine()], new Date("2026-12-12T08:30:00+03:00"))).toHaveLength(0);
    });

    it("перемотка часов вперёд: срабатывает один раз, даже если пропущено несколько дней", () => {
      const last = new Date("2026-12-07T08:30:00+03:00");
      const jumped = new Date("2026-12-11T09:00:00+03:00");
      const due = dueRoutines([routine({ lastRunAt: last })], jumped);
      expect(due).toHaveLength(1);
      expect(due[0].firedAt.toISOString()).toBe(new Date("2026-12-11T08:30:00+03:00").toISOString());
    });

    it("отмотка часов назад: lastRunAt «в будущем» не блокирует рутину", () => {
      const future = new Date("2026-12-20T08:30:00+03:00");
      expect(dueRoutines([routine({ lastRunAt: future })], new Date("2026-12-08T09:00:00+03:00"))).toHaveLength(1);
    });

    it("неактивная рутина и битый cron игнорируются", () => {
      const now = new Date("2026-12-07T08:30:00+03:00");
      expect(dueRoutines([routine({ isActive: false }), routine({ cronExpression: "не cron" })], now)).toHaveLength(0);
    });

    it("tick ставит задачу в очередь один раз и фиксирует lastRunAt", async () => {
      const r = await db.routine.create({ data: { leaderId, code: "CUSTOM", title: "каждую минуту", cronExpression: "* * * * *", promptInstruction: "x" } });
      const jobs: { routineId: string }[] = [];
      const queue = { enqueue: async (j: { routineId: string }) => void jobs.push(j) };
      await tick(db, queue as never);
      expect(jobs.filter((j) => j.routineId === r.id)).toHaveLength(1);
      expect((await db.routine.findUniqueOrThrow({ where: { id: r.id } })).lastRunAt).not.toBeNull();
      await tick(db, queue as never);
      expect(jobs.filter((j) => j.routineId === r.id)).toHaveLength(1);
    });

    it("утренний план уходит в привязанный чат; без чата — пропуск", async () => {
      const job = { routineId: "r", leaderId, code: "MORNING_DIGEST", firedAt: new Date().toISOString() };
      const { m, sent } = fakeMessenger();
      expect(await processRoutineJob({ db, messenger: m }, job)).toEqual({ skipped: "чат руководителя не привязан" });

      await handleStart(db, chat("L"), `${slug}:${leaderBindSecret(slug, KEY)}`, KEY);
      await db.decision.deleteMany({ where: { leaderId } }); // остатки предыдущих тестов
      await newDecision(leaderId);
      expect(await processRoutineJob({ db, messenger: m }, job)).toEqual({ sent: 1 });
      expect(sent[0].text).toContain("Доброе утро");
      expect(sent[0].text).toContain("ИИ-помощник");
      expect(sent[0].text).toContain("1 вопрос");

      expect(await processRoutineJob({ db, messenger: m }, { ...job, code: "WEEKLY_REPORT" })).toMatchObject({ skipped: expect.any(String) });
      expect(await buildMorningDigest(db, leaderId)).toContain("Главное сегодня");
    });
  });
});
