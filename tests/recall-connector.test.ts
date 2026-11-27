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
const { verifyConnectorCredentials } = await import("@/core/connectors/verify");
const { loadRecallAuth, rememberOrigin } = await import("@/core/meetings/recall");
const { parseRecallPricing, recallHourPriceRub, resetRecallPriceCache } = await import("@/core/meetings/recall-price");
const { requestOrigin } = await import("@/lib/origin");

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);
const good = { apiKey: "k", region: "eu-central-1" };

describe("проверка доступов Recall", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("принимает рабочий ключ и ходит в свой регион", async () => {
    const f = vi.fn(async (_url: string) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", f);
    await expect(verifyConnectorCredentials("BUILTIN_RECALL", good)).resolves.toBeUndefined();
    expect(String(f.mock.calls[0]?.[0])).toContain("eu-central-1.recall.ai");
  });

  it("не принятый ключ — понятная ошибка с регионом", async () => {
    vi.stubGlobal("fetch", async () => new Response("no", { status: 401 }));
    await expect(verifyConnectorCredentials("BUILTIN_RECALL", good)).rejects.toThrow(/eu-central-1/);
  });

  it("регион вне списка отсекается до запроса в сеть", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await expect(verifyConnectorCredentials("BUILTIN_RECALL", { ...good, region: "mars" })).rejects.toThrow(/Регион/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("адрес приложения берётся из запроса", () => {
  it("за прокси — из X-Forwarded-*, иначе из самого запроса", () => {
    expect(requestOrigin(new Request("http://127.0.0.1:3000/api/x", { headers: { "x-forwarded-proto": "https", "x-forwarded-host": "boss.example.test" } }))).toBe("https://boss.example.test");
    expect(requestOrigin(new Request("http://localhost:3000/api/x"))).toBe("http://localhost:3000");
    expect(requestOrigin(new Request("http://localhost:3000/api/x", { headers: { "x-forwarded-proto": "javascript" } }))).toBeUndefined();
    // Прокси без X-Forwarded-Proto: для публичного имени считаем https, иначе Google вернёт redirect_uri_mismatch.
    expect(requestOrigin(new Request("http://bench.example.test/api/x", { headers: { host: "bench.example.test" } }))).toBe("https://bench.example.test");
    expect(requestOrigin(new Request("http://10.0.0.5:3000/api/x"))).toBe("http://10.0.0.5:3000");
    expect(requestOrigin(new Request("http://bench.example.test/api/x", { headers: { "x-forwarded-proto": "http" } }))).toBe("http://bench.example.test");
  });
});

describe("цена часа бота с прайса recall.ai", () => {
  const html = '<div class="pricing-text">$0.50/hr of recording</div><p>Or, use our built-in transcription for $0.15/h</p>';
  const cbr = JSON.stringify({ Valute: { USD: { Value: 80, Nominal: 1 } } });
  const okFetch = (page: string, rates: string) => async (url: string) => ({ ok: true, text: async () => (url.includes("recall.ai") ? page : rates) });

  afterEach(() => resetRecallPriceCache());

  it("разбирает запись и транскрипцию; другая вёрстка — null", () => {
    expect(parseRecallPricing(html)).toEqual({ botUsdPerHour: 0.5, transcriptUsdPerHour: 0.15 });
    expect(parseRecallPricing("<p>Contact sales</p>")).toBeNull();
  });

  it("(запись + транскрипция) × курс ЦБ, с кэшем", async () => {
    const f = vi.fn(okFetch(html, cbr));
    expect(await recallHourPriceRub(1_000, f)).toBe(52);
    expect(await recallHourPriceRub(2_000, f)).toBe(52);
    expect(f).toHaveBeenCalledTimes(2); // страница и курс один раз
  });

  it("не удалось получить цену — 0, а при кэше — прошлое значение", async () => {
    expect(await recallHourPriceRub(1_000, okFetch("<p>нет цен</p>", cbr))).toBe(0);
    resetRecallPriceCache();
    expect(await recallHourPriceRub(1_000, okFetch(html, cbr))).toBe(52);
    const broken = async () => {
      throw new Error("offline");
    };
    expect(await recallHourPriceRub(1_000 + 13 * 3_600_000, broken)).toBe(52);
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

  it("ключ проверяется при сохранении, адрес приложения пишется из запроса и обновляется при входе на встречу", async () => {
    vi.stubGlobal("fetch", async () => new Response("no", { status: 401 }));
    expect(await connectModule(db, leaderId, { module: "BUILTIN_RECALL", values: good }, { origin: "https://boss.example.test" })).toMatchObject({ ok: false, code: "INVALID" });

    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    const res = await connectModule(db, leaderId, { module: "BUILTIN_RECALL", values: good }, { origin: "https://boss.example.test" });
    if (!res.ok) throw new Error(res.message);
    expect(await loadRecallAuth(db, leaderId)).toMatchObject({ apiKey: "k", region: "eu-central-1", appUrl: "https://boss.example.test" });

    await rememberOrigin(db, leaderId, "https://new.example.test");
    expect((await loadRecallAuth(db, leaderId))?.appUrl).toBe("https://new.example.test");
    expect(await updateConnector(db, leaderId, res.value.id, { values: { region: "us-east-1" } }, { origin: "https://third.example.test" })).toMatchObject({ ok: true });
    expect(await loadRecallAuth(db, leaderId)).toMatchObject({ region: "us-east-1", appUrl: "https://third.example.test" });
    expect(await updateConnector(db, leaderId, res.value.id, { values: { region: "" } })).toMatchObject({ ok: false, code: "INVALID" });
  });
});
