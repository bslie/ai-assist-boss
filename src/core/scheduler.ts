/**
 * Тик-планировщик (SPEC 4.7). Cron-повторы BullMQ идут по реальному времени, а рутины живут
 * в демо-времени, поэтому раз в минуту воркер берёт clock.now() и проверяет, какие Routine
 * должны были сработать после последнего запуска. Перемотка часов вперёд срабатывает сразу.
 */
import { CronExpressionParser } from "cron-parser";
import type { PrismaClient, Routine } from "@/generated/prisma/client";
import { clock } from "./clock";

/** Cron в профиле записан во времени руководителя (SPEC: «30 8 * * 1-5»). */
const TZ = "Europe/Moscow";

export interface RoutineJob {
  routineId: string;
  leaderId: string;
  code: string;
  /** Момент по cron, который наступил (демо-время, ISO). Часть jobId → идемпотентность. */
  firedAt: string;
}

export interface JobQueue {
  enqueue(job: RoutineJob): Promise<void>;
}

/** Последний момент по cron не позже `now`, либо null при кривом выражении. */
export function lastFire(cron: string, now: Date): Date | null {
  try {
    // prev() не включает текущий момент: сдвигаем на секунду, чтобы ровно в минуту срабатывания рутина не пропадала.
    const it = CronExpressionParser.parse(cron, { currentDate: new Date(now.getTime() + 1000), tz: TZ });
    let fire = it.prev().toDate();
    if (fire > now) fire = it.prev().toDate(); // момент в ближайшую секунду ещё не наступил
    return fire;
  } catch {
    return null;
  }
}

/** Если запусков ещё не было (или часы отмотали назад), догоняем пропущенное не глубже чем на сутки. */
const CATCH_UP_MS = 24 * 3_600_000;

/**
 * Какие рутины пора запускать. Точка отсчёта — lastRunAt. За один тик каждая рутина
 * срабатывает не более раза, даже если часы перемотали на несколько дней.
 */
export function dueRoutines(routines: readonly Routine[], now: Date): { routine: Routine; firedAt: Date }[] {
  const due: { routine: Routine; firedAt: Date }[] = [];
  for (const r of routines) {
    if (!r.isActive) continue;
    const fire = lastFire(r.cronExpression, now);
    if (!fire) continue;
    const baseline = r.lastRunAt && r.lastRunAt <= now ? r.lastRunAt : new Date(now.getTime() - CATCH_UP_MS);
    if (fire > baseline) due.push({ routine: r, firedAt: fire });
  }
  return due;
}

export async function tick(db: PrismaClient, queue: JobQueue): Promise<number> {
  await clock.sync();
  const now = clock.now();
  const routines = await db.routine.findMany({ where: { isActive: true } });
  const due = dueRoutines(routines, now);
  for (const { routine, firedAt } of due) {
    // Сначала фиксируем запуск (условно, чтобы два тика не взяли одну рутину), затем ставим в очередь.
    const claimed = await db.routine.updateMany({
      where: { id: routine.id, leaderId: routine.leaderId, lastRunAt: routine.lastRunAt },
      data: { lastRunAt: now },
    });
    if (claimed.count === 0) continue;
    await queue.enqueue({ routineId: routine.id, leaderId: routine.leaderId, code: routine.code, firedAt: firedAt.toISOString() });
  }
  return due.length;
}
