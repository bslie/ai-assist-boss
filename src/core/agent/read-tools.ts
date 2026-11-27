/**
 * Инструменты чтения для агента чата. Только данные своего руководителя (всё по leaderId), только чтение:
 * ничего не отправляют и не меняют. Ответы короткие: цикл всё равно обрезает их до лимита.
 */
import { z } from "zod";
import { clock } from "../clock";
import { buildDecisionCards, getToday } from "../dashboard";
import { checkMailNow } from "../mail/check";
import { getMailStatus, mailContext } from "../mail/summary";
import type { ReadTool } from "./types";

const TZ = "Europe/Moscow";
const DAY = 86_400_000;
const msk = (d: Date) => new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(d);
const snippet = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
const norm = (s: string) => s.toLowerCase().replaceAll("ё", "е");

const EmailAction = z.enum(["ASK_LEADER", "DIGEST", "DELEGATE", "IGNORE", "AUTO"]);
const TaskStatus = z.enum(["NEW", "ACCEPTED", "IN_PROGRESS", "REVIEW", "RETURNED", "READY_FOR_LEADER", "DONE", "ESCALATED"]);
/** Дата ISO (ГГГГ-ММ-ДД) в Москве. */
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "дата вида 2026-12-08");
const startOfDayMsk = (iso: string) => new Date(`${iso}T00:00:00+03:00`);

const MailSearchArgs = z.object({
  query: z.string().max(100).optional().describe("слово или фраза в теме, тексте или имени отправителя"),
  sender: z.string().max(100).optional().describe("часть имени или адреса отправителя"),
  action: EmailAction.optional().describe("ASK_LEADER ждёт руководителя, DIGEST в сводке, DELEGATE передано, IGNORE рассылка, AUTO решено само"),
  days: z.number().int().min(1).max(30).optional().describe("за сколько последних дней, по умолчанию 7"),
  limit: z.number().int().min(1).max(15).optional(),
});
const mailSearch: ReadTool<typeof MailSearchArgs> = {
  kind: "read",
  name: "mail.search",
  description: "Найти разобранные письма за последние дни: по слову в теме или тексте, по отправителю, по тому, что с письмом сделано. Для вопросов «что пришло от…», «есть ли письма про…».",
  args: MailSearchArgs,
  async run({ db, leaderId }, a: z.infer<typeof MailSearchArgs>) {
    const since = new Date(clock.now().getTime() - (a.days ?? 7) * DAY);
    const rows = await db.emailItem.findMany({
      where: {
        leaderId,
        receivedAt: { gte: since },
        ...(a.action ? { action: a.action } : {}),
        AND: [
          ...(a.sender ? [{ OR: [{ senderName: { contains: a.sender, mode: "insensitive" as const } }, { senderEmail: { contains: a.sender, mode: "insensitive" as const } }] }] : []),
          ...(a.query ? [{ OR: [{ subject: { contains: a.query, mode: "insensitive" as const } }, { body: { contains: a.query, mode: "insensitive" as const } }, { senderName: { contains: a.query, mode: "insensitive" as const } }] }] : []),
        ],
      },
      orderBy: { receivedAt: "desc" },
      take: a.limit ?? 8,
      select: { id: true, senderName: true, senderEmail: true, subject: true, body: true, receivedAt: true, category: true, action: true, extracted: true },
    });
    return {
      found: rows.length,
      emails: rows.map((r) => ({
        id: r.id,
        received: msk(r.receivedAt),
        from: `${r.senderName} <${r.senderEmail}>`,
        subject: r.subject,
        category: r.category,
        action: r.action,
        text: snippet(r.body, 240),
      })),
    };
  },
};

