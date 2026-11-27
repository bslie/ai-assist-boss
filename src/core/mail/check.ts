/**
 * «Проверь почту»: чтение ящика идёт сразу, без кнопки: это не действие во внешнем сервисе. Что делать с письмами,
 * решают правила и права подключения, как при автоматической проверке. Ответ — человеческий итог, а не «ничего нет».
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { clock } from "../clock";
import { plural } from "../dashboard";
import { MAIL_TYPES } from "./factory";
import { pollWithPipeline } from "./pipeline";
import { describeActions, getMailStatus } from "./summary";

const MAIL_BATCH = 30;

export async function checkMailNow(db: PrismaClient, leaderId: string): Promise<string> {
  const boxes = await db.connector.findMany({ where: { leaderId, isActive: true, type: { in: [...MAIL_TYPES] } }, select: { id: true, name: true } });
  if (boxes.length === 0) return "Почта не подключена: откройте «Подключения» и добавьте Gmail, Яндекс или Microsoft 365. Дальше я сама буду разбирать письма и приносить вам только то, что требует решения.";
  const lines: string[] = [];
  for (const b of boxes) {
    const res = await pollWithPipeline(db, leaderId, b.id);
    if (!res.ok) {
      lines.push(`${b.name}: ${res.message}.`);
      continue;
    }
    if (res.fetched === 0) {
      lines.push(`${b.name}: новых писем нет.`);
      continue;
    }
    const parts = [`${b.name}: забрала ${res.fetched} ${plural(res.fetched, "письмо", "письма", "писем")}`];
    const acts = describeActions(res.stats.byAction);
    if (acts) parts.push(`из них ${acts}`);
    if (res.stats.decisionsCreated) parts.push(`карточек для вас: ${res.stats.decisionsCreated} (выше в «Решениях»)`);
    if (res.archived) parts.push(`убрала из входящих рассылок: ${res.archived}`);
    lines.push(`${parts.join(". ")}.${res.fetched >= MAIL_BATCH ? " Возможно, есть ещё: скажите «проверь почту» снова." : ""}`);
  }
  if (lines.every((l) => l.includes("новых писем нет"))) {
    const s = await getMailStatus(db, leaderId, clock.now());
    lines.push(s.recentTotal ? `Ранее уже разобрано писем за 3 дня: ${s.recentTotal}. Что с ними сделано — спросите, расскажу.` : "Это не ошибка: при первой проверке я беру письма за последние 3 дня, дальше — только новые.");
  }
  return lines.join("\n");
}
