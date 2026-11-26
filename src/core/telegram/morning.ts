/**
 * Утренний план (SPEC 5.2, P0): 3–4 приоритета, число решений в очереди, что сделано автоматически,
 * сэкономленные часы. Данные те же, что на экране «Сегодня».
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { clock } from "../clock";
import { getToday, plural } from "../dashboard";
import { publishEvent } from "../events";
import type { RoutineJob } from "../scheduler";
import type { LlmClient } from "../llm";
import { runDeadlineGuard } from "../tasks/lifecycle";
import { sendDecisionCard } from "./cards";
import { buildWeeklyReport } from "./weekly";
import { esc, type Messenger } from "./types";

export async function buildMorningDigest(db: PrismaClient, leaderId: string, opts: { resurfaced?: number } = {}): Promise<string> {
  const t = await getToday(db, leaderId);
  const first = t.leader.name.split(" ")[0];
  const n = t.decisions.length;
  const lines: string[] = [
    `<b>Доброе утро, ${esc(first)}.</b> Это ${esc(t.leader.assistantTitle)} с планом на день.`,
  ];

  if (t.priorities.length) {
    lines.push("", "<b>Главное сегодня</b>", ...t.priorities.map((p, i) => `${i + 1}. ${esc(p)}`));
  }
  lines.push(
    "",
    n > 0
      ? `Без вас не решить: ${n} ${plural(n, "вопрос", "вопроса", "вопросов")}. Карточки ниже.`
      : "Решений, которые ждут вас, нет.",
  );
  if (opts.resurfaced) {
    // Без согласования «который/которые»: просто число, чтобы фраза была верна при любом количестве.
    lines.push(`Вернула отложенные по вашей просьбе: ${opts.resurfaced}.`);
  }
  if (t.doneChips.length) lines.push("", "<b>Сделано без вас</b>", ...t.doneChips.map((c) => `• ${esc(c)}`));
  const waiting = await waitingForInvite(db, leaderId);
  if (waiting.length) {
    const bot = process.env.TELEGRAM_BOT_USERNAME;
    lines.push(
      "",
      "<b>Поручения ждут, пока сотрудник подключит бота</b>",
      ...waiting.map((w) => `• ${esc(w.name)}: ${w.tasks} ${plural(w.tasks, "поручение", "поручения", "поручений")}${bot ? `, ссылка t.me/${esc(bot)}?start=${esc(w.inviteToken)}` : ""}`),
    );
  }
  if (t.metrics.savedHours > 0) {
    lines.push("", `За неделю освободила ${String(t.metrics.savedHours).replace(".", ",")} ч.`);
  }
  return lines.join("\n");
}

/** Исполнители с неотправленными поручениями, у которых нет привязанного чата. */
export async function waitingForInvite(db: PrismaClient, leaderId: string) {
  const tasks = await db.task.findMany({
    where: { leaderId, assigneeId: { not: null }, notifiedAt: null, status: "NEW", sourceType: { not: "DATASET" } },
    include: { assignee: true },
  });
  const byEmployee = new Map<string, { name: string; inviteToken: string; tasks: number }>();
  for (const t of tasks) {
    if (!t.assignee) continue;
    const e = byEmployee.get(t.assignee.id) ?? { name: t.assignee.name, inviteToken: t.assignee.inviteToken, tasks: 0 };
    e.tasks++;
    byEmployee.set(t.assignee.id, e);
  }
  const ids = [...byEmployee.keys()];
  const bound = await db.telegramBinding.findMany({
    where: { leaderId, role: "EMPLOYEE", employeeId: { in: ids } },
    select: { employeeId: true },
  });
  const boundSet = new Set(bound.map((b) => b.employeeId));
  return ids.filter((id) => !boundSet.has(id)).map((id) => byEmployee.get(id)!);
}

export interface JobDeps {
  db: PrismaClient;
  messenger: Messenger;
  llm?: LlmClient;
}

export type JobResult = { sent: number } | { skipped: string };

/**
 * «Не сейчас» откладывает карточку до следующего утреннего плана: тут она снова становится PENDING
 * и (ссылку на старое сообщение сбрасываем) уходит в чат заново. Возвращает id вернувшихся карточек.
 */
export async function resurfaceSnoozed(db: PrismaClient, leaderId: string): Promise<string[]> {
  const snoozed = await db.decision.findMany({ where: { leaderId, status: "SNOOZED" }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (snoozed.length === 0) return [];
  const ids = snoozed.map((d) => d.id);
  await db.decision.updateMany({
    where: { leaderId, id: { in: ids }, status: "SNOOZED" },
    data: { status: "PENDING", resolvedAt: null, telegramMessageId: null },
  });
  await db.activityLog.create({
    data: {
      leaderId,
      createdAt: clock.now(),
      pipeline: "EMAIL",
      action: "DECISION_RESURFACED",
      reason: `Вернула отложенные карточки: ${ids.length}`,
      metadata: { decisionIds: ids },
    },
  });
  await publishEvent(leaderId, { type: "metrics.updated", data: {} });
  return ids;
}

async function leaderChatIds(db: PrismaClient, leaderId: string): Promise<string[]> {
  const chats = await db.telegramBinding.findMany({ where: { leaderId, role: "LEADER" }, select: { chatId: true } });
  return [...new Set(chats.map((c) => c.chatId))];
}

export async function processRoutineJob(deps: JobDeps, job: RoutineJob): Promise<JobResult> {
  if (job.code === "MORNING_DIGEST") return runMorning(deps, job);
  if (job.code === "WEEKLY_REPORT") {
    const chats = await leaderChatIds(deps.db, job.leaderId);
    if (chats.length === 0) return { skipped: "чат руководителя не привязан" };
    const text = await buildWeeklyReport(deps.db, job.leaderId);
    for (const chatId of chats) await deps.messenger.send(chatId, text);
    return { sent: chats.length };
  }
  if (job.code === "DEADLINE_GUARD") {
    const stats = await runDeadlineGuard(deps, job.leaderId);
    return { sent: stats.checkins + stats.reminders + stats.escalated };
  }
  return { skipped: `рутина ${job.code} ещё не реализована` };
}

async function runMorning({ db, messenger }: JobDeps, job: RoutineJob): Promise<JobResult> {
  // Отложенное возвращаем в любом случае: даже без чата оно должно снова появиться в вебе.
  const back = await resurfaceSnoozed(db, job.leaderId);

  const chats = await db.telegramBinding.findMany({ where: { leaderId: job.leaderId, role: "LEADER" }, select: { chatId: true } });
  const unique = [...new Set(chats.map((c) => c.chatId))];
  if (unique.length === 0) return { skipped: "чат руководителя не привязан" };

  const text = await buildMorningDigest(db, job.leaderId, { resurfaced: back.length });
  for (const chatId of unique) await messenger.send(chatId, text);
  // Вернувшиеся и накопленные за тихие часы карточки идут следом за планом, как новые (отправка идемпотентна).
  const queued = await db.decision.findMany({ where: { leaderId: job.leaderId, status: "PENDING", telegramMessageId: null }, orderBy: { createdAt: "asc" }, select: { id: true } });
  for (const id of new Set([...back, ...queued.map((d) => d.id)])) await sendDecisionCard(db, messenger, job.leaderId, id);
  return { sent: unique.length };
}
