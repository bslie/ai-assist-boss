import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LlmClient, MemoryCache, type LlmProvider } from "@/core/llm";
import type { MailConnector, OutgoingReply } from "@/core/mail/types";
import { seedTempLeader } from "./helpers/eval-env";

vi.stubEnv("APP_CLOCK_MODE", "real");
const { db } = await import("@/db/client");
const { clock } = await import("@/core/clock");
const { resolveDecision } = await import("@/core/decisions");
const { generateProtocolDecision, renderProtocol, ProtocolSchema } = await import("@/core/meetings/protocol");
const { executeApprovedProtocol } = await import("@/core/meetings/approve");
const { buildAgendaQuestions, buildAvatarScript } = await import("@/core/meetings/agenda");
const { defaultParticipation } = await import("@/core/meetings/participation");

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);

const TRANSCRIPT = "Иван Петров: начинаем. Ольга Смирнова: отправлю КП клиенту до 12 декабря. Дмитрий Козлов: креативы пришлю, срок не назвал.";

const PROTOCOL = {
  notes: [{ topic: "КП для клиента", points: ["Условия согласованы с финансами"] }],
  decisions: ["КП уходит клиенту до 12 декабря"],
  assignments: [
    { task: "Отправить КП клиенту", assigneeName: "Ольга Смирнова", dueDate: "2026-12-12", criteria: "Клиент получил КП, подтверждение на почте" },
    { task: "Прислать креативы кампании", assigneeName: "Дмитрий Козлов", dueDate: null, criteria: "Креативы отправлены на согласование" },
    { task: "Согласовать договор", assigneeName: "Внешний Подрядчик", dueDate: "2026-12-15", criteria: "Договор согласован" },
  ],
};

function fakeLlm() {
  let calls = 0;
  const provider: LlmProvider = {
    name: "fake",
    model: "fake",
    async generate() {
      calls++;
      return { object: PROTOCOL, promptTokens: 1, completionTokens: 1 };
    },
  };
  return { llm: new LlmClient({ provider, cache: new MemoryCache() }), calls: () => calls };
}

function fakeMail() {
  const sent: OutgoingReply[] = [];
  const c: MailConnector = {
    verify: async () => {},
    listNew: async () => ({ emails: [], cursor: "" }),
    send: async (r) => void sent.push(r),
    archive: async () => {},
  };
  return { c, sent };
}

describe("формат протокола и сценарий аватара", () => {
  it("renderProtocol даёт три раздела SPEC и таблицу поручений", () => {
    const md = renderProtocol({
      title: "Планёрка",
      startAt: new Date("2026-12-07T07:00:00Z"),
      endAt: new Date("2026-12-07T07:30:00Z"),
      meetingUrl: null,
      participants: ["Ольга Смирнова"],
      data: ProtocolSchema.parse(PROTOCOL),
    });
    expect(md).toContain("## Информация о встрече");
    expect(md).toContain("## Заметки о встрече");
    expect(md).toContain("## Поручения");
    expect(md).toContain("| Задача | Исполнитель | Срок | Критерий готовности |");
    expect(md).toContain("срок не назван");
  });

  it("аватар представляется «ИИ-помощник <имя>» и зачитывает все вопросы", () => {
    const lines = buildAvatarScript({
      leaderName: "Иван Петров",
      meetingTitle: "Планёрка",
      questions: [{ question: "Как дела с КП?", assigneeName: null, taskId: null }],
    });
    expect(lines[0]).toContain("ИИ-помощник Иван Петров");
    expect(lines.some((l) => l.includes("Как дела с КП?"))).toBe(true);
  });

  it("участие по умолчанию: планёрка — аватар, статус — письменный, остальное и защищённые блоки — руководитель", () => {
    expect(defaultParticipation("OPERATIONAL", "Планёрка направления")).toBe("AVATAR");
    expect(defaultParticipation("OPERATIONAL", "Статус продаж SMB")).toBe("ASYNC_STATUS");
    expect(defaultParticipation("MONEY", "Согласование КП")).toBe("LEADER");
    expect(defaultParticipation("OPERATIONAL", "Планёрка: Стратегия", ["Стратегия"])).toBe("LEADER");
  });
});

