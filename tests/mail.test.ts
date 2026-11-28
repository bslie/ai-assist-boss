import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LlmClient, MemoryCache, type LlmProvider } from "@/core/llm";
import { seedTempLeader } from "./helpers/eval-env";

vi.stubEnv("APP_CLOCK_MODE", "real");
vi.stubEnv("CONNECTOR_SECRET", "test-secret-test-secret-1234");
const { db } = await import("@/db/client");
const { clock } = await import("@/core/clock");
const { encryptJson, decryptJson } = await import("@/core/connectors/crypto");
const { pollConnector } = await import("@/core/mail/poll");
const { executeApprovedReply } = await import("@/core/mail/send");
const { resolveDecision } = await import("@/core/decisions");
const { GraphMailConnector } = await import("@/core/mail/graph");
const { GmailMailConnector } = await import("@/core/mail/gmail");
const { htmlToText } = await import("@/core/mail/types");

import type { MailConnector, MailFetch, OutgoingReply } from "@/core/mail/types";

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);

/** Подставное подключение: отдаёт заготовленные письма, запоминает отправки и архив. */
function fakeMail(batches: MailFetch[]) {
  const calls = { listNew: [] as (string | null)[], sent: [] as OutgoingReply[], archived: [] as string[] };
  let failSend = false;
  const c: MailConnector & { failSend: (v: boolean) => void } = {
    failSend: (v) => (failSend = v),
    verify: async () => undefined,
    listNew: async (cursor) => {
      calls.listNew.push(cursor);
      const b = batches.shift();
      if (!b) throw new Error("Почтовый сервер недоступен");
      return b;
    },
    send: async (r) => {
      if (failSend) throw new Error("SMTP отказал");
      calls.sent.push(r);
    },
    archive: async (id) => void calls.archived.push(id),
  };
  return { c, calls };
}

/** Фейковая модель: письма от news@ — рассылка, остальные — кадровый вопрос (обязательно спросить руководителя). */
const provider: LlmProvider = {
  name: "fake",
  model: "m",
  async generate({ prompt }) {
    const news = prompt.includes("news@");
    return {
      object: { category: news ? "NEWSLETTER" : "HR", confidence: 0.95, amount: null, client: null, deadline: null, isUrgent: false, summary: news ? "Рассылка" : "Кадровый вопрос" },
      promptTokens: 1,
      completionTokens: 1,
    };
  },
};
const llm = new LlmClient({ provider, cache: new MemoryCache() });
const noLock = async () => async () => undefined;

const mail = (id: string, from: string, subject: string) => ({
  externalId: id,
  messageId: `<${id}@x>`,
  senderEmail: from,
  senderName: from.split("@")[0],
  subject,
  body: `Текст письма ${id}`,
  receivedAt: new Date(),
  recipients: [] as string[],
});

describe("разбор html", () => {
  it("теги, сущности и переносы", () => {
    expect(htmlToText("<p>Привет&nbsp;мир</p><style>a{}</style><div>Как <b>дела</b>?</div>")).toBe("Привет мир\nКак дела?");
  });
});

describe("Graph: обновление токена и разбор писем", () => {
  it("просроченный токен обновляется и сохраняется; свои письма пропускаются", async () => {
    const saved: unknown[] = [];
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(String(url));
      if (String(url).includes("token")) return new Response(JSON.stringify({ access_token: "new", refresh_token: "r2", expires_in: 3600 }));
      return new Response(
        JSON.stringify({
          value: [
            { id: "m1", internetMessageId: "<a@x>", subject: "Привет", receivedDateTime: "2026-12-07T10:00:00Z", from: { emailAddress: { address: "Anna@Corp.ru", name: "Анна" } }, body: { content: "Текст", contentType: "text" } },
            { id: "m2", subject: "Моё", receivedDateTime: "2026-12-07T11:00:00Z", from: { emailAddress: { address: "boss@corp.ru" } }, body: { content: "x", contentType: "text" } },
          ],
        }),
      );
    }) as unknown as typeof fetch;
    const g = new GraphMailConnector({
      tokens: { access_token: "old", refresh_token: "r1", expires_at: Date.now() - 1000 },
      ownEmail: "boss@corp.ru",
      saveTokens: async (t) => void saved.push(t),
      tokenUrl: "https://login.example/token",
      clientId: "id",
      clientSecret: "secret",
      fetch: f,
    });
    const r = await g.listNew(null, 10);
    expect(saved).toHaveLength(1);
    expect(r.emails.map((e) => e.senderEmail)).toEqual(["anna@corp.ru"]);
    expect(r.emails[0]).toMatchObject({ externalId: "m1", senderName: "Анна", subject: "Привет" });
    expect(r.cursor).toBe("2026-12-07T11:00:00Z");
    expect(calls.some((u) => u.includes("%24filter") || u.includes("$filter"))).toBe(true);
  });
});


