import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmptyLeader } from "@/core/auth/leader-account";
import { deleteLeader } from "@/core/profile/delete";
import { db } from "@/db/client";
import { ensureDatasetBase } from "@/db/dataset-base";

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);

describe.skipIf(!dbUp)("датасет и удаление руководителя (Postgres)", () => {
  const tag = Date.now().toString(36);
  let leaderId = "";
  beforeAll(async () => {
    leaderId = (await createEmptyLeader(db, { displayName: `Датасет ${tag}`, login: `ds-${tag}` })).id;
  });
  afterAll(async () => {
    await db.appUser.deleteMany({ where: { login: { endsWith: tag } } });
    await db.leader.deleteMany({ where: { id: leaderId } });
  });

  it("новый руководитель получает оргструктуру, календарь и поручения исполнителям", async () => {
    const r = await ensureDatasetBase(db, leaderId);
    expect(r.employees).toBeGreaterThan(0);
    expect(r.meetingsAdded).toBeGreaterThan(0);
    expect(r.tasksAdded).toBeGreaterThan(0);
    expect(await db.employee.count({ where: { leaderId } })).toBe(r.employees);
    expect(await db.meeting.count({ where: { leaderId } })).toBe(r.meetingsAdded);
    expect(await db.task.count({ where: { leaderId, sourceType: "DATASET" } })).toBe(r.tasksAdded);
    expect(await db.task.count({ where: { leaderId, assigneeId: { not: null } } })).toBeGreaterThan(0);
  });

  it("повторная загрузка ничего не дублирует и не стирает протоколы и ход задач", async () => {
    const meeting = await db.meeting.findFirstOrThrow({ where: { leaderId } });
    await db.meeting.update({ where: { id: meeting.id }, data: { isProtocolApproved: true } });
    const task = await db.task.findFirstOrThrow({ where: { leaderId, sourceType: "DATASET" } });
    await db.task.update({ where: { id: task.id }, data: { status: "DONE" } });
    const before = { e: await db.employee.count({ where: { leaderId } }), m: await db.meeting.count({ where: { leaderId } }), t: await db.task.count({ where: { leaderId } }) };
    const again = await ensureDatasetBase(db, leaderId);
    expect(again.meetingsAdded + again.tasksAdded).toBe(0);
    expect({ e: await db.employee.count({ where: { leaderId } }), m: await db.meeting.count({ where: { leaderId } }), t: await db.task.count({ where: { leaderId } }) }).toEqual(before);
    expect((await db.meeting.findUniqueOrThrow({ where: { id: meeting.id } })).isProtocolApproved).toBe(true);
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("DONE");
  });

  it("удаление руководителя уносит его данные и учётные записи-руководители, администратор остаётся", async () => {
    await db.appUser.create({ data: { login: `lead-${tag}`, displayName: "Рук", role: "LEADER", leaderId, passwordHash: "x" } });
    await db.appUser.create({ data: { login: `adm-${tag}`, displayName: "Адм", role: "ADMIN", leaderId, passwordHash: "x" } });
    const other = await createEmptyLeader(db, { displayName: `Чужой ${tag}`, login: `other-${tag}` });
    await ensureDatasetBase(db, other.id);
    const res = await deleteLeader(db, leaderId);
    expect(res.accountsDeleted).toBe(1);
    expect(await db.leader.count({ where: { id: leaderId } })).toBe(0);
    expect(await db.employee.count({ where: { leaderId } })).toBe(0);
    expect(await db.task.count({ where: { leaderId } })).toBe(0);
    expect(await db.appUser.count({ where: { login: `lead-${tag}` } })).toBe(0);
    expect((await db.appUser.findFirstOrThrow({ where: { login: `adm-${tag}` } })).leaderId).toBeNull();
    // Другой руководитель не затронут.
    expect(await db.employee.count({ where: { leaderId: other.id } })).toBeGreaterThan(0);
    await db.leader.delete({ where: { id: other.id } });
  });
});