describe.skipIf(!dbUp)("протокол встречи: от транскрипта до поручений", () => {
  let leaderId = "";
  let otherId = "";
  let meetingId = "";

  beforeAll(async () => {
    await clock.init();
    leaderId = await seedTempLeader(db, "meet");
    otherId = await seedTempLeader(db, "meet-other");
    meetingId = (await db.meeting.findFirstOrThrow({ where: { leaderId, title: "Планёрка направления" }, orderBy: { startAt: "asc" } })).id;
  });
  afterAll(async () => {
    await db.leader.deleteMany({ where: { id: { in: [leaderId, otherId].filter(Boolean) } } });
    await db.$disconnect();
  });

  it("сидер сохраняет участников, режим и серию встреч", async () => {
    const ms = await db.meeting.findMany({ where: { leaderId, title: "Планёрка направления" }, orderBy: { startAt: "asc" } });
    expect(ms[0].previousMeetingId).toBeNull();
    expect(ms[1].previousMeetingId).toBe(ms[0].id);
    expect(ms[0].participationMode).toBe("AVATAR");
    expect((ms[0].attendees as string[]).length).toBeGreaterThan(3);
  });

  it("транскрипт → одна карточка MEETING_PROTOCOL; повтор не плодит карточки; поручения ещё не созданы", async () => {
    const { llm, calls } = fakeLlm();
    const res = await generateProtocolDecision({ db, llm, examples: [] }, leaderId, meetingId, TRANSCRIPT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const d = await db.decision.findUniqueOrThrow({ where: { id: res.decisionId } });
    expect(d.type).toBe("MEETING_PROTOCOL");
    expect(d.status).toBe("PENDING");
    expect(d.draftText).toContain("Отправить КП клиенту");
    expect(d.aiRecommendation).toContain("срок не назван");
    expect((await db.meeting.findUniqueOrThrow({ where: { id: meetingId } })).protocolReadyAt).not.toBeNull();
    expect(await db.task.count({ where: { leaderId, sourceType: "MEETING" } })).toBe(0);

    const again = await generateProtocolDecision({ db, llm, examples: [] }, leaderId, meetingId, TRANSCRIPT);
    expect(again.ok).toBe(false);
    expect(await db.decision.count({ where: { leaderId, type: "MEETING_PROTOCOL" } })).toBe(1);
    expect(calls()).toBe(1);
  });

  it("чужой руководитель не может собрать протокол по нашей встрече", async () => {
    const { llm } = fakeLlm();
    const res = await generateProtocolDecision({ db, llm, examples: [] }, otherId, meetingId, TRANSCRIPT);
    expect(res).toEqual({ ok: false, reason: "Встреча не найдена" });
  });

  it("до утверждения ничего наружу не уходит; после — задачи и одна рассылка, повтор ничего не дублирует", async () => {
    const d = await db.decision.findFirstOrThrow({ where: { leaderId, type: "MEETING_PROTOCOL" } });
    const mail = fakeMail();
    expect(await executeApprovedProtocol(db, leaderId, d.id, { connector: mail.c })).toMatchObject({ applicable: false });
    expect(mail.sent).toHaveLength(0);

    const r = await resolveDecision(db, leaderId, d.id, { action: "EDITED_APPROVED", editedText: "# Правленый протокол\nТекст" });
    expect(r.ok).toBe(true);
    const exec = await executeApprovedProtocol(db, leaderId, d.id, { connector: mail.c });
    // resolveDecision уже исполнил протокол без почты (подключения нет), поэтому повтор — «уже разослан».
    expect(exec).toMatchObject({ applicable: false });

    const tasks = await db.task.findMany({ where: { leaderId, sourceType: "MEETING" }, include: { assignee: true } });
    expect(tasks).toHaveLength(3);
    const olga = tasks.find((t) => t.title === "Отправить КП клиенту")!;
    expect(olga.assignee?.name).toBe("Ольга Смирнова");
    expect(olga.dueAt.toISOString()).toBe("2026-12-12T15:00:00.000Z");
    // Срок не назван → неделя от конца встречи, а не выдуманная дата.
    const noDue = tasks.find((t) => t.title === "Прислать креативы кампании")!;
    const meeting = await db.meeting.findUniqueOrThrow({ where: { id: meetingId } });
    expect(noDue.dueAt.getTime() - meeting.endAt.getTime()).toBe(7 * 86_400_000);
    // Исполнитель не из команды → задача остаётся без исполнителя.
    expect(tasks.find((t) => t.title === "Согласовать договор")!.assigneeId).toBeNull();

    expect(meeting.isProtocolApproved).toBe(true);
    expect(meeting.protocolMarkdown).toContain("Правленый протокол");
    const logs = await db.activityLog.findMany({ where: { leaderId, action: "PROTOCOL_APPROVED" } });
    expect(logs).toHaveLength(1);
    expect(logs[0].savedMinutes).toBe(30);
  });

  it("рассылка: протокол уходит каждому участнику с подписью ИИ-помощника, сбой одного адреса не рвёт остальные", async () => {
    const m2 = await db.meeting.findFirstOrThrow({ where: { leaderId, title: "Планёрка направления", isProtocolApproved: false }, orderBy: { startAt: "asc" } });
    const { llm } = fakeLlm();
    const res = await generateProtocolDecision({ db, llm, examples: [] }, leaderId, m2.id, TRANSCRIPT + " ещё один раз");
    if (!res.ok) throw new Error(res.reason);
    await db.decision.update({ where: { id: res.decisionId }, data: { status: "APPROVED" } });
    const mail = fakeMail();
    const flaky: MailConnector = { ...mail.c, send: async (r) => (r.to.startsWith("p03@") ? Promise.reject(new Error("boom")) : mail.c.send(r)) };
    const out = await executeApprovedProtocol(db, leaderId, res.decisionId, { connector: flaky });
    const n = (m2.attendees as string[]).length;
    expect(out).toMatchObject({ applicable: true, mailsSent: n - 1, mailsFailed: 1 });
    expect(mail.sent).toHaveLength(n - 1);
    expect(mail.sent[0].subject).toContain("Протокол встречи");
    expect(mail.sent[0].text).toContain("ИИ-помощник");
    expect(await db.activityLog.count({ where: { leaderId, action: "PROTOCOL_MAIL_FAILED" } })).toBe(1);
  });

  it("вопросы следующей планёрки берутся из незакрытых поручений утверждённого протокола", async () => {
    const next = await db.meeting.findFirstOrThrow({ where: { leaderId, previousMeetingId: meetingId } });
    const qs = await buildAgendaQuestions(db, leaderId, next.id);
    expect(qs.length).toBe(3);
    expect(qs.some((q) => q.question.includes("Отправить КП клиенту") && q.assigneeName === "Ольга Смирнова")).toBe(true);
    expect(await buildAgendaQuestions(db, otherId, next.id)).toEqual([]);

    // Закрытое поручение в вопросы не попадает.
    await db.task.updateMany({ where: { leaderId, title: "Отправить КП клиенту" }, data: { status: "DONE" } });
    const after = await buildAgendaQuestions(db, leaderId, next.id);
    expect(after.some((q) => q.question.includes("Отправить КП клиенту"))).toBe(false);
  });

  it("первая встреча серии без протокола: вопросы по открытым задачам участников, просроченные первыми", async () => {
    const first = await db.meeting.findFirstOrThrow({ where: { leaderId, title: "Планёрка направления", previousMeetingId: null } });
    const qs = await buildAgendaQuestions(db, leaderId, first.id);
    expect(qs.length).toBeGreaterThan(0);
    expect(qs.length).toBeLessThanOrEqual(5);
    expect(qs[0].question).toContain("Срок уже прошёл");
  });

  it("«только исполнителям»: протокол уходит лишь тем, у кого есть поручение и адрес в команде", async () => {
    const m3 = await db.meeting.findFirstOrThrow({ where: { leaderId, title: "Планёрка направления", isProtocolApproved: false }, orderBy: { startAt: "asc" } });
    const { llm } = fakeLlm();
    const res = await generateProtocolDecision({ db, llm, examples: [] }, leaderId, m3.id, TRANSCRIPT + " третий раз");
    if (!res.ok) throw new Error(res.reason);
    await db.decision.update({ where: { id: res.decisionId }, data: { status: "APPROVED" } });
    const mail = fakeMail();
    const out = await executeApprovedProtocol(db, leaderId, res.decisionId, { connector: mail.c, recipients: "IN_PROTOCOL" });
    const team = await db.employee.findMany({ where: { leaderId, name: { in: ["Ольга Смирнова", "Дмитрий Козлов"] } } });
    expect(out).toMatchObject({ applicable: true, mailsSent: 2 });
    expect(mail.sent.map((m) => m.to).sort()).toEqual(team.map((e) => e.email.toLowerCase()).sort());
    expect((m3.attendees as string[]).length).toBeGreaterThan(2);
  });

  it("итоги по прошлым поручениям: в протоколе «было → станет», после утверждения задачи обновлены", async () => {
    const m4 = await db.meeting.findFirstOrThrow({ where: { leaderId, title: "Планёрка направления", isProtocolApproved: false }, orderBy: { startAt: "asc" } });
    const qs = await buildAgendaQuestions(db, leaderId, m4.id);
    expect(qs.map((q) => q.question.match(/«(.+?)»/)?.[1])).toEqual(["Отправить КП клиенту", "Согласовать договор", "Прислать креативы кампании"]);
    await db.meeting.update({ where: { id: m4.id }, data: { agendaQuestions: qs } });

    let prompt = "";
    const provider: LlmProvider = {
      name: "fake",
      model: "fake",
      async generate(req) {
        prompt = req.prompt;
        return {
          object: {
            ...PROTOCOL,
            assignments: [],
            previousUpdates: [
              { ref: "P1", outcome: "DONE", comment: "КП отправлено", newTitle: null, newDueDate: null },
              { ref: "P3", outcome: "CHANGED", comment: "Нужны только баннеры", newTitle: "Прислать баннеры кампании", newDueDate: "2026-12-20" },
              { ref: "P9", outcome: "DONE", comment: "выдумка", newTitle: null, newDueDate: null },
            ],
          },
          promptTokens: 1,
          completionTokens: 1,
        };
      },
    };
    const llm = new LlmClient({ provider, cache: new MemoryCache() });
    const res = await generateProtocolDecision({ db, llm, examples: [] }, leaderId, m4.id, TRANSCRIPT + " четвёртый раз");
    if (!res.ok) throw new Error(res.reason);
    expect(prompt).toContain("P1: «Отправить КП клиенту»");

    const d = await db.decision.findUniqueOrThrow({ where: { id: res.decisionId } });
    expect(d.draftText).toContain("## Прошлые поручения");
    expect(d.draftText).toContain("формулировка → «Прислать баннеры кампании»");
    expect(d.aiRecommendation).toContain("выполнено 1, задача изменилась 1");
    // Неизвестная метка P9 отброшена: ничего не обновляем вслепую.
    expect(((d.proposedPayload as { args: { previousUpdates: unknown[] } }).args.previousUpdates)).toHaveLength(2);

    const ids = Object.fromEntries(qs.map((q) => [q.question.match(/«(.+?)»/)![1], q.taskId!]));
    expect(await db.task.findUniqueOrThrow({ where: { id: ids["Отправить КП клиенту"] } })).toMatchObject({ status: "NEW" });

    await resolveDecision(db, leaderId, d.id, { action: "APPROVE", protocolRecipients: "IN_PROTOCOL" });
    const kp = await db.task.findUniqueOrThrow({ where: { id: ids["Отправить КП клиенту"] } });
    expect(kp.status).toBe("DONE");
    const banners = await db.task.findUniqueOrThrow({ where: { id: ids["Прислать креативы кампании"] } });
    expect(banners.title).toBe("Прислать баннеры кампании");
    expect(banners.dueAt.toISOString()).toBe("2026-12-20T15:00:00.000Z");
    expect(banners.rescheduleCount).toBe(1);
    expect(banners.description).toContain("задача изменилась. Нужны только баннеры");
    const contract = await db.task.findUniqueOrThrow({ where: { id: ids["Согласовать договор"] } });
    expect(contract.status).toBe("NEW");
    expect(await db.activityLog.count({ where: { leaderId, action: { startsWith: "TASK_PROTOCOL_" } } })).toBe(2);
  });
});
