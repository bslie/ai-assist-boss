/**
 * Выученные правила (Memory) для экрана «Как я работаю»: показать и забыть.
 * Все запросы по leaderId. Предложения, ждущие ответа в Telegram (isActive=false), не показываем.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { publishEvent } from "./events";

export interface LearnedRule {
  id: string;
  ruleText: string;
  scope: string;
  sourceType: string;
  createdAt: Date;
}

export async function listLearned(db: PrismaClient, leaderId: string): Promise<LearnedRule[]> {
  return db.memory.findMany({
    where: { leaderId, isActive: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, ruleText: true, scope: true, sourceType: true, createdAt: true },
  });
}

/** «Забыть»: правило пропадает из следующих черновиков. Чужое правило удалить нельзя. */
export async function forgetMemory(db: PrismaClient, leaderId: string, memoryId: string): Promise<boolean> {
  const res = await db.memory.deleteMany({ where: { id: memoryId, leaderId, isActive: true } });
  if (res.count === 0) return false;
  await publishEvent(leaderId, { type: "metrics.updated", data: {} });
  return true;
}
