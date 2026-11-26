import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedTempLeader } from "./helpers/eval-env";

vi.stubEnv("APP_CLOCK_MODE", "real");
const { db } = await import("@/db/client");
const { clock } = await import("@/core/clock");
const { scheduleNextMeeting } = await import("@/core/meetings/next");

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);
const at = (s: string) => new Date(`${s}:00+03:00`);

describe.skipIf(!dbUp)("следующая встреча серии (Postgres)", () => {
  let leaderId = "";
  let otherId = "";
  const meet = (title: string, start: string, end: string, extra: object = {}) =>
    db.meeting.create({ data: { leaderId, title, category: "OPERATIONAL", startAt: at(start), endAt: at(end), attendees: ["p02@company.example"], ...extra } });

  beforeAll(async () => {
    await clock.init();
    leaderId = await seedTempLeader(db, "nm");
    otherId = await seedTempLeader(db, "nm-other");
    await db.meeting.deleteMany({ where: { leaderId } }); // чистый календарь
  }, 60_000);
  afterAll(async () => {
    await db.leader.deleteMany({ where: { id: { in: [leaderId, otherId] } } });
    await db.$disconnect();
  });

  it("то же время через неделю, участники и серия сохраняются", async () => {
    const a = await meet("Ретро проекта", "2026-12-08T11:00", "2026-12-08T12:00");
    const r = await scheduleNextMeeting(db, leaderId, a.id);
    expect(r.status).toBe("created");
    const next = await db.meeting.findFirstOrThrow({ where: { leaderId, title: "Ретро проекта", startAt: { gt: a.startAt } } });
    expect(next.startAt.toISOString()).toBe(at("2026-12-15T11:00").toISOString());
    expect(next.endAt.getTime() - next.startAt.getTime()).toBe(3_600_000);
    expect(next.previousMeetingId).toBe(a.id);
    expect(next.attendees).toEqual(["p02@company.example"]);
    expect(await db.activityLog.count({ where: { leaderId, action: "NEXT_MEETING_CREATED" } })).toBe(1);
    // повторный вызов не создаёт вторую
    expect((await scheduleNextMeeting(db, leaderId, a.id)).status).toBe("exists");
    expect(await db.meeting.count({ where: { leaderId, title: "Ретро проекта" } })).toBe(2);
  });

  it("занятый слот и выходные пропускаются", async () => {
    const a = await meet("Обзор продаж", "2026-12-11T15:00", "2026-12-11T16:00");
    await meet("Другое", "2026-12-18T15:30", "2026-12-18T16:30"); // пересекает пятницу 18-го
    const r = await scheduleNextMeeting(db, leaderId, a.id);
    expect(r.status).toBe("created");
    if (r.status === "created") expect(r.startAt.toISOString()).toBe(at("2026-12-21T15:00").toISOString()); // суббота и воскресенье пропущены
  });

  it("встреча про защищённый блок: шлюз не даёт создать сама, причина в журнале", async () => {
    const a = await meet("1:1 с Ольгой", "2026-12-09T10:00", "2026-12-09T10:30");
    const r = await scheduleNextMeeting(db, leaderId, a.id);
    expect(r).toMatchObject({ status: "skipped" });
    expect(await db.meeting.count({ where: { leaderId, title: "1:1 с Ольгой" } })).toBe(1);
    const log = await db.activityLog.findFirstOrThrow({ where: { leaderId, action: "NEXT_MEETING_SKIPPED" } });
    expect(log.reason).toContain("защищённый");
  });

  it("серия уже в календаре — ничего не создаём; чужая встреча недоступна", async () => {
    const a = await meet("Планёрка направления", "2026-12-08T09:00", "2026-12-08T09:15");
    await meet("Планёрка направления", "2026-12-09T09:00", "2026-12-09T09:15");
    expect((await scheduleNextMeeting(db, leaderId, a.id)).status).toBe("exists");
    expect(await scheduleNextMeeting(db, otherId, a.id)).toMatchObject({ status: "skipped", reason: "встреча не найдена" });
  });
});
