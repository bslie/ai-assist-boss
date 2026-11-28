import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_REPLY_DELAY_MINUTES, parseReplyDelay, validateReplyDelay } from "@/core/telegram/reply-delay";
import type { Messenger } from "@/core/telegram/types";
import { seedTempLeader } from "./helpers/eval-env";

vi.stubEnv("APP_CLOCK_MODE", "real");
const { db } = await import("@/db/client");
const { clock } = await import("@/core/clock");
const { BUSINESS_CONNECTOR, BUSINESS_READ_TOOL, BUSINESS_REPLY_TOOL, handleBusinessConnection, handleBusinessMessage, processDueBusinessMessages } = await import("@/core/telegram/business");

describe("Задержка ответа ИИ: разбор значения", () => {
  it("по умолчанию 30 минут, мусор тоже даёт 30", () => {
    expect(DEFAULT_REPLY_DELAY_MINUTES).toBe(30);
    for (const raw of [undefined, null, "", "  ", "abc", "-5", "1.5", "99999"]) expect(parseReplyDelay(raw)).toBe(30);
  });
  it("число минут принимается, 0 — сразу", () => {
    expect(parseReplyDelay("45")).toBe(45);
    expect(parseReplyDelay("0")).toBe(0);
  });
  it("при сохранении неверное значение даёт ошибку, пустое нет", () => {
    expect(validateReplyDelay("abc")).toContain("Задержка ответа ИИ");
    expect(validateReplyDelay("-1")).not.toBeNull();
    expect(validateReplyDelay("")).toBeNull();
    expect(validateReplyDelay("30")).toBeNull();
  });
});

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);

describe.skipIf(!dbUp)("Задержка ответа ИИ: личный чат (Postgres)", () => {
  let leaderId = "";
  const tag = Date.now().toString(36);
  const ownerChat = `owner-${tag}`;
  const empChat = `emp-${tag}`;
  const connectionId = `bcd-${tag}`;
  const messenger: Messenger = { async send() { return { messageId: "1" }; }, async edit() {}, async sendBusiness() {} };
  const deps = { db, messenger };
  const msg = (over: Record<string, unknown> = {}) => ({ connectionId, chatId: empChat, messageId: "1", fromUserId: "emp-user", fromIsBot: false, text: "Иван, когда будет готов отчёт?", ...over });
  const pending = (status: string) => db.businessPending.count({ where: { connectionId, status } });

  beforeAll(async () => {
    await clock.init();
    leaderId = await seedTempLeader(db, "tgdelay");
    const emp = await db.employee.findFirstOrThrow({ where: { leaderId } });
    await db.telegramBinding.create({ data: { chatId: ownerChat, role: "LEADER", leaderId, isActive: true } });
    await db.telegramBinding.create({ data: { chatId: empChat, role: "EMPLOYEE", leaderId, employeeId: emp.id, isActive: true } });
    await db.connector.create({ data: { leaderId, name: "Telegram Business", type: BUSINESS_CONNECTOR, encryptedConfig: "", toolPermissions: { [BUSINESS_READ_TOOL]: "AUTO", [BUSINESS_REPLY_TOOL]: "APPROVE" } } });
    await handleBusinessConnection(db, { connectionId, userId: "owner-user", userChatId: ownerChat, canReply: true, isEnabled: true });
  });
  afterAll(async () => {
    if (leaderId) await db.leader.delete({ where: { id: leaderId } });
  });

  it("сообщение сотрудника ждёт задержку, карточки пока нет", async () => {
    expect((await handleBusinessMessage(deps, msg())).status).toBe("queued");
    expect(await pending("PENDING")).toBe(1);
    expect(await db.decision.count({ where: { leaderId } })).toBe(0);
    expect(await processDueBusinessMessages(deps)).toBe(0); // срок ещё не вышел
  });

  it("руководитель ответил сам: ожидание снимается, карточки не будет", async () => {
    const r = await handleBusinessMessage(deps, msg({ fromUserId: "owner-user", messageId: "2" }));
    expect(r.status).toBe("skipped");
    expect(await pending("PENDING")).toBe(0);
    expect(await pending("ANSWERED")).toBe(1);
    expect((await db.businessPending.findFirstOrThrow({ where: { connectionId } })).text).toBe("");
  });

  it("руководитель молчит: после срока сообщение разбирается один раз", async () => {
    await handleBusinessMessage(deps, msg({ messageId: "3" }));
    await db.businessPending.updateMany({ where: { connectionId, status: "PENDING" }, data: { dueAt: new Date(Date.now() - 1000) } });
    expect(await processDueBusinessMessages(deps)).toBe(1);
    expect(await pending("DONE")).toBe(1);
    expect(await processDueBusinessMessages(deps)).toBe(0);
  });

  it("повтор того же сообщения не дублируется, чужой чат не копится в очереди", async () => {
    await handleBusinessMessage(deps, msg({ messageId: "4" }));
    expect((await handleBusinessMessage(deps, msg({ messageId: "4" }))).status).toBe("skipped");
    expect((await handleBusinessMessage(deps, msg({ chatId: `stranger-${tag}`, fromUserId: "stranger", messageId: "5" }))).status).toBe("skipped");
    expect(await db.businessPending.count({ where: { connectionId, chatId: `stranger-${tag}` } })).toBe(0);
  });
});
