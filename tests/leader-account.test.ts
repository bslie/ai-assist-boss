import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmptyLeader, leaderOwnerLogin, leaderTakenMessage } from "@/core/auth/leader-account";
import { db } from "@/db/client";
import { seedTempLeader } from "./helpers/eval-env";

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);

describe.skipIf(!dbUp)("один кабинет — одна учётная запись руководителя (Postgres)", () => {
  const tag = Date.now().toString(36);
  let shared = "";
  let fresh = "";
  beforeAll(async () => {
    shared = await seedTempLeader(db, "acct-shared");
    await db.appUser.create({ data: { login: `owner-${tag}`, displayName: "Владелец", role: "LEADER", leaderId: shared, passwordHash: "x" } });
  });
  afterAll(async () => {
    await db.appUser.deleteMany({ where: { login: { endsWith: tag } } });
    if (shared) await db.leader.delete({ where: { id: shared } });
    if (fresh) await db.leader.delete({ where: { id: fresh } });
  });

  it("занятый руководитель называет владельца, свободный отдаёт null", async () => {
    expect(await leaderOwnerLogin(db, shared)).toBe(`owner-${tag}`);
    expect(leaderTakenMessage(`owner-${tag}`)).toContain("свой кабинет");
    fresh = (await createEmptyLeader(db, { displayName: `Новый ${tag}`, login: `new-${tag}` })).id;
    expect(await leaderOwnerLogin(db, fresh)).toBeNull();
  });

  it("новый руководитель пуст: ни подключений, ни писем, ни карточек, ни сотрудников", async () => {
    const [connectors, emails, decisions, employees, rules] = await Promise.all([
      db.connector.count({ where: { leaderId: fresh } }),
      db.emailItem.count({ where: { leaderId: fresh } }),
      db.decision.count({ where: { leaderId: fresh } }),
      db.employee.count({ where: { leaderId: fresh } }),
      db.rule.count({ where: { leaderId: fresh } }),
    ]);
    expect([connectors, emails, decisions, employees, rules]).toEqual([0, 0, 0, 0, 0]);
  });

  it("повторное создание с тем же именем не падает на slug", async () => {
    const again = await createEmptyLeader(db, { displayName: `Новый ${tag}`, login: `new2-${tag}` });
    expect(again.id).not.toBe(fresh);
    await db.leader.delete({ where: { id: again.id } });
  });
});
