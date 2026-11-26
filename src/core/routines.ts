/**
 * Рутины руководителя (SPEC 4.7, страница «Рутины»): включить, выключить, сменить расписание.
 * Расписание — cron в демо-времени, проверяется тем же парсером, что и планировщик.
 */
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";

export const PatchRoutineSchema = z
  .object({
    id: z.string().min(1),
    isActive: z.boolean().optional(),
    cronExpression: z.string().trim().regex(/^\S+( \S+){4}$/, "Нужно пять полей cron, например «30 8 * * 1-5»").optional(),
  })
  .refine((v) => v.isActive !== undefined || v.cronExpression !== undefined, { message: "Нечего менять" });
export type PatchRoutineInput = z.infer<typeof PatchRoutineSchema>;

export const validCron = (expr: string): boolean => {
  try {
    CronExpressionParser.parse(expr, { tz: "Europe/Moscow" });
    return true;
  } catch {
    return false;
  }
};

export async function listRoutines(db: PrismaClient, leaderId: string) {
  return db.routine.findMany({ where: { leaderId }, orderBy: { code: "asc" } });
}

export type PatchRoutineResult = { ok: true } | { ok: false; code: "NOT_FOUND" | "BAD_CRON"; message: string };

export async function patchRoutine(db: PrismaClient, leaderId: string, input: PatchRoutineInput): Promise<PatchRoutineResult> {
  if (input.cronExpression !== undefined && !validCron(input.cronExpression)) {
    return { ok: false, code: "BAD_CRON", message: "Не получилось разобрать расписание" };
  }
  // updateMany с leaderId: чужую рутину изменить нельзя.
  const res = await db.routine.updateMany({
    where: { id: input.id, leaderId },
    data: { ...(input.isActive !== undefined ? { isActive: input.isActive } : {}), ...(input.cronExpression !== undefined ? { cronExpression: input.cronExpression } : {}) },
  });
  return res.count === 0 ? { ok: false, code: "NOT_FOUND", message: "Рутина не найдена" } : { ok: true };
}

const DOW: Record<string, string> = { "1-5": "по будням", "*": "каждый день", "1": "по понедельникам", "5": "по пятницам" };

/** «30 8 * * 1-5» → «по будням в 08:30»; сложные выражения показываем как есть. */
export function describeCron(expr: string): string {
  const [min, hour, dom, mon, dow] = expr.split(" ");
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && mon === "*" && DOW[dow]) return `${DOW[dow]} в ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  if (min.startsWith("*/") && hour === "*" && dom === "*" && mon === "*" && dow === "*") return `каждые ${min.slice(2)} мин`;
  return expr;
}
