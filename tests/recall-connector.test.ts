import "dotenv/config";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { seedTempLeader } from "./helpers/eval-env";

vi.stubEnv("APP_CLOCK_MODE", "real");
vi.stubEnv("CONNECTOR_SECRET", "test-secret-test-secret-1234");
// Recall настраивается только в подключении: переменные окружения не должны ничего подменять.
vi.stubEnv("RECALL_API_KEY", "env-key-must-be-ignored");
vi.stubEnv("RECALL_PRICE_RUB_PER_HOUR", "999");
const { db } = await import("@/db/client");
const { connectModule, updateConnector } = await import("@/core/connectors/service");
const { verifyConnectorCredentials, parsePricePerHour } = await import("@/core/connectors/verify");
const { loadRecallAuth } = await import("@/core/meetings/recall");

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);
const good = { apiKey: "k", region: "eu-central-1", appUrl: "https://boss.example.test/" };

describe("проверка доступов Recall", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("принимает рабочий ключ и ходит в свой регион", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", f);
    await expect(verifyConnectorCredentials("BUILTIN_RECALL", good)).resolves.toBeUndefined();
    expect(String(f.mock.calls[0]?.[0])).toContain("eu-central-1.recall.ai");
  });

  it("не принятый ключ — понятная ошибка с регионом", async () => {
    vi.stubGlobal("fetch", async () => new Response("no", { status: 401 }));
    await expect(verifyConnectorCredentials("BUILTIN_RECALL", good)).rejects.toThrow(/eu-central-1/);
  });

  it("неверный регион, адрес и цена отсекаются до запроса в сеть", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await expect(verifyConnectorCredentials("BUILTIN_RECALL", { ...good, region: "mars" })).rejects.toThrow(/Регион/);
    await expect(verifyConnectorCredentials("BUILTIN_RECALL", { ...good, appUrl: "boss" })).rejects.toThrow(/Адрес приложения/);
    await expect(verifyConnectorCredentials("BUILTIN_RECALL", { ...good, pricePerHourRub: "много" })).rejects.toThrow(/Цена/);
    expect(f).not.toHaveBeenCalled();
  });

  it("цена часа: пусто и мусор → 0, запятая допустима", () => {
    expect(parsePricePerHour(undefined)).toBe(0);
    expect(parsePricePerHour("abc")).toBe(0);
    expect(parsePricePerHour("35,5")).toBe(35.5);
  });
});

describe.skipIf(!dbUp)("подключение Recall (Postgres)", () => {
  let leaderId = "";
  beforeAll(async () => {
    leaderId = await seedTempLeader(db, "recall-conn");
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.leader.deleteMany({ where: { id: leaderId } });
  });

  it("без подключения Recall недоступен, даже если ключ есть в окружении", async () => {
    expect(await loadRecallAuth(db, leaderId)).toBeNull();
  });

  it("настройки берутся из подключения; цена необязательна; ключ проверяется при сохранении", async () => {
    vi.stubGlobal("fetch", async () => new Response("no", { status: 401 }));
    expect(await connectModule(db, leaderId, { module: "BUILTIN_RECALL", values: good })).toMatchObject({ ok: false, code: "INVALID" });

    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    const res = await connectModule(db, leaderId, { module: "BUILTIN_RECALL", values: good });
    if (!res.ok) throw new Error(res.message);
    expect(await loadRecallAuth(db, leaderId)).toMatchObject({ apiKey: "k", region: "eu-central-1", appUrl: "https://boss.example.test", pricePerHourRub: 0 });

    expect(await updateConnector(db, leaderId, res.value.id, { values: { pricePerHourRub: "60" } })).toMatchObject({ ok: true });
    expect((await loadRecallAuth(db, leaderId))?.pricePerHourRub).toBe(60);
    // Очистка необязательного поля убирает цену, обязательное поле очистить нельзя.
    expect(await updateConnector(db, leaderId, res.value.id, { values: { pricePerHourRub: "" } })).toMatchObject({ ok: true });
    expect((await loadRecallAuth(db, leaderId))?.pricePerHourRub).toBe(0);
    expect(await updateConnector(db, leaderId, res.value.id, { values: { appUrl: "" } })).toMatchObject({ ok: false, code: "INVALID" });
  });
});
