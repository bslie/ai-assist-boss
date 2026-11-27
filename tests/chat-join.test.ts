import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedTempLeader } from "./helpers/eval-env";
import { scriptedLlm } from "./helpers/scripted-llm";

vi.stubEnv("APP_CLOCK_MODE", "real");
vi.stubEnv("RECALL_API_KEY", "");
const { db } = await import("@/db/client");
const { clock } = await import("@/core/clock");
const { handleChat } = await import("@/core/chat");
const { joinByLink } = await import("@/core/meetings/recall");

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);

const ZOOM = "https://us02web.zoom.us/j/123456789?pwd=abc";

describe.skipIf(!dbUp)("чат: зайти на встречу по ссылке (Postgres)", () => {
  let leaderId = "";

  beforeAll(async () => {
    await clock.init();
    leaderId = await seedTempLeader(db, "chat-join");
    // Календарь датасета сдвинут к «сейчас»: для предсказуемого теста оставляем только свои встречи.
    await db.meeting.deleteMany({ where: { leaderId } });
  });
  afterAll(async () => {
    await db.leader.deleteMany({ where: { id: leaderId } });
  });

  const mk = (title: string, fromMin: number, lenMin = 30) =>
    db.meeting.create({
      data: { leaderId, title, category: "OPERATIONAL", startAt: new Date(clock.now().getTime() + fromMin * 60_000), endAt: new Date(clock.now().getTime() + (fromMin + lenMin) * 60_000), attendees: [] },
    });

  it("Телемост: бот не заходит, объясняем путь через транскрипт, действия нет", async () => {
    const f = scriptedLlm([{ actions: [{ tool: "meeting.join", args: { url: "https://telemost.yandex.ru/j/123" } }] }]);
    const r = await handleChat(db, f.llm, leaderId, "Зайди на встречу https://telemost.yandex.ru/j/123");
    expect(r.actions).toBeUndefined();
    expect(r.text).toContain("транскрипт");
  });

  it("встреча по ссылке: сразу пытается зайти; несколько подходящих — спрашивает; Recall не подключён — отказ текстом", async () => {
    const f = scriptedLlm([{ actions: [{ tool: "meeting.join", args: { url: ZOOM } }] }]);
    const none = await handleChat(db, f.llm, leaderId, `Подключись к встрече ${ZOOM}`);
    expect(none.actions).toBeUndefined(); // кнопки нет
    expect(none.text).toMatch(/Не получилось/); // Recall в тесте не подключён: бот не запущен, причина названа
    expect(await db.meeting.count({ where: { leaderId } })).toBe(0); // разовая встреча не осталась

    await mk("Планёрка А", 10);
    const one = await handleChat(db, f.llm, leaderId, `зайди на встречу ${ZOOM}`);
    expect(one.text).toMatch(/Не получилось/);

    await mk("Планёрка Б", 20);
    const two = await handleChat(db, f.llm, leaderId, `зайди на встречу ${ZOOM}`);
    expect(two.actions).toBeUndefined();
    expect(two.text).toContain("Планёрка А");
  });

  it("ссылка без просьбы зайти: модель отвечает словами, действия нет", async () => {
    const f = scriptedLlm([{ answer: "Это ссылка на Zoom." }]);
    const r = await handleChat(db, f.llm, leaderId, `что это за ссылка ${ZOOM}`);
    expect(r.text).toBe("Это ссылка на Zoom.");
    expect(r.actions).toBeUndefined();
  });

  it("разовая встреча не остаётся, если бот не запустился (Recall не подключён)", async () => {
    const before = await db.meeting.count({ where: { leaderId } });
    const res = await joinByLink(db, leaderId, { url: ZOOM });
    expect(res.status).toBe("skipped");
    expect(await db.meeting.count({ where: { leaderId } })).toBe(before);
    expect((await joinByLink(db, leaderId, { url: "https://telemost.yandex.ru/j/1" })).status).toBe("rejected");
  });
});
