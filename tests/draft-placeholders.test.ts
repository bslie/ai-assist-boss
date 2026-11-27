import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findPlaceholders, splitPlaceholders } from "@/core/draft-placeholders";
import { seedTempLeader } from "./helpers/eval-env";

describe("пропуски в черновике", () => {
  it("находит «[срок]» и не путает с чекбоксами, ссылками и обычным текстом", () => {
    expect(findPlaceholders("Ответ в [срок].")).toEqual(["[срок]"]);
    expect(findPlaceholders("Пришлю до [дата], бюджет [сумма]; ещё раз [дата]")).toEqual(["[дата]", "[сумма]"]);
    expect(findPlaceholders("- [x] готово\n- [ ] в работе")).toEqual([]);
    expect(findPlaceholders("см. [сайт](https://example.com)")).toEqual([]);
    expect(findPlaceholders("Ответ в пятницу.")).toEqual([]);
    expect(findPlaceholders(null)).toEqual([]);
  });

  it("делит текст так, что склейка возвращает исходник", () => {
    const text = "Здравствуйте. Ответ в [срок]. Спасибо.";
    const parts = splitPlaceholders(text);
    expect(parts.map((p) => p.text).join("")).toBe(text);
    expect(parts.filter((p) => p.gap).map((p) => p.text)).toEqual(["[срок]"]);
  });
});

vi.stubEnv("APP_CLOCK_MODE", "real");
const { db } = await import("@/db/client");
const { clock } = await import("@/core/clock");
const { resolveDecision } = await import("@/core/decisions");

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);

describe.skipIf(!dbUp)("resolveDecision: письмо с пропуском не утверждается", () => {
  let leaderId = "";

  beforeAll(async () => {
    await clock.init();
    leaderId = await seedTempLeader(db, "gap");
  }, 60_000);

  afterAll(async () => {
    await db.leader.deleteMany({ where: { id: leaderId } });
    await db.$disconnect();
  });

  const make = (draftText: string) =>
    db.decision.create({
      data: { leaderId, type: "EMAIL_REPLY", title: "Тест", contextSummary: "", gateReasons: [], aiRecommendation: "", proposedPayload: {}, draftText },
    });

  it("APPROVE с «[срок]» → DRAFT_INCOMPLETE, карточка остаётся в очереди", async () => {
    const d = await make("Здравствуйте. Ответ в [срок].");
    const res = await resolveDecision(db, leaderId, d.id, { action: "APPROVE" });
    expect(res).toMatchObject({ ok: false, code: "DRAFT_INCOMPLETE" });
    expect((await db.decision.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("PENDING");
  });

  it("правка с пропуском тоже отклоняется, заполненная — проходит", async () => {
    const d = await make("Здравствуйте. Ответ в [срок].");
    expect(await resolveDecision(db, leaderId, d.id, { action: "EDITED_APPROVED", editedText: "Ответ в [срок]" })).toMatchObject({ ok: false, code: "DRAFT_INCOMPLETE" });
    expect(await resolveDecision(db, leaderId, d.id, { action: "EDITED_APPROVED", editedText: "Здравствуйте. Ответ в пятницу." })).toEqual({ ok: true, status: "EDITED_APPROVED" });
  });

  it("«Не сейчас» и передача исполнителю не требуют заполнять пропуск", async () => {
    const d = await make("Ответ в [срок].");
    expect(await resolveDecision(db, leaderId, d.id, { action: "SNOOZE" })).toEqual({ ok: true, status: "SNOOZED" });
  });
});
