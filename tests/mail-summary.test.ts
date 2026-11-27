import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedTempLeader } from "./helpers/eval-env";
import { scriptedLlm } from "./helpers/scripted-llm";

vi.stubEnv("APP_CLOCK_MODE", "real");
vi.stubEnv("CONNECTOR_SECRET", "test-secret-test-secret-1234");
const { db } = await import("@/db/client");
const { clock } = await import("@/core/clock");
const { handleChat, buildChatContext } = await import("@/core/chat");
const { getMailStatus, mailContext, describeActions } = await import("@/core/mail/summary");
const { encryptJson } = await import("@/core/connectors/crypto");

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);

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

  it("«проверь почту» без ящика: агент зовёт mail.check_now и видит, что подключить", async () => {
    const f = scriptedLlm([{ call: { tool: "mail.check_now" } }, { answer: "Почта не подключена, подключите Gmail." }]);
    const r = await handleChat(db, f.llm, leaderId, "Проверь мою почту");
    expect(r.text).toBe("Почта не подключена, подключите Gmail.");
    expect(f.calls[1].prompt).toContain("РЕЗУЛЬТАТЫ ИНСТРУМЕНТОВ");
    expect(f.calls[1].prompt).toContain("Почта не подключена");
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
