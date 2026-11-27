import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedTempLeader } from "./helpers/eval-env";

vi.stubEnv("APP_CLOCK_MODE", "real");
const { db } = await import("@/db/client");
const { diffProfile, ProfileDraftSchema, ruleLabel } = await import("@/core/profile");

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);
const draft = ProfileDraftSchema.parse(JSON.parse(readFileSync(path.resolve("data/tz_dataset/leader_profile.draft.json"), "utf8")));

describe("имя правила для людей", () => {
  it("технический ключ заменяется описанием, русское имя остаётся", () => {
    expect(ruleLabel({ name: "money", description: "Деньги только с вами" })).toBe("Деньги только с вами");
    expect(ruleLabel({ name: "client_commitment", description: "Обязательства клиентам" })).toBe("Обязательства клиентам");
    expect(ruleLabel({ name: "Кадры", description: "Найм и отпуска" })).toBe("Кадры");
  });
});

describe.skipIf(!dbUp)("diff профиля по смыслу", () => {
  let leaderId = "";
  beforeAll(async () => {
    leaderId = await seedTempLeader(db, "profile-diff");
  });
  afterAll(async () => {
    if (leaderId) await db.leader.delete({ where: { id: leaderId } });
    await db.$disconnect();
  });

  it("тот же профиль с другими формулировками имён — правила и рутины без изменений", async () => {
    const renamed = {
      ...draft,
      neverWithoutApproval: draft.neverWithoutApproval.map((r) => ({ ...r, name: r.category.toLowerCase() })),
      allowed: draft.allowed.map((r, i) => ({ ...r, name: `rule_${i}` })),
    };
    const d = await diffProfile(db, leaderId, renamed);
    expect(d.rules).toEqual({ added: [], removed: [] });
    expect(d.routines.removed).toEqual([]);
    expect(d.goals).toEqual({ added: [], removed: [] });
  });

  it("убранное правило видно как удалённое, новое по смыслу — как добавленное", async () => {
    const [dropped, ...rest] = draft.allowed;
    const d = await diffProfile(db, leaderId, {
      ...draft,
      allowed: [...rest, { name: "newsletter_digest", description: "Рассылки в сводку", category: "NEWSLETTER", action: "DIGEST", delegateToArea: null }],
    });
    expect(d.rules.removed).toEqual([dropped.name]);
    expect(d.rules.added).toEqual(["Рассылки в сводку"]);
  });
});
