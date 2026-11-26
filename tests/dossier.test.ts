import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Messenger } from "@/core/telegram/types";
import { seedTempLeader } from "./helpers/eval-env";

vi.stubEnv("APP_CLOCK_MODE", "real");
const { db } = await import("@/db/client");
const { clock } = await import("@/core/clock");
const { buildDossier, dueDossiers, sendDossier } = await import("@/core/meetings/dossier");
const { handleStart, leaderBindSecret } = await import("@/core/telegram/bindings");

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);

describe.skipIf(!dbUp)("досье перед встречей (Postgres)", () => {
  let leaderId = "";
  let otherId = "";
  let slug = "";
  const sent: string[] = [];
  const m: Messenger = {
    async send(_c, text) {
      sent.push(text);
      return { messageId: String(sent.length) };
    },
    async edit() {},
  };
  const now = () => clock.now();

  beforeAll(async () => {
    await clock.init();
    leaderId = await seedTempLeader(db, "dos");
    otherId = await seedTempLeader(db, "dos-other");
    slug = (await db.leader.findUniqueOrThrow({ where: { id: leaderId } })).slug;
    await db.meeting.deleteMany({ where: { leaderId } });
  }, 60_000);
  afterAll(async () => {
    await db.leader.deleteMany({ where: { id: { in: [leaderId, otherId] } } });
    await db.$disconnect();
  });

  it("берёт только 1:1 и партнёров, стартующих в ближайшие 15 минут", async () => {
    const mk = (title: string, category: string, inMin: number) =>
      db.meeting.create({ data: { leaderId, title, category, startAt: new Date(now().getTime() + inMin * 60_000), endAt: new Date(now().getTime() + (inMin + 30) * 60_000), attendees: ["p02@company.example"] } });
    const one = await mk("1:1 с Ольгой", "ONE_ON_ONE", 10);
    await mk("Планёрка", "OPERATIONAL", 10);
    await mk("1:1 позже", "ONE_ON_ONE", 40);
    await mk("Партнёр уже идёт", "PARTNER", -5);
    const due = await dueDossiers(db);
    expect(due.filter((d) => d.leaderId === leaderId).map((d) => d.id)).toEqual([one.id]);
  });

  it("досье: просрочки, открытые задачи, последние письма участника; без чата не отмечается", async () => {
    const meeting = await db.meeting.findFirstOrThrow({ where: { leaderId, title: "1:1 с Ольгой" } });
    const olga = await db.employee.findFirstOrThrow({ where: { leaderId, email: "p02@company.example" } });
    await db.task.deleteMany({ where: { leaderId } });
    await db.task.create({ data: { leaderId, assigneeId: olga.id, title: "Прогноз декабря", description: "", acceptanceCriteria: "x", sourceType: "CHAT", dueAt: new Date(now().getTime() - 86_400_000), status: "IN_PROGRESS" } });
    await db.task.create({ data: { leaderId, assigneeId: olga.id, title: "КП для клиента", description: "", acceptanceCriteria: "x", sourceType: "CHAT", dueAt: new Date(now().getTime() + 3 * 86_400_000), status: "ACCEPTED" } });
    await db.task.create({ data: { leaderId, assigneeId: olga.id, title: "Закрытая", description: "", acceptanceCriteria: "x", sourceType: "CHAT", dueAt: new Date(now().getTime() + 86_400_000), status: "DONE" } });
    await db.emailItem.create({ data: { leaderId, externalId: "dos1", threadKey: "dos1", senderName: "Ольга Смирнова", senderEmail: "p02@company.example", subject: "Прогноз выполнения плана", body: "b", receivedAt: new Date(now().getTime() - 3_600_000) } });

    const text = (await buildDossier(db, leaderId, meeting.id))!;
    expect(text).toContain("Досье перед встречей");
    expect(text).toContain("Ольга Смирнова");
    expect(text).toMatch(/Просрочено[\s\S]*Прогноз декабря/);
    expect(text).toMatch(/Открытые задачи[\s\S]*КП для клиента/);
    expect(text).not.toContain("Закрытая");
    expect(text).toContain("Прогноз выполнения плана");

    expect(await sendDossier(db, m, leaderId, meeting.id)).toBe("no_chat");
    expect(await db.activityLog.count({ where: { leaderId, action: "DOSSIER_SENT" } })).toBe(0);
  });

  it("с чатом уходит один раз; чужой руководитель досье не получает", async () => {
    const meeting = await db.meeting.findFirstOrThrow({ where: { leaderId, title: "1:1 с Ольгой" } });
    await handleStart(db, `dos-${leaderId.slice(-6)}`, `${slug}:${leaderBindSecret(slug, "test-bind-key")}`, "test-bind-key");
    expect(await sendDossier(db, m, leaderId, meeting.id)).toBe("sent");
    expect(sent.at(-1)).toContain("1:1 с Ольгой");
    expect(await sendDossier(db, m, leaderId, meeting.id)).toBe("skipped");
    expect(await dueDossiers(db)).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: meeting.id })]));
    expect(await buildDossier(db, otherId, meeting.id)).toBeNull();
  });
});
