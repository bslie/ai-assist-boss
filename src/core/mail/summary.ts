/**
 * Что помощник сделал с почтой: нужно чату (контекст для «что в почте?») и ответу на «проверь почту».
 * Только чтение своих данных руководителя: всё по leaderId, письма наружу не уходят.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { decryptJson } from "../connectors/crypto";
import type { Stored } from "../connectors/service";
import { MAIL_TYPES } from "./factory";

export const ACTION_LABEL: Record<string, string> = {
  ASK_LEADER: "ждут вашего решения",
  DIGEST: "ушли в сводку",
  DELEGATE: "переданы сотрудникам",
  IGNORE: "рассылки, оставила без внимания",
  AUTO: "решила сама по вашим правилам",
};

const DAY = 86_400_000;
const msk = (d: Date) => new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(d);

export interface MailBoxStatus {
  name: string;
  account: string | null;
  lastSync: { at: string; fetched: number; error?: string } | null;
}
export interface MailStatus {
  boxes: MailBoxStatus[];
  /** Сколько писем уже разобрано за последние 3 дня, по действиям. */
  recent: Record<string, number>;
  recentTotal: number;
  latest: { from: string; subject: string; action: string | null; category: string | null }[];
}

export async function getMailStatus(db: PrismaClient, leaderId: string, since: Date): Promise<MailStatus> {
  const rows = await db.connector.findMany({ where: { leaderId, isActive: true, type: { in: [...MAIL_TYPES] } }, select: { name: true, encryptedConfig: true } });
  const boxes = rows.map<MailBoxStatus>((r) => {
    const s = decryptJson<Stored>(r.encryptedConfig);
    return { name: r.name, account: s?.account ?? s?.values?.email ?? null, lastSync: s?.lastSync ?? null };
  });
  const from = new Date(since.getTime() - 3 * DAY);
  const items = await db.emailItem.findMany({ where: { leaderId, receivedAt: { gte: from } }, orderBy: { receivedAt: "desc" }, select: { senderName: true, subject: true, action: true, category: true } });
  const recent: Record<string, number> = {};
  for (const i of items) if (i.action) recent[i.action] = (recent[i.action] ?? 0) + 1;
  return { boxes, recent, recentTotal: items.length, latest: items.slice(0, 8).map((i) => ({ from: i.senderName, subject: i.subject, action: i.action, category: i.category })) };
}

export const describeActions = (byAction: Record<string, number>): string =>
  Object.entries(byAction)
    .filter(([, n]) => n > 0)
    .map(([a, n]) => `${n} — ${ACTION_LABEL[a] ?? a}`)
    .join("; ");

/** Для контекста модели: подключённые ящики, итог последней проверки и последние разобранные письма. */
export function mailContext(s: MailStatus): string[] {
  if (s.boxes.length === 0) return ["Почта: ни один ящик не подключён."];
  const lines = s.boxes.map((b) => {
    const sync = !b.lastSync ? "ещё ни разу не проверяла" : b.lastSync.error ? `последняя проверка не удалась: ${b.lastSync.error}` : `последняя проверка ${msk(new Date(b.lastSync.at))}, новых писем тогда: ${b.lastSync.fetched}`;
    return `Ящик ${b.name}${b.account ? ` (${b.account})` : ""}: ${sync}.`;
  });
  lines.push("Автоматически ящик проверяется раз в пару минут; при первой проверке берутся письма за 3 дня. Руководитель может сказать «проверь почту», и проверка пойдёт сразу.");
  lines.push(s.recentTotal ? `Разобрано писем за 3 дня: ${s.recentTotal} (${describeActions(s.recent) || "без действий"}).` : "Разобранных писем за 3 дня нет.");
  if (s.latest.length) lines.push("Последние письма:", ...s.latest.map((l) => `- ${l.from}: «${l.subject}» → ${l.action ? (ACTION_LABEL[l.action] ?? l.action) : "не разобрано"}`));
  return lines;
}