const MeetingsArgs = z.object({
  from: Day.optional().describe("с какой даты, по умолчанию сегодня"),
  to: Day.optional().describe("по какую дату включительно, по умолчанию +7 дней"),
  query: z.string().max(100).optional().describe("слово в названии"),
  limit: z.number().int().min(1).max(20).optional(),
});
const meetingsList: ReadTool<typeof MeetingsArgs> = {
  kind: "read",
  name: "meetings.list",
  description: "Встречи из календаря за период: время, название, кто участвует (руководитель, аватар или письменный статус), есть ли протокол. Для «что на этой неделе», «когда планёрка».",
  args: MeetingsArgs,
  async run({ db, leaderId }, a) {
    const today = clock.now();
    const from = a.from ? startOfDayMsk(a.from) : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - 3 * 3_600_000);
    const to = a.to ? new Date(startOfDayMsk(a.to).getTime() + DAY) : new Date(from.getTime() + 7 * DAY);
    const rows = await db.meeting.findMany({
      where: { leaderId, startAt: { gte: from, lt: to }, ...(a.query ? { title: { contains: a.query, mode: "insensitive" } } : {}) },
      orderBy: { startAt: "asc" },
      take: a.limit ?? 12,
      select: { id: true, title: true, startAt: true, endAt: true, participationMode: true, protocolReadyAt: true, isProtocolApproved: true, meetingUrl: true },
    });
    return {
      found: rows.length,
      meetings: rows.map((m) => ({
        id: m.id,
        when: `${msk(m.startAt)} – ${msk(m.endAt).split(", ").pop()}`,
        title: m.title,
        mode: m.participationMode === "AVATAR" ? "аватар" : m.participationMode === "ASYNC_STATUS" ? "письменный статус" : "сам руководитель",
        protocol: m.isProtocolApproved ? "утверждён" : m.protocolReadyAt ? "ждёт утверждения" : "нет",
        hasLink: Boolean(m.meetingUrl),
      })),
    };
  },
};

const MeetingGetArgs = z.object({ id: z.string().min(1).max(64).describe("id встречи из meetings.list") });
const meetingGet: ReadTool<typeof MeetingGetArgs> = {
  kind: "read",
  name: "meetings.get",
  description: "Протокол конкретной встречи (если есть) и вопросы, которые аватар готовил по прошлому протоколу.",
  args: MeetingGetArgs,
  async run({ db, leaderId }, a) {
    const m = await db.meeting.findFirst({ where: { id: a.id, leaderId }, select: { title: true, startAt: true, protocolMarkdown: true, agendaQuestions: true, isProtocolApproved: true } });
    if (!m) return { error: "встреча не найдена" };
    return { title: m.title, when: msk(m.startAt), approved: m.isProtocolApproved, protocol: m.protocolMarkdown ? snippet(m.protocolMarkdown, 2500) : null, agendaQuestions: m.agendaQuestions };
  },
};

const TasksArgs = z.object({
  status: TaskStatus.optional(),
  assignee: z.string().max(80).optional().describe("часть имени сотрудника"),
  overdue: z.boolean().optional().describe("только просроченные"),
  open: z.boolean().optional().describe("только не закрытые"),
  limit: z.number().int().min(1).max(20).optional(),
});
const tasksList: ReadTool<typeof TasksArgs> = {
  kind: "read",
  name: "tasks.list",
  description: "Задачи сотрудников: название, исполнитель, срок, статус, просрочена ли. Для «что просрочено», «что у Смирновой», «что ждёт моей приёмки» (READY_FOR_LEADER).",
  args: TasksArgs,
  async run({ db, leaderId }, a) {
    const now = clock.now();
    const rows = await db.task.findMany({
      where: {
        leaderId,
        ...(a.status ? { status: a.status } : {}),
        ...(a.open ? { status: { not: "DONE" as const } } : {}),
        ...(a.overdue ? { dueAt: { lt: now }, status: { not: "DONE" as const } } : {}),
        ...(a.assignee ? { assignee: { name: { contains: a.assignee, mode: "insensitive" as const } } } : {}),
      },
      orderBy: { dueAt: "asc" },
      take: a.limit ?? 10,
      select: { id: true, title: true, status: true, dueAt: true, assignee: { select: { name: true } } },
    });
    return {
      found: rows.length,
      tasks: rows.map((t) => ({ id: t.id, title: t.title, assignee: t.assignee?.name ?? "без исполнителя", due: msk(t.dueAt), overdue: t.status !== "DONE" && t.dueAt < now, status: t.status })),
    };
  },
};

