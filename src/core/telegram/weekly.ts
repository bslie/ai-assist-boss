/**
 * Итог недели (SPEC 5.2, P1): часы, письма авто и с подтверждением, открытые задачи было → стало,
 * возвраты задач, среднее время до протокола. Данные те же, что на экране «Сегодня».
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { getToday, plural } from "../dashboard";
import { esc } from "./types";

const num = (n: number) => String(n).replace(".", ",");

export async function buildWeeklyReport(db: PrismaClient, leaderId: string): Promise<string> {
  const t = await getToday(db, leaderId);
  const m = t.metrics;
  const returns = await db.task.aggregate({ where: { leaderId }, _sum: { returnCount: true } });
  const returned = returns._sum.returnCount ?? 0;

  const lines = [
    `<b>Итог недели.</b> Это ${esc(t.leader.assistantTitle)}.`,
    "",
    `Освободила для вас: <b>${num(m.savedHours)} ч</b>.`,
    `Писем за неделю: ${m.unreadBefore}. Без вашего участия закрыто ${m.autoEmailsPct}%, к вам дошло ${m.unreadAfter} ${plural(m.unreadAfter, "письмо", "письма", "писем")}.`,
    `Открытых задач было ${m.openTasksMorning.before}, на вас осталось ${m.openTasksMorning.after}.`,
    `Задач с первого раза: ${m.firstTimeRightPct}%, возвратов на доработку: ${returned}.`,
    m.avgProtocolMinutes === null ? "Протоколов встреч за неделю не было." : `Протокол встречи готовился в среднем ${m.avgProtocolMinutes} мин после её окончания.`,
  ];
  if (m.learnedRules > 0) lines.push(`Выучила ${m.learnedRules} ${plural(m.learnedRules, "правило", "правила", "правил")} из ваших правок.`);
  if (t.decisions.length > 0) lines.push("", `Ещё ждут вас: ${t.decisions.length} ${plural(t.decisions.length, "вопрос", "вопроса", "вопросов")}.`);
  return lines.join("\n");
}
