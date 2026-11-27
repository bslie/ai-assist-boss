/**
 * Протокол встречи из транскрипта (SPEC 4.5.1). LLM возвращает структуру (zod), markdown собирает код:
 * формат протокола не зависит от настроения модели. Карточка Decision MEETING_PROTOCOL уходит руководителю;
 * рассылка и поручения выполняются только после «Утвердить» (см. approve.ts).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { clock } from "../clock";
import { publishEvent } from "../events";
import { activeMemoryRules } from "../learning/draft";
import type { LlmClient } from "../llm";
import { AgendaSchema, buildAgendaQuestions } from "./agenda";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const ProtocolSchema = z.object({
  notes: z.array(z.object({ topic: z.string().min(1), points: z.array(z.string().min(1)).min(1) })).max(12),
  decisions: z.array(z.string().min(1)).max(20),
  assignments: z
    .array(
      z.object({
        task: z.string().min(3),
        assigneeName: z.string().min(1),
        /** YYYY-MM-DD; null, если срок на встрече не назван (не выдумываем). */
        dueDate: z.string().regex(ISO_DATE).nullable(),
        criteria: z.string().min(3),
      }),
    )
    .max(20),
  /**
   * Итог по прошлым поручениям, о которых спрашивали на встрече (типовые сценарии заказчика):
   * выполнено / в работе / не решено / задача изменилась. `ref` — метка из списка открытых поручений (P1, P2…).
   */
  previousUpdates: z
    .array(
      z.object({
        ref: z.string().regex(/^P\d{1,2}$/),
        outcome: z.enum(["DONE", "IN_PROGRESS", "NOT_RESOLVED", "CHANGED"]),
        comment: z.string(),
        /** Новая формулировка, только если на встрече задачу переформулировали. */
        newTitle: z.string().min(3).nullable(),
        /** Новый срок YYYY-MM-DD, только если его назвали. */
        newDueDate: z.string().regex(ISO_DATE).nullable(),
      }),
    )
    .max(20)
    .default([]),
});
export type ProtocolData = z.infer<typeof ProtocolSchema>;

/** Открытое прошлое поручение, о котором шла речь на встрече: метка для LLM и текущие значения для «было → станет». */
export interface OpenItem {
  ref: string;
  taskId: string;
  title: string;
  assigneeName: string | null;
  dueAt: Date;
}

export const OUTCOME_LABEL: Record<ProtocolData["previousUpdates"][number]["outcome"], string> = {
  DONE: "выполнено",
  IN_PROGRESS: "в работе",
  NOT_RESOLVED: "не решено",
  CHANGED: "задача изменилась",
};

/** Обновления, привязанные к реальным задачам: неизвестные метки и дубли отбрасываются. */
// type, а не interface: значение кладётся в Json-поле Prisma.
export type ResolvedUpdate = {
  taskId: string;
  title: string;
  assigneeName: string | null;
  outcome: ProtocolData["previousUpdates"][number]["outcome"];
  comment: string;
  newTitle: string | null;
  newDueDate: string | null;
  oldDueDate: string;
};

const isoDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(d);

export function resolveUpdates(updates: ProtocolData["previousUpdates"], open: readonly OpenItem[]): ResolvedUpdate[] {
  const byRef = new Map(open.map((o) => [o.ref, o]));
  const seen = new Set<string>();
  const out: ResolvedUpdate[] = [];
  for (const u of updates) {
    const item = byRef.get(u.ref);
    if (!item || seen.has(item.taskId)) continue;
    seen.add(item.taskId);
    const newTitle = u.newTitle && u.newTitle.trim() !== item.title ? u.newTitle.trim() : null;
    const newDueDate = u.newDueDate && u.newDueDate !== isoDay(item.dueAt) ? u.newDueDate : null;
    out.push({ taskId: item.taskId, title: item.title, assigneeName: item.assigneeName, outcome: u.outcome, comment: u.comment.trim(), newTitle, newDueDate, oldDueDate: isoDay(item.dueAt) });
  }
  return out;
}

export interface ProtocolExample {
  name: string;
  transcript: string;
  protocol: string;
}

const dataDir = (sub: string) => path.resolve(process.cwd(), "data", sub);

/** Эталонные пары «транскрипт + протокол»: data/transcripts/<имя>.txt и data/protocols/<имя>.md. До 5 штук. */
export function loadProtocolExamples(max = 5): ProtocolExample[] {
  const tdir = dataDir("transcripts");
  const pdir = dataDir("protocols");
  if (!existsSync(tdir) || !existsSync(pdir)) return [];
  const out: ProtocolExample[] = [];
  for (const f of readdirSync(tdir).filter((x) => x.endsWith(".txt")).sort()) {
    const name = f.replace(/\.txt$/, "");
    const pf = path.join(pdir, `${name}.md`);
    if (!existsSync(pf)) continue;
    out.push({ name, transcript: readFileSync(path.join(tdir, f), "utf8"), protocol: readFileSync(pf, "utf8") });
    if (out.length >= max) break;
  }
  return out;
}

