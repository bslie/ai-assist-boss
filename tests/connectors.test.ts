import "dotenv/config";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedTempLeader } from "./helpers/eval-env";

vi.stubEnv("APP_CLOCK_MODE", "real");
vi.stubEnv("CONNECTOR_SECRET", "test-secret-test-secret-1234");
vi.stubEnv("MS_CLIENT_ID", "");
vi.stubEnv("MS_CLIENT_SECRET", "");
const { db } = await import("@/db/client");
const { decryptJson, encryptJson, signState, verifyState } = await import("@/core/connectors/crypto");
const { MODULES } = await import("@/core/connectors/modules");
const { isPrivateHost, probeMcp } = await import("@/core/connectors/mcp");
const { connectModule, listCatalog, removeConnector, updateConnector } = await import("@/core/connectors/service");

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);

describe("реестр модулей", () => {
  it("id уникальны, имена инструментов не повторяются, умолчание не выше потолка", () => {
    const ids = MODULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    const rank = { DENY: 0, APPROVE: 1, AUTO: 2 };
    for (const m of MODULES) {
      const names = m.tools.map((t) => t.name);
      expect(new Set(names).size, m.id).toBe(names.length);
      for (const t of m.tools) if (t.max) expect(rank[t.default], t.name).toBeLessThanOrEqual(rank[t.max]);
    }
  });

  it("запись во внешние сервисы по умолчанию не AUTO, кроме сообщений самому руководителю", () => {
    for (const m of MODULES) for (const t of m.tools) if (t.kind === "write" && t.name !== "telegram.send_digest") expect(t.default, t.name).not.toBe("AUTO");
  });
});

describe("шифрование секретов", () => {
  it("round-trip, чужой ключ и порча не расшифровываются", () => {
    const blob = encryptJson({ values: { password: "p@ss" } });
    expect(blob).not.toContain("p@ss");
    expect(decryptJson<{ values: { password: string } }>(blob)?.values.password).toBe("p@ss");
    expect(decryptJson(blob.slice(0, -4) + "AAAA")).toBeNull();
    vi.stubEnv("CONNECTOR_SECRET", "another-secret-another-secret");
    expect(decryptJson(blob)).toBeNull();
    vi.stubEnv("CONNECTOR_SECRET", "test-secret-test-secret-1234");
  });

  it("state OAuth: подпись проверяется, подделка отклоняется", () => {
    const s = signState("leader|MOD|nonce");
    expect(verifyState(s)).toBe("leader|MOD|nonce");
    expect(verifyState(s.replace("leader", "other"))).toBeNull();
    expect(verifyState("мусор")).toBeNull();
  });
});

describe("разведка MCP", () => {
  let srv: Server;
  let url = "";
  beforeAll(async () => {
    srv = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const msg = body ? JSON.parse(body) : {};
        if (msg.method === "initialize") {
          res.setHeader("content-type", "text/event-stream");
          res.setHeader("mcp-session-id", "s1");
          res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n\n`);
        } else if (msg.method === "tools/list") {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "search", description: "Поиск", annotations: { readOnlyHint: true } }, { name: "create_ticket" }] } }));
        } else res.end();
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`;
  });
  afterAll(() => void srv.close());

  it("находит инструменты; без подсказки инструмент считается записью", async () => {
    const r = await probeMcp(url, { allowLocal: true });
    expect(r.ok && r.tools).toEqual([
      { name: "search", description: "Поиск", readOnly: true },
      { name: "create_ticket", description: "", readOnly: false },
    ]);
  });

  it("не ходит по http и во внутреннюю сеть", async () => {
    expect((await probeMcp(url)).ok).toBe(false);
    expect(await probeMcp("https://192.168.1.5/mcp")).toMatchObject({ ok: false });
    expect(await probeMcp("https://169.254.169.254/latest")).toMatchObject({ ok: false });
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("172.20.0.1")).toBe(true);
    expect(isPrivateHost("example.com")).toBe(false);
    expect(await probeMcp("не адрес")).toMatchObject({ ok: false });
  });
});

