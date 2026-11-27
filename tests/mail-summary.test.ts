import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LlmClient, MemoryCache, type LlmProvider } from "@/core/llm";
import { seedTempLeader } from "./helpers/eval-env";

vi.stubEnv("APP_CLOCK_MODE", "real");
vi.stubEnv("CONNECTOR_SECRET", "test-secret-test-secret-1234");
const { db } = await import("@/db/client");
const { clock } = await import("@/core/clock");
const { handleChat, buildChatContext } = await import("@/core/chat");
const { getMailStatus, mailContext, describeActions } = await import("@/core/mail/summary");
const { encryptJson } = await import("@/core/connectors/crypto");

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);

/** «Проверь почту» разбирается кодом: модель в этом пути не вызывается. */
function failingLlm() {
  let calls = 0;
  const provider: LlmProvider = {
    name: "fake",
    model: "m",
    async generate() {
      calls++;
      throw new Error("LLM не должна вызываться");
    },
  };
  return { llm: new LlmClient({ provider, cache: new MemoryCache() }), calls: () => calls };
}

describe("описание действий над письмами", () => {
  it("человеческие подписи, нули пропускаются", () => {
    expect(describeActions({ ASK_LEADER: 2, DIGEST: 5, IGNORE: 0 })).toBe("2 — ждут вашего решения; 5 — ушли в сводку");
  });
});

describe.skipIf(!dbUp)("почта в чате (Postgres)", () => {
  let leaderId = "";
  beforeAll(async () => {
    await clock.init();
    leaderId = await seedTempLeader(db, "mail-summary");
    await db.emailItem.deleteMany({ where: { leaderId } });
    await db.connector.deleteMany({ where: { leaderId, type: { in: ["BUILTIN_GMAIL", "BUILTIN_IMAP", "BUILTIN_GRAPH"] } } });
  });
  afterAll(async () => {
    await db.leader.deleteMany({ where: { id: leaderId } });
  });

  it("без ящика «проверь почту» объясняет, что подключить, и не зовёт модель", async () => {
    const f = failingLlm();
    const r = await handleChat(db, f.llm, leaderId, "Проверь мою почту");
    expect(r.text).toContain("Почта не подключена");
    expect(f.calls()).toBe(0);
    expect(mailContext(await getMailStatus(db, leaderId, clock.now()))[0]).toContain("ни один ящик не подключён");
  });

  it("с ящиком контекст знает итог последней проверки и разобранные письма", async () => {
    const at = clock.now();
    await db.connector.create({
      data: {
        leaderId,
        name: "Gmail",
        type: "BUILTIN_GMAIL",
        encryptedConfig: encryptJson({ account: "boss@example.com", tokens: { refresh_token: "r" }, lastSync: { at: at.toISOString(), fetched: 3 } }),
        toolPermissions: {},
      },
    });
    await db.emailItem.create({
      data: { leaderId, externalId: "g1", threadKey: "k1", senderName: "Иван", senderEmail: "i@example.com", subject: "Договор на подпись", body: "…", receivedAt: new Date(at.getTime() - 3_600_000), category: "MONEY", action: "ASK_LEADER" },
    });
    const ctx = (await buildChatContext(db, leaderId)).split("\n").join(" | ");
    expect(ctx).toContain("boss@example.com");
    expect(ctx).toContain("новых писем тогда: 3");
    expect(ctx).toContain("Договор на подпись");
    expect(ctx).toContain("ждут вашего решения");
  });
});
