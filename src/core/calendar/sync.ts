/**
 * Синхронизация Google Календаря → Meeting (SPEC 4.5: календарь руководителя).
 * Читаем окно «вчера … +30 дней». Новые встречи создаём, изменившиеся обновляем, исчезнувшие из окна
 * убираем (отмена или отклонённое приглашение), но не трогаем встречи с протоколом, записью или ботом.
 * Поля, которые задал руководитель или помощник (режим участия, повестка, протокол), не перезаписываются.
 * Реальное время Google переводится в демо-время так же, как время писем (SPEC 4.7).
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { clock } from "../clock";
import { decryptJson } from "../connectors/crypto";
import { patchStored, type Stored } from "../connectors/service";
import { defaultParticipation } from "../meetings/participation";
import { getConnectorToolPermission, loadGateLeader } from "../policy-gate";
import { redisLock } from "../mail/poll";
import { categorizeEvent } from "./categorize";
import { createCalendarClient, isCalendarType } from "./factory";
import type { GoogleCalendarClient, RemoteEvent } from "./google";

const DAY = 86_400_000;
const PAST_DAYS = 1;
const AHEAD_DAYS = 30;
/** Префикс externalId: встречи из Google не путаются со встречами датасета, а сидер их не стирает. */
export const GCAL_PREFIX = "gcal:";

export type SyncResult =
  | { ok: true; fetched: number; created: number; updated: number; removed: number }
  | { ok: false; skipped: boolean; message: string };

export interface SyncDeps {
  /** Подмена в тестах: готовый клиент вместо сетевого. */
  client?: Pick<GoogleCalendarClient, "listEvents">;
  lock?: (key: string, ttlSec: number) => Promise<(() => Promise<void>) | null>;
}

export async function syncCalendar(db: PrismaClient, leaderId: string, connectorId: string, deps: SyncDeps = {}): Promise<SyncResult> {
  const row = await db.connector.findFirst({ where: { id: connectorId, leaderId } });
  if (!row || !isCalendarType(row.type)) return { ok: false, skipped: true, message: "Это не календарное подключение" };
  if (!row.isActive) return { ok: false, skipped: true, message: "Подключение выключено" };
  if ((await getConnectorToolPermission(db, leaderId, connectorId, "calendar.read")) === "DENY") {
    return { ok: false, skipped: true, message: "Чтение календаря вам запретили в правах" };
  }
  const release = await (deps.lock ?? redisLock)(`calsync:${connectorId}`, 120);
  if (!release) return { ok: false, skipped: true, message: "Календарь уже проверяют" };

  try {
    const client = deps.client ?? createCalendarClient(db, row);
    if (!client) return { ok: false, skipped: false, message: "Нет доступа к календарю: войдите заново в разделе «Подключения»" };
    const own = decryptJson<Stored>(row.encryptedConfig)?.account ?? null;
    const nowReal = clock.toReal(clock.now());
    const from = new Date(nowReal.getTime() - PAST_DAYS * DAY);
    const to = new Date(nowReal.getTime() + AHEAD_DAYS * DAY);

    const remote = (await client.listEvents(from, to)).filter((e) => !e.declined);
    const protectedBlocks = (await loadGateLeader(db, leaderId)).protectedBlocks;
    const res = await apply(db, leaderId, remote, { from: clock.toDemo(from), to: clock.toDemo(to), own, protectedBlocks });

    if (res.created + res.updated + res.removed > 0) {
      await db.activityLog.create({
        data: {
          leaderId,
          createdAt: clock.now(),
          pipeline: "CALENDAR",
          action: "CALENDAR_SYNCED",
          reason: `Google Календарь: новых встреч ${res.created}, изменилось ${res.updated}, убрано ${res.removed}`,
          metadata: { connectorId, ...res },
        },
      });
    }
    await patchStored(db, row, { lastSync: { at: clock.now().toISOString(), fetched: res.created } });
    return { ok: true, fetched: res.created, ...res };
  } catch (e) {
    const message = (e as Error).message;
    await patchStored(db, row, { lastSync: { at: clock.now().toISOString(), fetched: 0, error: message } }).catch(() => undefined);
    return { ok: false, skipped: false, message };
  } finally {
    await release();
  }
}

async function apply(
  db: PrismaClient,
  leaderId: string,
  remote: RemoteEvent[],
  ctx: { from: Date; to: Date; own: string | null; protectedBlocks: readonly string[] },
): Promise<{ created: number; updated: number; removed: number }> {
  const local = await db.meeting.findMany({ where: { leaderId, externalId: { startsWith: GCAL_PREFIX } } });
  const byId = new Map(local.map((m) => [m.externalId, m]));
  const seen = new Set<string>();
  let created = 0;
  let updated = 0;

  for (const e of remote) {
    const externalId = `${GCAL_PREFIX}${e.id}`;
    seen.add(externalId);
    const startAt = clock.toDemo(e.start);
    const endAt = clock.toDemo(e.end);
    const cur = byId.get(externalId);
    if (cur) {
      const same =
        cur.title === e.title &&
        cur.startAt.getTime() === startAt.getTime() &&
        cur.endAt.getTime() === endAt.getTime() &&
        JSON.stringify(cur.attendees ?? []) === JSON.stringify(e.attendees) &&
        (cur.meetingUrl ?? null) === (e.meetingUrl ?? cur.meetingUrl ?? null);
      if (same) continue;
      await db.meeting.updateMany({
        where: { id: cur.id, leaderId },
        data: { title: e.title, startAt, endAt, attendees: e.attendees, meetingUrl: e.meetingUrl ?? cur.meetingUrl },
      });
      updated++;
      continue;
    }
    const category = categorizeEvent(e.title, e.attendees, ctx.own);
    const prev = await db.meeting.findFirst({ where: { leaderId, title: e.title, startAt: { lt: startAt } }, orderBy: { startAt: "desc" }, select: { id: true } });
    await db.meeting.create({
      data: {
        leaderId,
        externalId,
        title: e.title,
        category,
        startAt,
        endAt,
        attendees: e.attendees,
        meetingUrl: e.meetingUrl,
        participationMode: defaultParticipation(category, e.title, ctx.protectedBlocks),
        previousMeetingId: prev?.id ?? null,
      },
    });
    created++;
  }

  // Встреча в окне, которой нет в ответе Google: отменена или приглашение отклонено.
  let removed = 0;
  for (const m of local) {
    if (seen.has(m.externalId!) || m.startAt < ctx.from || m.startAt >= ctx.to) continue;
    if (m.recallBotId || m.protocolMarkdown || m.transcript) continue; // уже есть работа по встрече: не стираем
    await db.meeting.deleteMany({ where: { id: m.id, leaderId } });
    removed++;
  }
  return { created, updated, removed };
}

/** Все включённые календарные подключения (для воркера). */
export async function activeCalendarConnectors(db: PrismaClient): Promise<{ id: string; leaderId: string }[]> {
  return db.connector.findMany({ where: { isActive: true, type: { in: ["BUILTIN_GOOGLE_CALENDAR"] } }, select: { id: true, leaderId: true } });
}
