/**
 * Утренний план (SPEC 5.2, P0): 3–4 приоритета, число решений в очереди, что сделано автоматически,
 * сэкономленные часы. Данные те же, что на экране «Сегодня».
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { getToday, plural } from "../dashboard";
import type { RoutineJob } from "../scheduler";
import { esc, type Messenger } from "./types";

export async function buildMorningDigest(db: PrismaClient, leaderId: string): Promise<string> {
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
}

export type JobResult = { sent: number } | { skipped: string };

export async function processRoutineJob({ db, messenger }: JobDeps, job: RoutineJob): Promise<JobResult> {
  if (job.code !== "MORNING_DIGEST") return { skipped: `рутина ${job.code} ещё не реализована` };

  const chats = await db.telegramBinding.findMany({ where: { leaderId: job.leaderId, role: "LEADER" }, select: { chatId: true } });
  const unique = [...new Set(chats.map((c) => c.chatId))];
  if (unique.length === 0) return { skipped: "чат руководителя не привязан" };

  const text = await buildMorningDigest(db, job.leaderId);
  for (const chatId of unique) await messenger.send(chatId, text);
  return { sent: unique.length };
}