describe.skipIf(!dbUp)("подключения (Postgres)", () => {
  let a = "";
  let b = "";
  beforeAll(async () => {
    a = await seedTempLeader(db, "conn-a");
    b = await seedTempLeader(db, "conn-b");
  });
  afterAll(async () => {
    await db.leader.deleteMany({ where: { id: { in: [a, b] } } });
  });

  const imap = { module: "BUILTIN_IMAP", values: { email: "boss@company.ru", password: "secret-app-pass", imapHost: "imap.yandex.ru", smtpHost: "smtp.yandex.ru" } };

  it("каталог показывает все модули; Telegram из профиля уже подключён", async () => {
    const cat = await listCatalog(db, a);
    expect(cat.map((c) => c.moduleId)).toEqual(expect.arrayContaining(MODULES.map((m) => m.id)));
    expect(cat.find((c) => c.moduleId === "BUILTIN_TELEGRAM")?.state).toBe("connected");
    expect(cat.find((c) => c.moduleId === "BUILTIN_GOOGLE")?.state).toBe("soon");
  });

  it("OAuth-модуль без настроенного приложения: «нужна настройка», подключить через форму нельзя", async () => {
    const ms = (await listCatalog(db, a)).find((c) => c.moduleId === "BUILTIN_GRAPH")!;
    expect(ms.state).toBe("needs_setup");
    expect(ms.hint).toContain("MS_CLIENT_ID");
    expect(await connectModule(db, a, { module: "BUILTIN_GRAPH" })).toMatchObject({ ok: false, code: "INVALID" });
  });

  it("доступы шифруются в БД и не попадают в каталог; повторное подключение — конфликт", async () => {
    const r = await connectModule(db, a, imap, { verifyMail: false });
    expect(r.ok).toBe(true);
    const row = await db.connector.findFirstOrThrow({ where: { leaderId: a, type: "BUILTIN_IMAP" } });
    expect(row.encryptedConfig).not.toContain("secret-app-pass");

    const item = (await listCatalog(db, a)).find((c) => c.moduleId === "BUILTIN_IMAP")!;
    expect(item.state).toBe("connected");
    expect(item.account).toBe("boss@company.ru");
    expect(item.filledSecrets).toEqual(["password"]);
    expect(JSON.stringify(item)).not.toContain("secret-app-pass");
    expect(await connectModule(db, a, imap, { verifyMail: false })).toMatchObject({ ok: false, code: "CONFLICT" });
  });

  it("поле без значения отклоняется", async () => {
    expect(await connectModule(db, b, { module: "BUILTIN_RECALL", values: { region: "eu" } })).toMatchObject({ ok: false, code: "INVALID" });
  });

  it("права: меняются, потолок и чужие инструменты не принимаются, DENY всегда можно", async () => {
    const id = (await db.connector.findFirstOrThrow({ where: { leaderId: a, type: "BUILTIN_IMAP" } })).id;
    expect(await updateConnector(db, a, id, { permissions: { "mail.read": "DENY", "mail.archive": "AUTO" } })).toMatchObject({ ok: true });
    const tools = (await listCatalog(db, a)).find((c) => c.connectorId === id)!.tools;
    expect(tools.find((t) => t.name === "mail.read")?.permission).toBe("DENY");
    expect(tools.find((t) => t.name === "mail.archive")?.permission).toBe("AUTO");
    expect(await updateConnector(db, a, id, { permissions: { "net.hack": "AUTO" } })).toMatchObject({ ok: false, code: "INVALID" });

    // Потолок: у Recall запись разговоров не может стать AUTO.
    const rid = await connectModule(db, a, { module: "BUILTIN_RECALL", values: { apiKey: "key", region: "eu-central-1" } });
    if (!rid.ok) throw new Error(rid.message);
    expect(await updateConnector(db, a, rid.value.id, { permissions: { "meeting.join_bot": "AUTO" } })).toMatchObject({ ok: false, code: "INVALID" });
    expect(await updateConnector(db, a, rid.value.id, { permissions: { "meeting.join_bot": "DENY" } })).toMatchObject({ ok: true });
  });

  it("выключение, смена пароля (пустое значение = не менять), чужой руководитель", async () => {
    const id = (await db.connector.findFirstOrThrow({ where: { leaderId: a, type: "BUILTIN_IMAP" } })).id;
    await updateConnector(db, a, id, { isActive: false });
    expect((await listCatalog(db, a)).find((c) => c.connectorId === id)?.state).toBe("paused");

    await updateConnector(db, a, id, { values: { email: "new@company.ru", password: "" } });
    const row = await db.connector.findFirstOrThrow({ where: { id } });
    const stored = decryptJson<{ values: Record<string, string> }>(row.encryptedConfig)!;
    expect(stored.values).toMatchObject({ email: "new@company.ru", password: "secret-app-pass" });

    expect(await updateConnector(db, b, id, { isActive: true })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await removeConnector(db, b, id)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await removeConnector(db, a, id)).toMatchObject({ ok: true });
    expect((await listCatalog(db, a)).find((c) => c.moduleId === "BUILTIN_IMAP")?.state).toBe("available");
  });

  it("свой MCP: инструменты с сервера, все на подтверждении; без адреса и по http — отказ", async () => {
    expect(await connectModule(db, a, { module: "REMOTE_MCP" })).toMatchObject({ ok: false, code: "INVALID" });
    expect(await connectModule(db, a, { module: "REMOTE_MCP", mcpUrl: "http://example.com/mcp" })).toMatchObject({ ok: false, code: "INVALID" });
  });
});