const decisionsList: ReadTool<z.ZodObject<Record<string, never>>> = {
  kind: "read",
  name: "decisions.list",
  description: "Карточки, которые ждут решения руководителя: от кого, суть, рекомендация. Для «что ждёт меня», «что срочное».",
  args: z.object({}),
  async run({ db, leaderId }) {
    const pending = await db.decision.findMany({ where: { leaderId, status: "PENDING" }, orderBy: { createdAt: "asc" }, take: 15 });
    const cards = await buildDecisionCards(db, leaderId, pending);
    return { found: cards.length, decisions: cards.map((c) => ({ id: c.id, tag: c.tag, from: c.from, title: c.title, summary: snippet(c.summary, 200), recommendation: c.recommendation })) };
  },
};

const EmployeesArgs = z.object({ query: z.string().max(80).optional().describe("часть имени, должности или зоны ответственности") });
const employeesFind: ReadTool<typeof EmployeesArgs> = {
  kind: "read",
  name: "employees.find",
  description: "Сотрудники и контакты руководителя: имя, должность, кому подчиняется, за что отвечает. Для «кто занимается КП», «кто такая Павлова».",
  args: EmployeesArgs,
  async run({ db, leaderId }, a) {
    const all = await db.employee.findMany({ where: { leaderId }, orderBy: { name: "asc" }, select: { name: true, position: true, relationType: true, responsibilityArea: true } });
    const q = a.query ? norm(a.query) : null;
    const rows = q ? all.filter((e) => [e.name, e.position, e.responsibilityArea ?? ""].some((v) => norm(v).includes(q.slice(0, Math.max(3, q.length - 2))))) : all;
    const rel = { SUBORDINATE: "подчинённый", MANAGER: "руководитель", PEER: "коллега" } as Record<string, string>;
    return { found: rows.length, employees: rows.slice(0, 15).map((e) => ({ name: e.name, position: e.position, relation: rel[e.relationType] ?? e.relationType, area: e.responsibilityArea })) };
  },
};

const rulesList: ReadTool<z.ZodObject<Record<string, never>>> = {
  kind: "read",
  name: "rules.list",
  description: "Правила разбора почты и выученные правила стиля. Для «какие у меня правила», «как ты обрабатываешь вендоров».",
  args: z.object({}),
  async run({ db, leaderId }) {
    const [rules, memories] = await Promise.all([
      db.rule.findMany({ where: { leaderId }, select: { name: true, action: true }, take: 40 }),
      db.memory.findMany({ where: { leaderId, isActive: true }, select: { ruleText: true }, take: 30 }),
    ]);
    return { mailRules: rules.map((r) => `${r.name} → ${r.action}`), styleRules: memories.map((m) => m.ruleText) };
  },
};

const metricsSummary: ReadTool<z.ZodObject<Record<string, never>>> = {
  kind: "read",
  name: "metrics.summary",
  description: "Сводные цифры: сколько времени освободила, доля писем без руководителя, задачи, время до протокола, стоимость запросов.",
  args: z.object({}),
  async run({ db, leaderId }) {
    const t = await getToday(db, leaderId);
    return { headline: t.headline, metrics: t.metrics };
  },
};

const mailStatus: ReadTool<z.ZodObject<Record<string, never>>> = {
  kind: "read",
  name: "mail.status",
  description: "Какие ящики подключены, когда последний раз проверялись, сколько писем разобрано за 3 дня. Не обращается к почте.",
  args: z.object({}),
  async run({ db, leaderId }) {
    return { lines: mailContext(await getMailStatus(db, leaderId, clock.now())) };
  },
};

const mailCheck: ReadTool<z.ZodObject<Record<string, never>>> = {
  kind: "read",
  name: "mail.check_now",
  description: "Проверить подключённую почту прямо сейчас: забрать новые письма и разобрать их по правилам. Вызывай, когда просят «проверь почту» или нужны самые свежие письма. Идёт долго.",
  args: z.object({}),
  async run({ db, leaderId }) {
    return { result: await checkMailNow(db, leaderId) };
  },
};

export const READ_TOOLS: ReadTool[] = [mailSearch, mailStatus, mailCheck, meetingsList, meetingGet, tasksList, decisionsList, employeesFind, rulesList, metricsSummary] as ReadTool[];
