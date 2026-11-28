/**
 * Сброс руководителя до «первого входа» (панель управления): настройки, выученное, подключения и история разбора.
 * Остаются профиль, сотрудники, поручения, встречи, привязка Telegram, журнал стоимости запросов и системные правила.
 * Всё строго в рамках одного leaderId.
 */
import type { PrismaClient } from "@/generated/prisma/client";

export interface ResetReport {
  memories: number;
  rules: number;
  connectors: number;
  emails: number;
  decisions: number;
  activity: number;
}

export async function resetLeaderToFirstRun(db: PrismaClient, leaderId: string): Promise<ResetReport> {
  return db.$transaction(async (tx) => {
    await tx.leader.update({ where: { id: leaderId }, data: { learningMode: true, trustedScopes: [], budgetAutoLimit: 0 } });
    // Правила из профиля и системные (защищённые) не трогаем: их нельзя ослабить, а профиль остаётся исходным.
    const rules = await tx.rule.deleteMany({ where: { leaderId, isSystemLocked: false, source: { not: "PROFILE_IMPORT" } } });
    const memories = await tx.memory.deleteMany({ where: { leaderId } });
    await tx.businessPending.deleteMany({ where: { leaderId } });
    await tx.businessConnection.deleteMany({ where: { leaderId } });
    const connectors = await tx.connector.deleteMany({ where: { leaderId } });
    const emails = await tx.emailItem.deleteMany({ where: { leaderId } });
    const decisions = await tx.decision.deleteMany({ where: { leaderId } });
    const activity = await tx.activityLog.deleteMany({ where: { leaderId } });
    return { memories: memories.count, rules: rules.count, connectors: connectors.count, emails: emails.count, decisions: decisions.count, activity: activity.count };
  });
}
