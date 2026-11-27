import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedTempLeader } from "./helpers/eval-env";

vi.stubEnv("APP_CLOCK_MODE", "real");
vi.stubEnv("CONNECTOR_SECRET", "test-secret-test-secret-1234");
const { db } = await import("@/db/client");
const { clock } = await import("@/core/clock");
const { encryptJson } = await import("@/core/connectors/crypto");
const { GoogleCalendarClient, toRemoteEvent } = await import("@/core/calendar/google");
const { categorizeEvent } = await import("@/core/calendar/categorize");
const { syncCalendar, GCAL_PREFIX } = await import("@/core/calendar/sync");
const { cancelMeeting, moveMeeting, pushNewMeeting } = await import("@/core/calendar/write");
const { scheduleNextMeeting } = await import("@/core/meetings/next");

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);
const OWN = "boss@corp.example";
const iso = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

describe("Google Calendar: разбор событий", () => {
  it("событие на весь день, отменённое и без конца пропускаются", () => {
    expect(toRemoteEvent({ id: "a", start: { date: "2026-12-07" }, end: { date: "2026-12-08" } })).toBeNull();
    expect(toRemoteEvent({ id: "b", status: "cancelled", start: { dateTime: iso(1) }, end: { dateTime: iso(2) } })).toBeNull();
    expect(toRemoteEvent({ id: "c", start: { dateTime: iso(2) }, end: { dateTime: iso(1) } })).toBeNull();
  });

  it("участники без себя, ссылка на звонок, отклонённое приглашение", () => {
    const e = toRemoteEvent({
      id: "d",
      summary: " Синк ",
      hangoutLink: "https://meet.google.com/abc-defg-hij",
      start: { dateTime: iso(1) },
      end: { dateTime: iso(2) },
      attendees: [{ email: "Boss@corp.example", self: true, responseStatus: "declined" }, { email: "P02@Corp.example" }],
    });
    expect(e).toMatchObject({ id: "d", title: "Синк", attendees: ["p02@corp.example"], meetingUrl: "https://meet.google.com/abc-defg-hij", declined: true });
  });

  it("категория: внешние участники и деньги не становятся рабочими", () => {
    expect(categorizeEvent("Планёрка", ["a@corp.example"], OWN)).toBe("OPERATIONAL");
    expect(categorizeEvent("Планёрка", ["a@other.example"], OWN)).toBe("CLIENT");
    expect(categorizeEvent("Согласование бюджета", [], OWN)).toBe("MONEY");
    expect(categorizeEvent("1:1 с Ольгой", [], OWN)).toBe("ONE_ON_ONE");
    expect(categorizeEvent("Стратегическая сессия", [], OWN)).toBe("MANAGEMENT");
  });

  it("токен обновляется, права и ошибки превращаются в понятный текст", async () => {
    const calls: string[] = [];
    const saved: unknown[] = [];
    const f = (async (url: string) => {
      calls.push(String(url));
      if (String(url).includes("token")) return new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), { status: 200 });
      return new Response("{}", { status: 403 });
    }) as unknown as typeof fetch;
    const c = new GoogleCalendarClient({ tokens: { refresh_token: "r", expires_at: 1 }, tokenUrl: "https://t/token", clientId: "i", clientSecret: "s", saveTokens: async (t) => void saved.push(t), fetch: f });
    await expect(c.listEvents(new Date(), new Date())).rejects.toThrow(/нет нужных прав/);
    expect(calls[0]).toContain("token");
    expect(saved).toHaveLength(1);
  });
});

