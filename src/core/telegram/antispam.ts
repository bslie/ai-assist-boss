/**
 * Антиспам (SPEC 5.3, P1): в тихие часы руководителю сразу приходят только защищённые категории и то,
 * что он сам пометил «присылай сразу». Остальное копится и уходит вместе с утренним планом.
 * Днём карточки приходят сразу: руководитель ждёт их по ходу работы.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { clock } from "../clock";
import { hasHardSignal, isLockedCategory, type RiskSignal } from "../policy-gate";

const TZ = "Europe/Moscow";

const toMinutes = (hhmm: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
};

/** Время суток по Москве в минутах от полуночи. */
export function minutesOfDay(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

/** Тихие часы [start, end); интервал может переходить через полночь (20:00–08:00). Кривые значения → тихих часов нет. */
export function inQuietHours(start: string, end: string, now: Date): boolean {
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s === null || e === null || s === e) return false;
  const t = minutesOfDay(now);
  return s < e ? t >= s && t < e : t >= s || t < e;
}

export type NotifyVerdict = { now: true } | { now: false; reason: string };

export async function shouldNotifyNow(db: PrismaClient, leaderId: string, decisionId: string, at: Date = clock.now()): Promise<NotifyVerdict> {
  const leader = await db.leader.findFirst({ where: { id: leaderId }, select: { quietHoursStart: true, quietHoursEnd: true } });
  if (!leader || !inQuietHours(leader.quietHoursStart, leader.quietHoursEnd, at)) return { now: true };

  const src = await db.emailItem.findFirst({ where: { leaderId, decisionId, occurrence: 1 }, select: { category: true, senderEmail: true, riskSignals: true } });
  // Карточка не из письма (поручение, протокол, перенос срока): такие решения ждут руководителя, но не срочны ночью.
  if (!src) return { now: false, reason: "тихие часы" };
  if (src.category && isLockedCategory(src.category)) return { now: true };
  if (hasHardSignal(src.riskSignals as RiskSignal[])) return { now: true };

  const rules = await db.rule.findMany({ where: { leaderId, notifyImmediately: true }, select: { condition: true, expiresAt: true } });
  const now = at;
  const flagged = rules.some((r) => {
    if (r.expiresAt && r.expiresAt <= now) return false;
    const c = (r.condition as { category?: string; senderEmail?: string } | null) ?? {};
    return (c.senderEmail && c.senderEmail.toLowerCase() === src.senderEmail.toLowerCase()) || (c.category && c.category === src.category);
  });
  return flagged ? { now: true } : { now: false, reason: "тихие часы" };
}
