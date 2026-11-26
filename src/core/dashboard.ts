/**
 * Данные экрана «Сегодня» (SPEC 6: /api/dashboard/today, 7.4: метрики).
 * Все запросы по leaderId. «Сейчас» — только clock.now().
 */
import type { Decision, PrismaClient } from "@/generated/prisma/client";
import { readyClock } from "./clock";

/** Часовой пояс руководителя. В схеме его нет; Россия без перехода на летнее время → фиксированный сдвиг. */
const TZ = "Europe/Moscow";
const TZ_OFFSET = "+03:00";
const DAY = 86_400_000;

export function dayBounds(now: Date): { start: Date; end: Date } {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(now); // YYYY-MM-DD
  const start = new Date(`${ymd}T00:00:00${TZ_OFFSET}`);
  return { start, end: new Date(start.getTime() + DAY) };
}

const fmtTime = (d: Date) =>
  new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(d);

export type Tone = "coral" | "amber" | "sage" | "dim";

const TAGS: Record<string, { tag: string; tone: Tone }> = {
  HR: { tag: "Кадры", tone: "coral" },
  MANAGEMENT: { tag: "Руководство", tone: "coral" },
  CLIENT_COMMITMENT: { tag: "Клиент", tone: "coral" },
  MONEY: { tag: "Деньги", tone: "amber" },
  INVITATION: { tag: "Приглашение", tone: "amber" },
};

/** Тег по сигналу риска, если категория LLM не защищённая (письмо эскалировано сигналом, а не категорией). */
const SIGNAL_TAGS: [string, { tag: string; tone: Tone }][] = [
  ["MANAGER_PARTY", TAGS.MANAGEMENT],
  ["HR_PARTY", TAGS.HR],
  ["HR_TERMS", TAGS.HR],
  ["COMMITMENT_TERMS", TAGS.CLIENT_COMMITMENT],
  ["MONEY_APPROVAL", TAGS.MONEY],
  ["FINANCE_PARTY", TAGS.MONEY],
  ["EXTERNAL_INVITATION", TAGS.INVITATION],
];

export interface DecisionCard {
  id: string;
  type: string;
  tag: string;
  tone: Tone;
  from: string;
  when: string;
  title: string;
  summary: string;
  draft: string | null;
  recommendation: string;
  reasons: string[];
  reminderCount: number;
}

export interface DayItem {
  time: string;
  title: string;
  note: string;
  tone: Tone;
}

export interface TodayData {
  now: string;
  leader: { id: string; name: string; assistantTitle: string };
  headline: { handled: number; total: number; waiting: number };
  doneChips: string[];
  decisions: DecisionCard[];
  day: DayItem[];
  priorities: string[];
  metrics: {
    savedHours: number;
    autoEmailsPct: number;
    unreadBefore: number;
    unreadAfter: number;
    openTasksMorning: { before: number; after: number };
    firstTimeRightPct: number;
    avgProtocolMinutes: number | null;
  };
}

export const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

/** Карточки решений: первое письмо треда даёт отправителя, категорию и время. Общий код для веба и Telegram. */
export async function buildDecisionCards(db: PrismaClient, leaderId: string, pending: Decision[]): Promise<DecisionCard[]> {
  const sources = await db.emailItem.findMany({
    where: { leaderId, decisionId: { in: pending.map((d) => d.id) }, occurrence: 1 },
  });
  const sourceByDecision = new Map(sources.map((e) => [e.decisionId, e]));

  return pending.map((d) => {
    const src = sourceByDecision.get(d.id);
    const meta =
      (src?.category && TAGS[src.category]) ||
      SIGNAL_TAGS.find(([sig]) => src?.riskSignals.includes(sig))?.[1] || { tag: "Решение", tone: "amber" as Tone };
    return {
      id: d.id,
      type: d.type,
      tag: d.reminderCount > 0 ? `${meta.tag} · повтор ×${d.reminderCount + 1}` : meta.tag,
      tone: meta.tone,
      from: src?.senderName ?? "",
      when: src ? fmtTime(src.receivedAt) : "",
      title: d.title,
      summary: d.contextSummary,
      draft: d.draftText,
      recommendation: d.aiRecommendation,
      reasons: d.gateReasons,
      reminderCount: d.reminderCount,
    };
  });
}