export function listTranscriptNames(): string[] {
  const dir = dataDir("transcripts");
  return existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith(".txt")).map((x) => x.replace(/\.txt$/, "")).sort() : [];
}

export function loadTranscript(name: string): string {
  if (!/^[\w.-]+$/.test(name)) throw new Error("Недопустимое имя транскрипта");
  const file = path.join(dataDir("transcripts"), `${name}.txt`);
  if (!existsSync(file)) throw new Error(`Транскрипт не найден: ${name}`);
  return readFileSync(file, "utf8");
}

const TZ = "Europe/Moscow";
const fmtDate = (d: Date) => new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, day: "numeric", month: "long", year: "numeric" }).format(d);
const fmtTime = (d: Date) => new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(d);

export function fmtDueDate(iso: string | null): string {
  if (!iso) return "срок не назван";
  return fmtDate(new Date(`${iso}T12:00:00+03:00`));
}

const cell = (s: string) => s.replace(/\|/g, "/").replace(/\n/g, " ");

/** Markdown в формате SPEC 4.5.1: информация, заметки, поручения (таблица). */
export function renderProtocol(args: {
  title: string;
  startAt: Date;
  endAt: Date;
  meetingUrl: string | null;
  participants: string[];
  data: ProtocolData;
  /** Итоги по прошлым поручениям (после привязки к задачам). */
  updates?: readonly ResolvedUpdate[];
}): string {
  const { data } = args;
  const updates = args.updates ?? [];
  const lines = [
    `# Протокол: ${args.title}`,
    "",
    "## Информация о встрече",
    `- Дата: ${fmtDate(args.startAt)}, ${fmtTime(args.startAt)}–${fmtTime(args.endAt)}`,
    `- Ссылка: ${args.meetingUrl ?? "—"}`,
    `- Участники: ${args.participants.length ? args.participants.join(", ") : "—"}`,
    "",
    "## Заметки о встрече",
  ];
  for (const n of data.notes) {
    lines.push(`### ${n.topic}`, ...n.points.map((p) => `- ${p}`), "");
  }
  if (data.decisions.length) lines.push("### Решения", ...data.decisions.map((d) => `- ${d}`), "");
  if (updates.length) {
    lines.push("## Прошлые поручения", "| Поручение | Исполнитель | Итог | Что меняется |", "|---|---|---|---|");
    for (const u of updates) {
      const change = [
        u.newTitle ? `формулировка → «${u.newTitle}»` : "",
        u.newDueDate ? `срок ${fmtDueDate(u.oldDueDate)} → ${fmtDueDate(u.newDueDate)}` : "",
        u.comment,
      ].filter(Boolean).join("; ");
      lines.push(`| ${cell(u.title)} | ${cell(u.assigneeName ?? "—")} | ${OUTCOME_LABEL[u.outcome]} | ${cell(change || "—")} |`);
    }
    lines.push("");
  }
  lines.push("## Поручения", "| Задача | Исполнитель | Срок | Критерий готовности |", "|---|---|---|---|");
  if (!data.assignments.length) lines.push("| — | — | — | — |");
  for (const a of data.assignments) {
    lines.push(`| ${cell(a.task)} | ${cell(a.assigneeName)} | ${fmtDueDate(a.dueDate)} | ${cell(a.criteria)} |`);
  }
  return lines.join("\n").trim() + "\n";
}

/** Имена участников из адресов календаря; адрес без сотрудника остаётся как есть. */
export async function participantNames(db: PrismaClient, leaderId: string, attendees: unknown): Promise<string[]> {
  const emails = z.array(z.string()).safeParse(attendees);
  if (!emails.success || !emails.data.length) return [];
  const emp = await db.employee.findMany({ where: { leaderId, email: { in: emails.data } }, select: { email: true, name: true } });
  const byEmail = new Map(emp.map((e) => [e.email, e.name]));
  return emails.data.map((e) => byEmail.get(e) ?? e);
}

