import "dotenv/config";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LlmClient, MemoryCache, type LlmProvider } from "@/core/llm";
import { seedTempLeader } from "./helpers/eval-env";

vi.stubEnv("APP_CLOCK_MODE", "real");
vi.stubEnv("CONNECTOR_SECRET", "test-secret-test-secret-1234");
const { db } = await import("@/db/client");
const { clock } = await import("@/core/clock");
const { encryptJson } = await import("@/core/connectors/crypto");
const { routeEmail } = await import("@/core/email-triage/classify");
const { markHandledEmails } = await import("@/core/mail/mark-read");
const { pollConnector } = await import("@/core/mail/poll");
const { resolveDecision } = await import("@/core/decisions");
const { GmailMailConnector } = await import("@/core/mail/gmail");
const { GraphMailConnector } = await import("@/core/mail/graph");
import type { MailConnector, MailFetch } from "@/core/mail/types";

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);

describe("маршрут служебных уведомлений", () => {
  it("уверенный SYSTEM_NOTICE игнорируется; «срок» и «приглашение» в таком письме не зовут руководителя", () => {
    expect(routeEmail({ category: "SYSTEM_NOTICE", confidence: 0.95, signals: [] }).action).toBe("IGNORE");
    expect(routeEmail({ category: "SYSTEM_NOTICE", confidence: 0.95, signals: ["COMMITMENT_TERMS", "EXTERNAL_INVITATION"] }).action).toBe("IGNORE");
  });

  it("защита сохраняется: люди из оргструктуры, кадры, согласование денег и неуверенность — руководителю", () => {
    for (const s of ["MANAGER_PARTY", "HR_PARTY", "FINANCE_PARTY", "HR_TERMS", "MONEY_APPROVAL"] as const) {
      expect(routeEmail({ category: "SYSTEM_NOTICE", confidence: 0.95, signals: [s] }).action, s).toBe("ASK_LEADER");
    }
    expect(routeEmail({ category: "SYSTEM_NOTICE", confidence: 0.5, signals: [] }).action).toBe("ASK_LEADER");
    // послабление действует только для SYSTEM_NOTICE
    expect(routeEmail({ category: "REPORT", confidence: 0.95, signals: ["COMMITMENT_TERMS"] }).action).toBe("ASK_LEADER");
  });
});

describe("пометка «прочитано» у почтовых подключений", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("Gmail снимает метку UNREAD, Graph ставит isRead", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response("{}");
    }) as unknown as typeof fetch;
    const opts = { tokens: { access_token: "t", expires_at: Date.now() + 3_600_000 }, saveTokens: async () => undefined, tokenUrl: "https://t.example", clientId: "i", clientSecret: "s", fetch: f };
    await new GmailMailConnector(opts).markRead("m1");
    await new GraphMailConnector(opts).markRead("g1");
    expect(calls[0].url).toContain("/messages/m1/modify");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ removeLabelIds: ["UNREAD"] });
    expect(calls[1].url).toContain("/me/messages/g1");
    expect(calls[1].init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ isRead: true });
  });
});