describe('Gmail: письма, ответ в ветку, архив, обновление токена', () => {
  const enc = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
  const calls: { url: string; init?: RequestInit }[] = [];
  const msg = (id: string, ms: number, from: string, subject: string, parts: unknown) => ({
    id, threadId: 't-' + id, internalDate: String(ms),
    payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, { name: 'Message-ID', value: '<' + id + '@g>' }, { name: 'To', value: 'Boss <boss@gmail.com>, x@y.ru' }], mimeType: 'multipart/alternative', parts },
  });
  const store: Record<string, unknown> = {
    a1: msg('a1', 1_800_000_100_000, 'Анна Иванова <Anna@Corp.ru>', 'Вопрос по бюджету', [{ mimeType: 'text/html', body: { data: enc('<p>HTML версия</p>') } }, { mimeType: 'text/plain', body: { data: enc('Привет, нужен ответ') } }]),
    a2: msg('a2', 1_800_000_200_000, 'boss@gmail.com', 'Моё', [{ mimeType: 'text/plain', body: { data: enc('сам себе') } }]),
    a3: msg('a3', 1_800_000_300_000, 'news@vendor.ru', 'Новости', [{ mimeType: 'text/html', body: { data: enc('<div>Только html</div>') } }]),
  };
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    if (u.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600 }));
    if (u.includes('/messages?')) return new Response(JSON.stringify({ messages: [{ id: 'a3' }, { id: 'a2' }, { id: 'a1' }] }));
    if (u.includes('format=minimal')) return new Response(JSON.stringify({ threadId: 't-a1' }));
    if (u.endsWith('/messages/send') || u.endsWith('/modify')) return new Response('{}');
    const id = u.match(/messages\/([^?/]+)\?format=full/)?.[1];
    return new Response(JSON.stringify(store[id ?? '']));
  }) as unknown as typeof fetch;
  const saved: unknown[] = [];
  const g = new GmailMailConnector({ tokens: { access_token: 'old', refresh_token: 'r', expires_at: Date.now() - 5 }, ownEmail: 'boss@gmail.com', saveTokens: async (x) => void saved.push(x), tokenUrl: 'https://oauth2.example/token', clientId: 'i', clientSecret: 's', fetch: f });

  it('читает от старых к новым, пропускает свои, берёт plain или html, курсор — секунды последнего', async () => {
    const r = await g.listNew(null, 10);
    expect(saved).toHaveLength(1); // токен обновлён, refresh сохранён
    expect(saved[0]).toMatchObject({ access_token: 'fresh', refresh_token: 'r' });
    expect(r.emails.map((e) => e.externalId)).toEqual(['a1', 'a3']);
    expect(r.emails[0]).toMatchObject({ senderEmail: 'anna@corp.ru', senderName: 'Анна Иванова', subject: 'Вопрос по бюджету', body: 'Привет, нужен ответ', messageId: '<a1@g>', recipients: ['boss@gmail.com', 'x@y.ru'] });
    expect(r.emails[1].body).toBe('Только html');
    expect(r.cursor).toBe('1800000300');
    expect(calls.find((c) => c.url.includes('/messages?'))?.url).toContain('in%3Ainbox+after%3A');
  });

  it('ответ идёт в ту же ветку с заголовками In-Reply-To; архив снимает метку INBOX', async () => {
    await g.send({ to: 'anna@corp.ru', subject: 'Вопрос по бюджету', text: 'Отвечу в четверг.', externalId: 'a1', inReplyTo: '<a1@g>' });
    const send = calls.filter((c) => c.url.endsWith('/messages/send')).at(-1)!;
    const body = JSON.parse(String(send.init?.body)) as { raw: string; threadId?: string };
    expect(body.threadId).toBe('t-a1');
    const mime = Buffer.from(body.raw, 'base64url').toString('utf8');
    expect(mime).toMatch(/In-Reply-To: <a1@g>/i);
    expect(mime).toMatch(/To: anna@corp.ru/i);
    expect(mime).toMatch(/Subject: (=\?UTF-8|Re:)/i);

    await g.archive('a3');
    const mod = calls.filter((c) => c.url.endsWith('/messages/a3/modify')).at(-1)!;
    expect(JSON.parse(String(mod.init?.body))).toEqual({ removeLabelIds: ['INBOX'] });
  });
});

