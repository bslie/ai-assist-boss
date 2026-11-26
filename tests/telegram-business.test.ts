import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Messenger } from "@/core/telegram/types";
import { seedTempLeader } from "./helpers/eval-env";

vi.stubEnv("APP_CLOCK_MODE", "real");
const { db } = await import("@/db/client");
const { clock } = await import("@/core/clock");
const { resolveDecision }= await import("@/core/decisions");
const { BUSINESS_CONNECTOR, BUSINESS_READ_ALL_TOOL, BUSINESS_READ_TOOL, BUSINESS_REPLY_TOOL, executeBusinessReply, handleBusinessConnection, handleBusinessMessage } =
  await import("@/core/telegram/business");

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);

describe.skipIf(!dbUp)("Telegram Business: чаты руководителя", () => {
  let leaderId = "";
  let leaderName = "";
  const tag = Date.now().toString(36);
  const ownerChat = `owner-${tag}`;
  const empChat = `emp-${tag}`;
  const connectionId = `bc-${tag}`;
  const business: { connectionId: string; chatId: string; text: string; replyTo?: number }[] = [];
  const messenger: Messenger = {
    async send() {
      return { messageId: "1" };
    },
    async edit() {},
    async sendBusiness(connectionId, chatId, text, replyTo) {
      business.push({ connectionId, chatId, text, replyTo });
    },
  };
  const deps = () => ({ db, messenger });
  const msg = (over: Partial<Parameters<typeof handleBusinessMessage>[1]> = {}) => ({
    connectionId,
    chatId: empChat,
    messageId: "77",
    fromUserId: "emp-user",
    fromIsBot: false,
    text: "Иван, подскажи, когда будет готов отчёт?",
    ...over,
  });
  const setPerms = (perms: Record<string, string>) =>
    db.connector.updateMany({ where: { leaderId, type: BUSINESS_CONNECTOR }, data: { toolPermissions: perms } });

  beforeAll(async () => {
    await clock.init();
    leaderId = await seedTempLeader(db, "tgbiz");
    leaderName = (await db.leader.findUniqueOrThrow({ where: { id: leaderId } })).name;
    const emp = await db.employee.findFirstOrThrow({ where: { leaderId } });
    await db.telegramBinding.create({ data: { chatId: ownerChat, role: "LEADER", leaderId, isActive: true } });
    await db.telegramBinding.create({ data: { chatId: empChat, role: "EMPLOYEE", leaderId, employeeId: emp.id, isActive: true } });
    await db.connector.create({
      data: {
        leaderId,
        name: "Telegram Business",
        type: BUSINESS_CONNECTOR,
        encryptedConfig: "",
        toolPermissions: { [BUSINESS_READ_TOOL]: "AUTO", [BUSINESS_REPLY_TOOL]: "APPROVE" },
      },
    });
  });
  afterAll(async () => {
    if (leaderId) await db.leader.delete({ where: { id: leaderId } });
  });

  it("подключение без привязки руководителя игнорируется", async () => {
    const r = await handleBusinessConnection(db, { connectionId: "x", userId: "u", userChatId: `nobody-${tag}`, canReply: true, isEnabled: true });
    expect(r.status).toBe("skipped");
    expect(await db.businessConnection.count({ where: { connectionId: "x" } })).toBe(0);
  });

  it("подключение руководителя сохраняется и обновляется", async () => {
    await handleBusinessConnection(db, { connectionId, userId: "owner-user", userChatId: ownerChat, canReply: true, isEnabled: true });
    const row = await db.businessConnection.findUniqueOrThrow({ where: { connectionId } });
    expect(row.leaderId).toBe(leaderId);
    expect(row.canReply).toBe(true);
  });

  it("свои сообщения, боты и чужие чаты не разбираются", async () => {
    expect((await handleBusinessMessage(deps(), msg({ fromUserId: "owner-user" }))).status).toBe("skipped");
    expect((await handleBusinessMessage(deps(), msg({ fromIsBot: true }))).status).toBe("skipped");
    expect((await handleBusinessMessage(deps(), msg({ chatId: `stranger-${tag}`, fromUserId: "stranger" }))).status).toBe("skipped");
    expect((await handleBusinessMessage(deps(), msg({ connectionId: "unknown" }))).status).toBe("skipped");
    expect(await db.decision.count({ where: { leaderId } })).toBe(0);
  });

  it("чтение выключено или запрещено → молчим", async () => {
    await setPerms({ [BUSINESS_READ_TOOL]: "DENY" });
    expect((await handleBusinessMessage(deps(), msg())).status).toBe("skipped");
    await setPerms({ [BUSINESS_READ_TOOL]: "AUTO", [BUSINESS_REPLY_TOOL]: "APPROVE" });
    expect(await db.decision.count({ where: { leaderId } })).toBe(0);
  });

  it("сообщение сотрудника без модели → карточка с инструментом ответа, ничего не отправлено", async () => {
    const r = await handleBusinessMessage(deps(), msg());
    expect(r.status).toBe("queued");
    const d = await db.decision.findFirstOrThrow({ where: { leaderId } });
    expect(d.status).toBe("PENDING");
    expect((d.proposedPayload as { tool: string }).tool).toBe(BUSINESS_REPLY_TOOL);
    expect(business).toHaveLength(0);
  });

  it("утверждённая правка уходит в чат с подписью помощника, повтор не дублирует", async () => {
    const d = await db.decision.findFirstOrThrow({ where: { leaderId } });
    expect(await executeBusinessReply(deps(), leaderId, d.id)).toBeNull(); // ещё не утверждено
    await resolveDecision(db, leaderId, d.id, { action: "EDITED_APPROVED", editedText: "Отчёт будет в пятницу." });

    expect(await executeBusinessReply(deps(), leaderId, d.id)).toEqual({ status: "sent" });
    expect(business).toHaveLength(1);
    expect(business[0]).toMatchObject({ connectionId, chatId: empChat, replyTo: 77 });
    expect(business[0].text.startsWith(`<b>Это ИИ-помощник ${leaderName}.</b>`)).toBe(true);
    expect(business[0].text).toContain("Отчёт будет в пятницу.");

    expect(await executeBusinessReply(deps(), leaderId, d.id)).toMatchObject({ status: "skipped" });
    expect(business).toHaveLength(1);
  });

  it("запрет инструмента сильнее утверждения; нет права отвечать → не отправляем", async () => {
    const mk = async (messageId: string) => {
      await handleBusinessMessage(deps(), msg({ messageId, text: `Вопрос ${messageId}` }));
      const d = await db.decision.findFirstOrThrow({ where: { leaderId, status: "PENDING" } });
      await resolveDecision(db, leaderId, d.id, { action: "EDITED_APPROVED", editedText: "Ответ" });
      return d.id;
    };
    const denied = await mk("78");
    await setPerms({ [BUSINESS_READ_TOOL]: "AUTO", [BUSINESS_REPLY_TOOL]: "DENY" });
    expect(await executeBusinessReply(deps(), leaderId, denied)).toEqual({ status: "denied" });

    await setPerms({ [BUSINESS_READ_TOOL]: "AUTO", [BUSINESS_REPLY_TOOL]: "APPROVE" });
    await db.businessConnection.update({ where: { connectionId }, data: { canReply: false } });
    expect(await executeBusinessReply(deps(), leaderId, denied)).toMatchObject({ status: "skipped" });
    expect(business).toHaveLength(1);
  });

  it("«читать всех» выключено по умолчанию; включённое пускает чужих, но не ботов и не группы", async () => {
    const stranger = msg({ chatId: `stranger-${tag}`, fromUserId: "stranger", messageId: "90", fromName: "Пётр Незнакомцев" });
    expect((await handleBusinessMessage(deps(), stranger)).status).toBe("skipped");

    await setPerms({ [BUSINESS_READ_TOOL]: "AUTO", [BUSINESS_READ_ALL_TOOL]: "AUTO", [BUSINESS_REPLY_TOOL]: "APPROVE" });
    expect((await handleBusinessMessage(deps(), { ...stranger, fromIsBot: true })).status).toBe("skipped");
    expect((await handleBusinessMessage(deps(), stranger)).status).toBe("queued");
    const d = await db.decision.findFirstOrThrow({ where: { leaderId, title: { contains: "Пётр" } } });
    expect(d.status).toBe("PENDING");
    expect((d.proposedPayload as { args: { chatId: string } }).args.chatId).toBe(`stranger-${tag}`);
  });
});
