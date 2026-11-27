import "dotenv/config";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { seedTempLeader } from "./helpers/eval-env";

vi.stubEnv("APP_CLOCK_MODE", "real");
vi.stubEnv("CONNECTOR_SECRET", "test-secret-test-secret-1234");
vi.stubEnv("GOOGLE_CLIENT_ID", "");
vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
const { db } = await import("@/db/client");
const { deleteOAuthApp, loadOAuthAppByKey, oauthAppStatuses, saveOAuthApp } = await import("@/core/connectors/oauth-app");
const { listCatalog } = await import("@/core/connectors/service");
const { createMailConnector } = await import("@/core/mail/factory");
const { encryptJson } = await import("@/core/connectors/crypto");

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);
const ID = "123456789-abcdefghijk.apps.googleusercontent.com";
const SECRET = "GOCSPX-super-secret-value";

describe.skipIf(!dbUp)("ключи OAuth-приложения (Postgres)", () => {
  let leaderId = "";
  let saved: { key: string; encryptedValue: string } | null = null;

  beforeAll(async () => {
    leaderId = await seedTempLeader(db, "oauth-app");
    // Тест не должен стирать настоящие ключи разработчика: запоминаем и возвращаем.
    saved = await db.appSetting.findUnique({ where: { key: "oauth:google" } });
    await deleteOAuthApp(db, "google");
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await deleteOAuthApp(db, "google");
    if (saved) await db.appSetting.create({ data: saved });
    await db.leader.deleteMany({ where: { id: leaderId } });
  });

  it("секрет хранится зашифрованным и не попадает в статус", async () => {
    expect(await saveOAuthApp(db, { key: "google", clientId: ID, clientSecret: SECRET })).toEqual({ ok: true });
    const row = await db.appSetting.findUniqueOrThrow({ where: { key: "oauth:google" } });
    expect(row.encryptedValue).not.toContain(SECRET);
    expect(row.encryptedValue).not.toContain(ID);

    const status = await oauthAppStatuses(db);
    const g = status.find((s) => s.key === "google");
    expect(g).toMatchObject({ configured: true, source: "db" });
    expect(JSON.stringify(status)).not.toContain(SECRET);
    expect(await loadOAuthAppByKey(db, "google")).toMatchObject({ clientId: ID, clientSecret: SECRET, source: "db" });
  });

  it("пустой секрет при смене Client ID оставляет прежний; без секрета в первый раз — отказ", async () => {
    await deleteOAuthApp(db, "google");
    expect(await saveOAuthApp(db, { key: "google", clientId: ID })).toMatchObject({ ok: false });
    await saveOAuthApp(db, { key: "google", clientId: ID, clientSecret: SECRET });
    const newId = "987654321-zyxwvutsrqp.apps.googleusercontent.com";
    expect(await saveOAuthApp(db, { key: "google", clientId: newId })).toEqual({ ok: true });
    expect(await loadOAuthAppByKey(db, "google")).toMatchObject({ clientId: newId, clientSecret: SECRET });
  });

  it("Client ID Google проверяется по окончанию", async () => {
    expect(await saveOAuthApp(db, { key: "google", clientId: "not-a-google-client-id", clientSecret: SECRET })).toMatchObject({ ok: false });
  });

  it("каталог: без ключей Gmail «нужна настройка», с ключами — доступен для входа", async () => {
    await deleteOAuthApp(db, "google");
    expect((await listCatalog(db, leaderId)).find((c) => c.moduleId === "BUILTIN_GMAIL")?.state).toBe("needs_setup");
    await saveOAuthApp(db, { key: "google", clientId: ID, clientSecret: SECRET });
    expect((await listCatalog(db, leaderId)).find((c) => c.moduleId === "BUILTIN_GMAIL")?.state).toBe("available");
  });

  it("обновление токена Gmail берёт ключи из хранилища", async () => {
    await saveOAuthApp(db, { key: "google", clientId: ID, clientSecret: SECRET });
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: { body?: URLSearchParams }) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), { status: 200 });
    });
    const conn = createMailConnector(db, {
      id: "x",
      leaderId,
      type: "BUILTIN_GMAIL",
      encryptedConfig: encryptJson({ tokens: { refresh_token: "r", expires_at: 1 }, account: "me@example.com" }),
    });
    // verify() идёт за профилем: первый запрос — обновление токена, второй — профиль (ответ нам не важен).
    await conn?.verify().catch(() => {});
    const refresh = bodies[0] ?? "";
    expect(refresh).toContain("grant_type=refresh_token");
    expect(refresh).toContain(encodeURIComponent(ID));
    expect(refresh).toContain(encodeURIComponent(SECRET));
  });
});