describe.skipIf(!dbUp)("отработанные письма → прочитанные, служебные остаются (Postgres)", () => {
  let leaderId = "";
  let connectorId = "";
  const modified: string[] = [];

  const stubGmail = () =>
    vi.stubGlobal("fetch", async (url: string) => {
      const m = /\/messages\/([^/]+)\/modify/.exec(String(url));
      if (m) modified.push(decodeURIComponent(m[1]));
      return new Response("{}");
    });

  const connect = async (perms: Record<string, string>) =>
    (
      await db.connector.create({
        data: {
          leaderId,
          name: "Gmail",
          type: "BUILTIN_GMAIL",
          encryptedConfig: encryptJson({ tokens: { access_token: "t", refresh_token: "r", expires_at: Date.now() + 3_600_000 }, account: "boss@example.com" }),
          toolPermissions: perms,
        },
      })
    ).id;

  const email = (ext: string, extra: Record<string, unknown>) =>
    db.emailItem.create({
      data: { leaderId, externalId: ext, connectorId, threadKey: ext, senderName: "X", senderEmail: `${ext}@example.com`, subject: ext, body: "текст", receivedAt: new Date(clock.now().getTime() - 3_600_000), ...extra },
    });
  const decision = (status: "PENDING" | "APPROVED" | "REJECTED" | "SNOOZED") =>
    db.decision.create({ data: { leaderId, type: "EMAIL_REPLY", title: "t", contextSummary: "s", gateReasons: [], aiRecommendation: "r", proposedPayload: {}, status } });

  beforeAll(async () => {
    await clock.init();
    leaderId = await seedTempLeader(db, "mark-read"); // режим обучения включён: пометка идёт по постоянному согласию, а не по каждому «да»
    await db.emailItem.deleteMany({ where: { leaderId } });
    // Подключение «старше» инструмента: записи mail.mark_read нет, действует значение из манифеста (AUTO).
    connectorId = await connect({ "mail.read": "AUTO" });
  });
  afterAll(async () => {
    await db.leader.deleteMany({ where: { id: leaderId } });
  });

  it("помечаются: AUTO, DIGEST, передача с задачей, решённая и отклонённая карточки; остальное остаётся непрочитанным", async () => {
    stubGmail();
    const [pending, approved, rejected, snoozed] = await Promise.all([decision("PENDING"), decision("APPROVED"), decision("REJECTED"), decision("SNOOZED")]);
    await email("auto", { action: "AUTO", category: "CALENDAR" });
    await email("digest", { action: "DIGEST", category: "REPORT" });
    await email("deleg-task", { action: "DELEGATE", category: "ACCESS", taskId: "task-1" });
    await email("deleg-none", { action: "DELEGATE", category: "ACCESS" });
    await email("service", { action: "IGNORE", category: "SYSTEM_NOTICE" });
    await email("news", { action: "IGNORE", category: "NEWSLETTER" });
    await email("ask-pending", { action: "ASK_LEADER", category: "HR", decisionId: pending.id });
    await email("ask-approved", { action: "ASK_LEADER", category: "HR", decisionId: approved.id });
    await email("ask-rejected", { action: "ASK_LEADER", category: "MONEY", decisionId: rejected.id });
    await email("ask-snoozed", { action: "ASK_LEADER", category: "MANAGEMENT", decisionId: snoozed.id });

    expect(await markHandledEmails(db, leaderId)).toBe(5);
    expect(modified.sort()).toEqual(["ask-approved", "ask-rejected", "auto", "deleg-task", "digest"]);
    expect((await db.emailItem.findMany({ where: { leaderId, readMarkedAt: { not: null } }, select: { externalId: true } })).length).toBe(5);

    // повторный вызов ничего не делает: письма уже помечены
    modified.length = 0;
    expect(await markHandledEmails(db, leaderId)).toBe(0);
    expect(modified).toEqual([]);
  });

  it("служебное письмо остаётся непрочитанным, даже если карточку решили: у него нет карточки, а IGNORE не помечается", async () => {
    const rows = await db.emailItem.findMany({ where: { leaderId, externalId: { in: ["service", "news", "deleg-none"] } }, select: { readMarkedAt: true } });
    expect(rows.every((r) => r.readMarkedAt === null)).toBe(true);
  });

  it("решение руководителя помечает письмо; «не сейчас» — нет", async () => {
    stubGmail();
    modified.length = 0;
    const d = await decision("PENDING");
    await email("resolve-me", { action: "ASK_LEADER", category: "HR", decisionId: d.id });
    const s = await decision("PENDING");
    await email("snooze-me", { action: "ASK_LEADER", category: "HR", decisionId: s.id });

    await resolveDecision(db, leaderId, s.id, { action: "SNOOZE" });
    expect(modified).toEqual([]);
    await resolveDecision(db, leaderId, d.id, { action: "REJECTED" });
    expect(modified).toEqual(["resolve-me"]);
  });

  it("права подключения: APPROVE и DENY на mail.mark_read не дают помечать", async () => {
    for (const perm of ["APPROVE", "DENY"]) {
      stubGmail();
      modified.length = 0;
      await db.connector.update({ where: { id: connectorId }, data: { toolPermissions: { "mail.read": "AUTO", "mail.mark_read": perm } } });
      await email(`perm-${perm}`, { action: "DIGEST", category: "REPORT" });
      expect(await markHandledEmails(db, leaderId)).toBe(0);
      expect(modified, perm).toEqual([]);
    }
    // право вернули: письма, пропущенные раньше, помечаются при следующей проверке
    stubGmail();
    await db.connector.update({ where: { id: connectorId }, data: { toolPermissions: { "mail.read": "AUTO", "mail.mark_read": "AUTO" } } });
    expect(await markHandledEmails(db, leaderId)).toBe(2);
  });

  it("служебное письмо при опросе: карточки нет, в архив не уходит, в журнале SERVICE_NOTICE, письмо не помечается", async () => {
    await db.leader.update({ where: { id: leaderId }, data: { learningMode: false } });
    const cid = await connect({ "mail.read": "AUTO", "mail.archive": "AUTO", "mail.mark_read": "AUTO" });
    const provider: LlmProvider = {
      name: "fake",
      model: "m",
      async generate() {
        return { object: { category: "SYSTEM_NOTICE", confidence: 0.96, amount: null, client: null, deadline: null, isUrgent: false, summary: "Сервер скоро будет заблокирован" }, promptTokens: 1, completionTokens: 1 };
      },
    };
    const marked: string[] = [];
    const archived: string[] = [];
    const fake: MailConnector = {
      verify: async () => undefined,
      listNew: async (): Promise<MailFetch> => ({
        emails: [{ externalId: "svc-1", senderEmail: "no-reply@hosting.example", senderName: "Хостинг", subject: "Сервер ecoplant-spb-4 скоро будет заблокирован", body: "Срок оплаты истекает, приглашаем продлить.", receivedAt: new Date(), recipients: [] }],
        cursor: "c1",
      }),
      send: async () => undefined,
      archive: async (id) => void archived.push(id),
      markRead: async (id) => void marked.push(id),
    };
    const r = await pollConnector(db, leaderId, cid, { llm: new LlmClient({ provider, cache: new MemoryCache() }), connector: fake, lock: async () => async () => undefined });
    expect(r).toMatchObject({ ok: true, fetched: 1 });
    const item = await db.emailItem.findFirstOrThrow({ where: { leaderId, externalId: "svc-1" } });
    expect(item).toMatchObject({ action: "IGNORE", category: "SYSTEM_NOTICE", decisionId: null, connectorId: cid, readMarkedAt: null });
    expect(await db.decision.count({ where: { leaderId, title: { contains: "ecoplant" } } })).toBe(0);
    expect(archived).toEqual([]);
    expect(marked).toEqual([]);
    expect(await db.activityLog.count({ where: { leaderId, action: "SERVICE_NOTICE" } })).toBe(1);
    expect(await db.activityLog.count({ where: { leaderId, action: "IGNORE", reason: { contains: "заблокирован" } } })).toBe(0);
  });
});