export async function getToday(db: PrismaClient, leaderId: string): Promise<TodayData> {
  const clk = await readyClock();
  const now = clk.now();
  const weekAgo = new Date(now.getTime() - 7 * DAY);
  const { start, end } = dayBounds(now);

  const leader = await db.leader.findFirstOrThrow({ where: { id: leaderId } });

  const [pending, emails, activity, meetings, tasks, protocols] = await Promise.all([
    db.decision.findMany({ where: { leaderId, status: "PENDING" }, orderBy: { createdAt: "asc" } }),
    db.emailItem.findMany({
      where: { leaderId, receivedAt: { gte: weekAgo } },
      select: { id: true, action: true, category: true, decisionId: true, occurrence: true, senderName: true, receivedAt: true },
    }),
    db.activityLog.findMany({ where: { leaderId, createdAt: { gte: weekAgo } }, select: { action: true, savedMinutes: true } }),
    db.meeting.findMany({ where: { leaderId, startAt: { gte: start, lt: end } }, orderBy: { startAt: "asc" } }),
    db.task.findMany({ where: { leaderId } }),
    db.meeting.findMany({
      where: { leaderId, protocolReadyAt: { not: null } },
      select: { endAt: true, protocolReadyAt: true },
    }),
  ]);

  const decisionIds = pending.map((d) => d.id);
  const decisions = await buildDecisionCards(db, leaderId, pending);

  const total = emails.length;
  const needLeader = emails.filter((e) => e.action === "ASK_LEADER");
  const stillWaiting = needLeader.filter((e) => e.decisionId && decisionIds.includes(e.decisionId)).length;
  const handled = total - stillWaiting;

  const count = (a: string) => activity.filter((x) => x.action === a).length;
  const chips: string[] = [];
  const n = (k: string, one: string, few: string, many: string, verb: string) => {
    const c = count(k);
    if (c) chips.push(`${verb} ${c} ${plural(c, one, few, many)}`);
  };
  n("IGNORE", "рассылку", "рассылки", "рассылок", "Отправила в архив");
  n("DIGEST", "отчёт или статус", "отчёта или статуса", "отчётов и статусов", "В сводку ушло");
  n("DELEGATE", "поручение", "поручения", "поручений", "Передала");
  n("AUTO", "встречу", "встречи", "встреч", "Подтвердила");

  const overdue = (t: (typeof tasks)[number]) =>
    t.status !== "DONE" && (t.dueAt < now || t.csvStatus === "просрочена");
  const open = tasks.filter((t) => t.status !== "DONE");
  const leaderOpen = open.filter(
    (t) => t.assigneeId === null || t.status === "READY_FOR_LEADER" || t.status === "ESCALATED",
  );

  const day: DayItem[] = [
    ...meetings.map<DayItem>((m) => ({
      time: fmtTime(m.startAt),
      title: m.title,
      note:
        m.participationMode === "AVATAR"
          ? "вместо вас будет аватар"
          : m.participationMode === "ASYNC_STATUS"
            ? "закроет асинхронный статус"
            : "",
      tone: m.participationMode === "LEADER" ? "dim" : "sage",
    })),
    ...tasks.filter(overdue).map<DayItem>((t) => ({
      time: "срок прошёл",
      title: t.title,
      note: "просрочено",
      tone: "coral",
    })),
  ];

  const goals = (leader.quarterGoals as string[]) ?? [];
  const priorities = [
    ...tasks.filter(overdue).slice(0, 2).map((t) => t.title),
    ...goals,
  ].slice(0, 4);

  const savedMinutes = activity.reduce((s, a) => s + a.savedMinutes, 0);
  const closed = tasks.filter((t) => t.status !== "NEW");
  const right = closed.filter((t) => t.returnCount === 0 && t.rescheduleCount === 0).length;
  const protoMin = protocols.length
    ? protocols.reduce((s, m) => s + (m.protocolReadyAt!.getTime() - m.endAt.getTime()) / 60_000, 0) / protocols.length
    : null;

  return {
    now: now.toISOString(),
    leader: { id: leader.id, name: leader.name, assistantTitle: `ИИ-помощник ${leader.name}` },
    headline: { handled, total, waiting: decisions.length },
    doneChips: chips,
    decisions,
    day,
    priorities,
    metrics: {
      savedHours: Math.round((savedMinutes / 60) * 10) / 10,
      autoEmailsPct: total ? Math.round((emails.filter((e) => e.action !== "ASK_LEADER").length / total) * 100) : 0,
      unreadBefore: total,
      unreadAfter: stillWaiting,
      openTasksMorning: { before: open.length, after: leaderOpen.length },
      firstTimeRightPct: closed.length ? Math.round((right / closed.length) * 100) : 0,
      avgProtocolMinutes: protoMin === null ? null : Math.round(protoMin),
    },
  };
}