describe.skipIf(!dbUp)("опрос и отправка (Postgres)", () => {
  let a = "";
  let b = "";
  let connectorId = "";

  const addConnector = async (leaderId: string, perms: Record<string, string>) =>
    (
      await db.connector.create({
        data: {
          leaderId,
          name: "Почта по IMAP",
          type: "BUILTIN_IMAP",
          encryptedConfig: encryptJson({ values: { email: "boss@corp.ru", password: "p", imapHost: "h", smtpHost: "s" } }),
          toolPermissions: perms,
        },
      })
    ).id;

  beforeAll(async () => {
    await clock.init();
    a = await seedTempLeader(db, "mail-a");
    b = await seedTempLeader(db, "mail-b");
    // Архив по праву AUTO проверяем у руководителя вне режима обучения (в режиме письмо осталось бы во входящих).
    await db.leader.update({ where: { id: a }, data: { learningMode: false } });
    connectorId = await addConnector(a, { "mail.read": "AUTO", "mail.send_reply": "APPROVE", "mail.archive": "AUTO" });
  });
  afterAll(async () => {
    await db.leader.deleteMany({ where: { id: { in: [a, b] } } });
  });

  it("новые письма → карточка с привязкой к подключению; курсор сохраняется; повтор не плодит дубли", async () => {
    const batch: MailFetch = { emails: [mail("imap:1:10", "hr@corp.ru", "Оффер кандидату"), mail("imap:1:11", "news@vendor.ru", "Вебинар")], cursor: "1:11" };
    const f = fakeMail([batch, { emails: batch.emails, cursor: "1:11" }]);
    const r1 = await pollConnector(db, a, connectorId, { llm, connector: f.c, lock: noLock });
    expect(r1).toMatchObject({ ok: true, fetched: 2 });
    const d = await db.decision.findFirstOrThrow({ where: { leaderId: a, title: "Оффер кандидату" } });
    expect(d.proposedPayload).toMatchObject({ tool: "mail.reply", args: { to: "hr@corp.ru", connectorId, externalId: "imap:1:10", inReplyTo: "<imap:1:10@x>" } });

    // рассылка ушла в архив: право AUTO и шлюз разрешил; карточки на неё нет
    expect(f.calls.archived).toEqual(["imap:1:11"]);
    expect(await db.decision.count({ where: { leaderId: a, title: "Вебинар" } })).toBe(0);

    const row = await db.connector.findFirstOrThrow({ where: { id: connectorId } });
    const stored = decryptJson<{ cursor?: string; lastSync?: { fetched: number } }>(row.encryptedConfig)!;
    expect(stored.cursor).toBe("1:11");
    expect(stored.lastSync?.fetched).toBe(2);

    // тот же пакет ещё раз: письма уже есть, новых карточек нет, курсор передан
    await pollConnector(db, a, connectorId, { llm, connector: f.c, lock: noLock });
    expect(f.calls.listNew).toEqual([null, "1:11"]);
    expect(await db.decision.count({ where: { leaderId: a, title: "Оффер кандидату" } })).toBe(1);
  });

  it("сбой сервера: курсор не двигается, ошибка видна в итоге опроса", async () => {
    const f = fakeMail([]);
    const r = await pollConnector(db, a, connectorId, { llm, connector: f.c, lock: noLock });
    expect(r).toMatchObject({ ok: false, skipped: false, message: expect.stringContaining("недоступен") });
    const stored = decryptJson<{ cursor?: string; lastSync?: { error?: string } }>((await db.connector.findFirstOrThrow({ where: { id: connectorId } })).encryptedConfig)!;
    expect(stored.cursor).toBe("1:11");
    expect(stored.lastSync?.error).toContain("недоступен");
  });

  it("выключено, чтение запрещено, чужой руководитель, занято другим процессом: не опрашиваем", async () => {
    const f = fakeMail([{ emails: [], cursor: "x" }]);
    const off = await addConnector(a, { "mail.read": "AUTO" });
    await db.connector.update({ where: { id: off }, data: { isActive: false } });
    expect(await pollConnector(db, a, off, { llm, connector: f.c, lock: noLock })).toMatchObject({ ok: false, skipped: true });

    const denied = await addConnector(a, { "mail.read": "DENY" });
    expect(await pollConnector(db, a, denied, { llm, connector: f.c, lock: noLock })).toMatchObject({ ok: false, skipped: true, message: expect.stringContaining("запретили") });

    expect(await pollConnector(db, b, connectorId, { llm, connector: f.c, lock: noLock })).toMatchObject({ ok: false, skipped: true });
    expect(await pollConnector(db, a, connectorId, { llm, connector: f.c, lock: async () => null })).toMatchObject({ ok: false, skipped: true, message: expect.stringContaining("уже проверяют") });
    expect(f.calls.listNew).toHaveLength(0);
  });

  it("архив не трогает письма без права AUTO: по умолчанию письмо остаётся во входящих", async () => {
    const c2 = await addConnector(a, { "mail.read": "AUTO", "mail.archive": "APPROVE" });
    const f = fakeMail([{ emails: [mail("imap:2:1", "news@vendor.ru", "Новости")], cursor: "2:1" }]);
    await pollConnector(db, a, c2, { llm, connector: f.c, lock: noLock });
    expect(f.calls.archived).toEqual([]);
  });

  const approvedDecision = async (leader: string, over: { connectorId?: string | null; draft?: string; edited?: string } = {}) =>
    db.decision.create({
      data: {
        leaderId: leader,
        type: "EMAIL_REPLY",
        title: "Вопрос",
        contextSummary: "с",
        gateReasons: [],
        aiRecommendation: "r",
        status: "EDITED_APPROVED",
        draftText: over.draft ?? "Черновик",
        editedText: over.edited ?? "Рассмотрю в четверг.",
        proposedPayload: { tool: "mail.reply", args: { to: "hr@corp.ru", subject: "Вопрос", connectorId: over.connectorId === undefined ? connectorId : over.connectorId, externalId: "imap:1:10", inReplyTo: "<id@x>" } },
      },
    });

  it("утверждённый ответ уходит через подключение без подписи помощника, в ту же ветку", async () => {
    const d = await approvedDecision(a);
    const f = fakeMail([]);
    const r = await executeApprovedReply(db, a, d.id, { connector: f.c });
    expect(r).toMatchObject({ executed: true });
    expect(f.calls.sent).toHaveLength(1);
    expect(f.calls.sent[0]).toMatchObject({ to: "hr@corp.ru", subject: "Вопрос", inReplyTo: "<id@x>", externalId: "imap:1:10" });
    expect(f.calls.sent[0].text).toContain("Рассмотрю в четверг.");
    expect(f.calls.sent[0].text).not.toMatch(/ИИ-помощник/);
    expect(await db.activityLog.count({ where: { leaderId: a, action: "MAIL_SENT" } })).toBeGreaterThan(0);
    expect(await db.activityLog.count({ where: { leaderId: a, action: "ALLOW:mail.send_reply" } }) + (await db.activityLog.count({ where: { leaderId: a, action: "APPROVE:mail.send_reply" } }))).toBeGreaterThan(0);
  });

  it("запрет в правах, выключенное подключение, сбой SMTP, карточка без подключения: не уходит", async () => {
    const denied = await addConnector(a, { "mail.send_reply": "DENY" });
    const f = fakeMail([]);
    expect(await executeApprovedReply(db, a, (await approvedDecision(a, { connectorId: denied })).id, { connector: f.c })).toMatchObject({ executed: false, reason: expect.stringContaining("запрещена") });

    const off = await addConnector(a, { "mail.send_reply": "APPROVE" });
    await db.connector.update({ where: { id: off }, data: { isActive: false } });
    expect(await executeApprovedReply(db, a, (await approvedDecision(a, { connectorId: off })).id, { connector: f.c })).toMatchObject({ executed: false, reason: expect.stringContaining("выключено") });

    f.c.failSend(true);
    expect(await executeApprovedReply(db, a, (await approvedDecision(a)).id, { connector: f.c })).toMatchObject({ executed: false, reason: expect.stringContaining("SMTP отказал") });

    expect(await executeApprovedReply(db, a, (await approvedDecision(a, { connectorId: null })).id, { connector: f.c })).toMatchObject({ executed: false, applicable: false });
    expect(f.calls.sent).toHaveLength(0);
    expect(await db.activityLog.count({ where: { leaderId: a, action: "MAIL_SEND_FAILED" } })).toBeGreaterThanOrEqual(3);
  });

  it("карточка чужого руководителя и неутверждённая не отправляются", async () => {
    const f = fakeMail([]);
    const d = await approvedDecision(a);
    expect(await executeApprovedReply(db, b, d.id, { connector: f.c })).toMatchObject({ executed: false, applicable: false });
    const pending = await db.decision.update({ where: { id: (await approvedDecision(a)).id }, data: { status: "PENDING" } });
    expect(await executeApprovedReply(db, a, pending.id, { connector: f.c })).toMatchObject({ executed: false });
    expect(f.calls.sent).toHaveLength(0);
  });

  it("resolveDecision без подключённой почты работает как раньше", async () => {
    const d = await db.decision.create({ data: { leaderId: b, type: "EMAIL_REPLY", title: "T", contextSummary: "c", gateReasons: [], aiRecommendation: "r", proposedPayload: { tool: "mail.reply", args: { to: "x@y.z", subject: "T" } }, draftText: "Ок" } });
    expect(await resolveDecision(db, b, d.id, { action: "APPROVE" })).toMatchObject({ ok: true, status: "APPROVED" });
  });
});