describe.skipIf(!dbUp)("Google Calendar: синхронизация и запись (Postgres)", () => {
  let leaderId = "";
  let otherId = "";
  let connectorId = "";

  const remote = (id: string, title: string, h: number, attendees: string[] = []) => ({
    id,
    title,
    start: new Date(Date.now() + h * 3_600_000),
    end: new Date(Date.now() + (h + 1) * 3_600_000),
    attendees,
    meetingUrl: null,
    declined: false,
  });
  const fake = (events: ReturnType<typeof remote>[]) => ({ listEvents: async () => events });
  const noLock = async () => async () => undefined;
  const writer = () => {
    const calls: string[] = [];
    return {
      calls,
      createEvent: async (e: { title: string; notify: boolean }) => (calls.push(`create:${e.title}:${e.notify}`), "g1"),
      moveEvent: async (id: string) => void calls.push(`move:${id}`),
      cancelEvent: async (id: string) => void calls.push(`cancel:${id}`),
    };
  };
  const setPerms = (p: Record<string, string>) => db.connector.update({ where: { id: connectorId }, data: { toolPermissions: p } });

  beforeAll(async () => {
    await clock.init();
    leaderId = await seedTempLeader(db, "gcal");
    otherId = await seedTempLeader(db, "gcal-other");
    await db.meeting.deleteMany({ where: { leaderId } });
    const row = await db.connector.create({
      data: {
        leaderId,
        name: "Google Календарь",
        type: "BUILTIN_GOOGLE_CALENDAR",
        encryptedConfig: encryptJson({ tokens: { access_token: "a", refresh_token: "r" }, account: OWN }),
        toolPermissions: { "calendar.read": "AUTO", "calendar.create_event": "AUTO", "calendar.update_event": "APPROVE" },
      },
    });
    connectorId = row.id;
  }, 60_000);
  afterAll(async () => {
    await db.leader.deleteMany({ where: { id: { in: [leaderId, otherId] } } });
    await db.$disconnect();
  });

  it("новые встречи создаются, изменения применяются, исчезнувшие убираются", async () => {
    const first = await syncCalendar(db, leaderId, connectorId, {
      client: fake([remote("e1", "Планёрка", 2, [OWN, "a@corp.example"]), remote("e2", "Звонок с клиентом", 3, ["x@other.example"])]),
      lock: noLock,
    });
    expect(first).toMatchObject({ ok: true, created: 2 });
    const m1 = await db.meeting.findFirstOrThrow({ where: { leaderId, externalId: `${GCAL_PREFIX}e1` } });
    expect(m1.participationMode).toBe("AVATAR"); // «Планёрка» без внешних участников
    expect((await db.meeting.findFirstOrThrow({ where: { leaderId, externalId: `${GCAL_PREFIX}e2` } })).category).toBe("CLIENT");

    // Руководитель сменил режим участия: повторная синхронизация его не сбрасывает.
    await db.meeting.update({ where: { id: m1.id }, data: { participationMode: "LEADER" } });
    const again = await syncCalendar(db, leaderId, connectorId, {
      client: fake([remote("e1", "Планёрка", 4, [OWN, "a@corp.example"])]),
      lock: noLock,
    });
    expect(again).toMatchObject({ ok: true, created: 0, updated: 1, removed: 1 });
    const after = await db.meeting.findFirstOrThrow({ where: { id: m1.id } });
    expect(after.participationMode).toBe("LEADER");
    expect(after.startAt.getTime()).toBeGreaterThan(m1.startAt.getTime());
    expect(await db.meeting.count({ where: { leaderId, externalId: `${GCAL_PREFIX}e2` } })).toBe(0);
    expect(await db.activityLog.count({ where: { leaderId, action: "CALENDAR_SYNCED" } })).toBe(2);
  });

  it("встреча с протоколом не стирается, даже если исчезла из календаря; отклонённые не попадают", async () => {
    await syncCalendar(db, leaderId, connectorId, { client: fake([remote("e3", "Ретро", 5)]), lock: noLock });
    await db.meeting.updateMany({ where: { leaderId, externalId: `${GCAL_PREFIX}e3` }, data: { protocolMarkdown: "# протокол" } });
    await syncCalendar(db, leaderId, connectorId, { client: fake([{ ...remote("e4", "Отказ", 6), declined: true }]), lock: noLock });
    expect(await db.meeting.count({ where: { leaderId, externalId: `${GCAL_PREFIX}e3` } })).toBe(1);
    expect(await db.meeting.count({ where: { leaderId, externalId: `${GCAL_PREFIX}e4` } })).toBe(0);
  });

  it("запрет чтения и чужой руководитель: ничего не синхронизируется", async () => {
    await setPerms({ "calendar.read": "DENY" });
    expect(await syncCalendar(db, leaderId, connectorId, { client: fake([remote("e5", "X", 1)]), lock: noLock })).toMatchObject({ ok: false, skipped: true });
    await setPerms({ "calendar.read": "AUTO", "calendar.create_event": "AUTO", "calendar.update_event": "APPROVE" });
    expect(await syncCalendar(db, otherId, connectorId, { client: fake([remote("e5", "X", 1)]), lock: noLock })).toMatchObject({ ok: false, skipped: true });
  });

  it("перенос и отмена всегда ждут руководителя; с его согласием уходят в Google", async () => {
    await syncCalendar(db, leaderId, connectorId, { client: fake([remote("e6", "Обзор продаж", 8, [OWN, "a@corp.example"])]), lock: noLock });
    const m = await db.meeting.findFirstOrThrow({ where: { leaderId, externalId: `${GCAL_PREFIX}e6` } });
    const w = writer();
    const start = new Date(m.startAt.getTime() + 86_400_000);
    const end = new Date(m.endAt.getTime() + 86_400_000);

    expect(await moveMeeting(db, leaderId, m.id, start, end, { client: w })).toMatchObject({ status: "approval" });
    expect(w.calls).toEqual([]);

    expect(await moveMeeting(db, leaderId, m.id, start, end, { client: w, approvedByLeader: true })).toMatchObject({ status: "done" });
    expect(w.calls).toEqual(["move:e6"]);
    expect((await db.meeting.findFirstOrThrow({ where: { id: m.id } })).startAt.getTime()).toBe(start.getTime());

    expect(await cancelMeeting(db, otherId, m.id, { client: w, approvedByLeader: true })).toMatchObject({ status: "skipped" }); // чужая встреча
    expect(await cancelMeeting(db, leaderId, m.id, { client: w, approvedByLeader: true })).toMatchObject({ status: "done" });
    expect(w.calls).toEqual(["move:e6", "cancel:e6"]);
    expect(await db.meeting.count({ where: { id: m.id } })).toBe(0);
  });

  it("запись: защищённый блок и внешние участники без руководителя не создаются; DENY блокирует совсем", async () => {
    const make = (title: string, attendees: string[]) =>
      db.meeting.create({ data: { leaderId, title, category: "OPERATIONAL", startAt: new Date(Date.now() + 9e7), endAt: new Date(Date.now() + 9.3e7), attendees } });
    const w = writer();

    // Режим обучения (SPEC 1.1): пока он включён, сама ничего наружу не создаю.
    const plain = await make("Разбор спринта", [OWN, "a@corp.example"]);
    expect(await pushNewMeeting(db, leaderId, plain.id, { client: w })).toMatchObject({ status: "approval" });
    await db.leader.update({ where: { id: leaderId }, data: { learningMode: false } });
    expect(await pushNewMeeting(db, leaderId, plain.id, { client: w })).toMatchObject({ status: "done", externalId: "g1" });
    expect(w.calls).toEqual(["create:Разбор спринта:true"]);
    expect((await db.meeting.findFirstOrThrow({ where: { id: plain.id } })).externalId).toBe(`${GCAL_PREFIX}g1`);

    const prot = await make("1:1 с Ольгой", [OWN]);
    expect(await pushNewMeeting(db, leaderId, prot.id, { client: w })).toMatchObject({ status: "approval" });
    const ext = await make("Встреча по поставке", ["x@other.example"]);
    expect(await pushNewMeeting(db, leaderId, ext.id, { client: w })).toMatchObject({ status: "approval" });
    expect(w.calls).toHaveLength(1);
    // Руководитель сам согласился: внешняя встреча уходит.
    expect(await pushNewMeeting(db, leaderId, ext.id, { client: w, approvedByLeader: true })).toMatchObject({ status: "done" });

    await setPerms({ "calendar.create_event": "DENY", "calendar.update_event": "APPROVE" });
    const denied = await make("Ещё одна", []);
    expect(await pushNewMeeting(db, leaderId, denied.id, { client: w, approvedByLeader: true })).toMatchObject({ status: "skipped" });
    await setPerms({ "calendar.read": "AUTO", "calendar.create_event": "AUTO", "calendar.update_event": "APPROVE" });
  });

  it("следующая встреча серии: без доступа к Google встреча остаётся у нас, причина в журнале", async () => {
    const a = await db.meeting.create({
      data: { leaderId, title: "Ретро проекта", category: "OPERATIONAL", startAt: new Date("2030-03-04T08:00:00Z"), endAt: new Date("2030-03-04T09:00:00Z"), attendees: ["p02@corp.example"] },
    });
    // У подключения нет рабочих токенов в тесте: запись в Google не удаётся, но встреча серии создана.
    await db.connector.update({ where: { id: connectorId }, data: { encryptedConfig: "" } });
    const r = await scheduleNextMeeting(db, leaderId, a.id);
    expect(r.status).toBe("created");
    expect(await db.activityLog.count({ where: { leaderId, action: "NEXT_MEETING_NOT_PUSHED" } })).toBe(1);
  });
});
