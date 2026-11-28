import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db/client";
import { resetLeaderToFirstRun } from "@/core/profile/reset";
import { seedTempLeader } from "./helpers/eval-env";

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);

describe.skipIf(!dbUp)("сброс руководителя до первого входа (Postgres)", () => {
  let a = "";
  let b = "";
  beforeAll(async () => {
    a = await seedTempLeader(db, "reset-a");
    b = await seedTempLeader(db, "reset-b");
    for (const id of [a, b]) {
      await db.leader.update({ where: { id }, data: { learningMode: false, trustedScopes: ["SALES"], budgetAutoLimit: 50000 } });
      await db.memory.create({ data: { leaderId: id, sourceType: "EDIT_LEARNING", ruleText: "Пиши короче.", isActive: true } });
      await db.rule.create({ data: { leaderId: id, name: "Орлов сразу", description: "d", condition: {}, action: "ASK_LEADER", source: "CHAT", isSystemLocked: false } });
      await db.decision.create({ data: { leaderId: id, type: "EMAIL_REPLY", title: "t", contextSummary: "c", gateReasons: [], aiRecommendation: "r", proposedPayload: {} } });
      await db.connector.create({ data: { leaderId: id, name: "Gmail", type: "BUILTIN_GMAIL", encryptedConfig: "", toolPermissions: {} } });
    }
  });
  afterAll(async () => {
    for (const id of [a, b]) if (id) await db.leader.delete({ where: { id } });
  });

  it("настройки, выученное, подключения и карточки сброшены; системные правила и профиль на месте", async () => {
    const lockedBefore = await db.rule.count({ where: { leaderId: a, OR: [{ isSystemLocked: true }, { source: "PROFILE_IMPORT" }] } });
    const connectorsBefore = await db.connector.count({ where: { leaderId: a } });
    expect(connectorsBefore).toBeGreaterThan(0);
    const report = await resetLeaderToFirstRun(db, a);
    expect(report.connectors).toBe(connectorsBefore);
    expect(report.decisions).toBeGreaterThanOrEqual(1);
    const l = await db.leader.findUniqueOrThrow({ where: { id: a } });
    expect(l).toMatchObject({ learningMode: true, trustedScopes: [], budgetAutoLimit: 0 });
    expect(await db.memory.count({ where: { leaderId: a } })).toBe(0);
    expect(await db.connector.count({ where: { leaderId: a } })).toBe(0);
    expect(await db.decision.count({ where: { leaderId: a } })).toBe(0);
    expect(await db.rule.count({ where: { leaderId: a, source: "CHAT" } })).toBe(0);
    expect(await db.rule.count({ where: { leaderId: a, OR: [{ isSystemLocked: true }, { source: "PROFILE_IMPORT" }] } })).toBe(lockedBefore);
    expect(await db.employee.count({ where: { leaderId: a } })).toBeGreaterThan(0);
  });

  it("другой руководитель не затронут", async () => {
    const l = await db.leader.findUniqueOrThrow({ where: { id: b } });
    expect(l).toMatchObject({ learningMode: false, trustedScopes: ["SALES"], budgetAutoLimit: 50000 });
    expect(await db.connector.count({ where: { leaderId: b } })).toBeGreaterThan(0);
    expect(await db.decision.count({ where: { leaderId: b } })).toBeGreaterThan(0);
    expect(await db.memory.count({ where: { leaderId: b } })).toBe(1);
  });
});