function buildSystem(args: { leaderName: string; employees: string[]; rules: string[]; examples: ProtocolExample[]; stylePrompt: string; hasOpenItems: boolean }) {
  return [
    `Ты ИИ-помощник руководителя ${args.leaderName}. По транскрипту встречи составь протокол в структурированном виде.`,
    "Заметки группируй по темам, решения выноси отдельно. Поручения: только то, что на встрече реально поручили конкретному человеку.",
    "Исполнитель — ФИО из списка сотрудников ниже (как там написано). Если исполнитель внешний или не назван, не придумывай: укажи имя как в транскрипте.",
    "Срок бери только из транскрипта и переводи в дату YYYY-MM-DD относительно даты встречи. Срок не назван — dueDate = null, не выдумывай.",
    "Критерий готовности — измеримый результат («отчёт отправлен», «KPI не ниже 90%»); если на встрече не называли, сформулируй из сути поручения, ничего не добавляя от себя.",
    "Не добавляй фактов, которых нет в транскрипте. По-русски, коротко.",
    // Только при наличии прошлых поручений: иначе промпт (и ключ кэша) прежний.
    args.hasOpenItems
      ? [
          "В запросе есть список прошлых поручений с метками P1, P2… По каждому, о котором на встрече что-то сказали, заполни previousUpdates:",
          "DONE — сделано; IN_PROGRESS — в работе, успевают; NOT_RESOLVED — вопрос не решён или сорван срок; CHANGED — задачу переформулировали, сменили объём или исполнителя.",
          "newTitle — только если задачу на встрече сформулировали иначе; newDueDate — только если назвали новый срок. comment — суть ответа одной фразой.",
          "О поручении на встрече не говорили — не включай его. Новые поручения по прошлым задачам не дублируй в assignments.",
        ].join("\n")
      : "",
    `Сотрудники: ${args.employees.join("; ")}.`,
    args.stylePrompt ? `Манера руководителя: ${args.stylePrompt}` : "",
    args.rules.length ? `Выученные правила руководителя:\n${args.rules.map((r) => `- ${r}`).join("\n")}` : "",
    args.examples.length
      ? "Эталоны оформления (транскрипт → протокол):\n" +
        args.examples.map((e, i) => `### Пример ${i + 1}\nТранскрипт:\n${e.transcript.slice(0, 3000)}\nПротокол:\n${e.protocol.slice(0, 3000)}`).join("\n\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** «выполнено 1, задача изменилась 2» — для рекомендации на карточке. */
export function summarizeUpdates(updates: readonly ResolvedUpdate[]): string {
  const counts = new Map<string, number>();
  for (const u of updates) counts.set(OUTCOME_LABEL[u.outcome], (counts.get(OUTCOME_LABEL[u.outcome]) ?? 0) + 1);
  return [...counts].map(([k, n]) => `${k} ${n}`).join(", ");
}

/**
 * Прошлые поручения встречи: те, о которых аватар спрашивал (agendaQuestions), иначе — вычисленные заново
 * тем же правилом, что и вопросы. Только открытые и только этого руководителя.
 */
export async function openItemsForMeeting(db: PrismaClient, leaderId: string, meetingId: string, agenda: unknown): Promise<OpenItem[]> {
  const saved = AgendaSchema.safeParse(agenda);
  const questions = saved.success && saved.data.length ? saved.data : await buildAgendaQuestions(db, leaderId, meetingId);
  const ids = [...new Set(questions.map((q) => q.taskId).filter((id): id is string => !!id))];
  if (!ids.length) return [];
  const tasks = await db.task.findMany({ where: { id: { in: ids }, leaderId, status: { not: "DONE" } }, include: { assignee: { select: { name: true } } } });
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return ids
    .map((id) => byId.get(id))
    .filter((t): t is NonNullable<typeof t> => !!t)
    .map((t, i) => ({ ref: `P${i + 1}`, taskId: t.id, title: t.title, assigneeName: t.assignee?.name ?? null, dueAt: t.dueAt }));
}

export interface GenerateDeps {
  db: PrismaClient;
  llm: LlmClient;
  examples?: ProtocolExample[];
}

export type ProtocolResult = { ok: true; decisionId: string; meetingId: string; minutesToProtocol: number } | { ok: false; reason: string };

/** Транскрипт → протокол → карточка руководителю. Повторный вызов для той же встречи не плодит карточки. */
export async function generateProtocolDecision(deps: GenerateDeps, leaderId: string, meetingId: string, transcript: string): Promise<ProtocolResult> {
  const { db, llm } = deps;
  const text = transcript.trim();
  if (text.length < 20) return { ok: false, reason: "Транскрипт пустой или слишком короткий" };
  const meeting = await db.meeting.findFirst({ where: { id: meetingId, leaderId } });
  if (!meeting) return { ok: false, reason: "Встреча не найдена" };
  if (meeting.isProtocolApproved) return { ok: false, reason: "Протокол этой встречи уже утверждён" };

  const existing = await db.decision.findFirst({
    where: { leaderId, type: "MEETING_PROTOCOL", status: "PENDING", proposedPayload: { path: ["args", "meetingId"], equals: meetingId } },
  });
  if (existing) return { ok: false, reason: "Карточка протокола уже ждёт решения" };

  const [leader, employees, rules, open] = await Promise.all([
    db.leader.findFirstOrThrow({ where: { id: leaderId }, select: { name: true, stylePrompt: true } }),
    db.employee.findMany({ where: { leaderId }, select: { id: true, name: true, position: true } }),
    activeMemoryRules(db, leaderId, "MEETING"),
    openItemsForMeeting(db, leaderId, meetingId, meeting.agendaQuestions),
  ]);
  const openList = open.length
    ? `\n\nПрошлые поручения, о которых спрашивали:\n${open.map((o) => `${o.ref}: «${o.title}» — ${o.assigneeName ?? "без исполнителя"}, срок ${isoDay(o.dueAt)}`).join("\n")}`
    : "";

  const parsed = await llm.generateStructured({
    leaderId,
    pipeline: "PROTOCOL_GEN",
    schema: ProtocolSchema,
    system: buildSystem({
      leaderName: leader.name,
      employees: employees.map((e) => `${e.name} (${e.position})`),
      rules,
      examples: deps.examples ?? loadProtocolExamples(),
      stylePrompt: leader.stylePrompt,
      hasOpenItems: open.length > 0,
    }),
    prompt: `Встреча: ${meeting.title}\nДата: ${meeting.startAt.toISOString().slice(0, 10)}${openList}\n\nТранскрипт:\n${text}`,
    cacheKey: `${meetingId}:${text.length}:${text.slice(0, 200)}${open.length ? `:${open.map((o) => o.taskId).join(",")}` : ""}`,
    temperature: 0,
  });
  const data: ProtocolData = { ...parsed, previousUpdates: parsed.previousUpdates ?? [] };
  const updates = resolveUpdates(data.previousUpdates, open);

  const participants = await participantNames(db, leaderId, meeting.attendees);
  const markdown = renderProtocol({
    title: meeting.title,
    startAt: meeting.startAt,
    endAt: meeting.endAt,
    meetingUrl: meeting.meetingUrl,
    participants,
    data,
    updates,
  });

  // Протокол не может быть готов раньше конца встречи (демо-время может стоять до неё).
  const now = new Date(Math.max(clock.now().getTime(), meeting.endAt.getTime()));
  const known = new Map(employees.map((e) => [e.name.toLowerCase(), e.id]));
  const assignments = data.assignments.map((a) => ({ ...a, assigneeId: known.get(a.assigneeName.toLowerCase()) ?? null }));
  const noDue = assignments.filter((a) => !a.dueDate).length;
  const noAssignee = assignments.filter((a) => !a.assigneeId).length;

  const decision = await db.decision.create({
    data: {
      leaderId,
      type: "MEETING_PROTOCOL",
      title: `Протокол: ${meeting.title}`,
      contextSummary: `${data.decisions.length ? data.decisions.slice(0, 3).join(" ") : (data.notes[0]?.topic ?? "Итоги встречи")}. Поручений: ${assignments.length}.`,
      gateReasons: ["Рассылка протокола участникам и поручения исполнителям уходят наружу только после вашего утверждения"],
      aiRecommendation: [
        "Утвердить: разошлю протокол участникам и поставлю поручения.",
        noDue ? `У ${noDue} поручений срок не назван: по умолчанию поставлю неделю от встречи, поправьте через «Править».` : "",
        noAssignee ? `У ${noAssignee} поручений исполнитель не из команды: задачи без исполнителя останутся у вас.` : "",
        updates.length ? `По прошлым поручениям: ${summarizeUpdates(updates)}. После утверждения обновлю их в реестре.` : "",
      ]
        .filter(Boolean)
        .join(" "),
      proposedPayload: { tool: "meeting.protocol", args: { meetingId, assignments, previousUpdates: updates } },
      draftText: markdown,
    },
  });

  await db.meeting.update({ where: { id: meetingId }, data: { transcript: text, protocolMarkdown: markdown, protocolReadyAt: now } });
  await db.activityLog.create({
    data: { createdAt: now, leaderId, pipeline: "MEETING", action: "PROTOCOL_READY", reason: `Протокол встречи «${meeting.title}» готов и ждёт утверждения`, metadata: { meetingId, decisionId: decision.id } },
  });
  await publishEvent(leaderId, { type: "decision.created", data: { id: decision.id } });
  await publishEvent(leaderId, { type: "metrics.updated", data: {} });
  return { ok: true, decisionId: decision.id, meetingId, minutesToProtocol: Math.round((now.getTime() - meeting.endAt.getTime()) / 60000) };
}
