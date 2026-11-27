/**
 * Письма, которые помощник или руководитель уже отработали, помечаются прочитанными в ящике.
 * Проигнорированные (служебные уведомления, рассылки) остаются непрочитанными: ящик ещё не заменён помощником,
 * и руководитель сам заглянет в них при случае.
 *
 * «Отработано»: действие AUTO или DIGEST; передача сотруднику с созданной задачей; карточка, по которой
 * руководитель принял решение (утвердил, поправил, передал, отклонил; «не сейчас» не считается).
 * Пометка идёт через Policy Gate: право `mail.mark_read` у подключения, как у остальных действий во внешней почте.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { clock } from "../clock";
import { getModule } from "../connectors/modules";
import { evaluate, getConnectorToolPermission, loadGateLeader, logVerdict } from "../policy-gate";
import { createMailConnector } from "./factory";

export const MARK_READ_TOOL = "mail.mark_read";
const LOOKBACK_MS = 7 * 86_400_000;
const BATCH = 50;
const RESOLVED = ["APPROVED", "EDITED_APPROVED", "DELEGATED", "REJECTED"] as const;

/** Права на пометку: запись подключения, а если её нет (подключение старше инструмента) — значение из манифеста. */
async function permissionFor(db: PrismaClient, leaderId: string, connectorId: string, type: string) {
  const stored = await getConnectorToolPermission(db, leaderId, connectorId, MARK_READ_TOOL);
  if (stored) return stored;
  return getModule(type)?.tools.find((t) => t.name === MARK_READ_TOOL)?.default ?? null;
}

/** Помечает прочитанными все отработанные письма руководителя, которые ещё не помечены. Возвращает, сколько помечено. */
export async function markHandledEmails(db: PrismaClient, leaderId: string): Promise<number> {
  const since = new Date(clock.now().getTime() - LOOKBACK_MS);
  const candidates = await db.emailItem.findMany({
    where: { leaderId, connectorId: { not: null }, externalId: { not: null }, readMarkedAt: null, receivedAt: { gte: since } },
    orderBy: { receivedAt: "asc" },
    take: 300,
    select: { id: true, externalId: true, connectorId: true, action: true, taskId: true, decisionId: true },
  });
  if (candidates.length === 0) return 0;

  const decisionIds = [...new Set(candidates.map((c) => c.decisionId).filter((x): x is string => Boolean(x)))];
  const resolved = new Set(
    decisionIds.length ? (await db.decision.findMany({ where: { id: { in: decisionIds }, leaderId, status: { in: [...RESOLVED] } }, select: { id: true } })).map((d) => d.id) : [],
  );
  const handled = candidates.filter(
    (c) => c.action === "AUTO" || c.action === "DIGEST" || (c.action === "DELEGATE" && c.taskId !== null) || (c.decisionId !== null && resolved.has(c.decisionId)),
  );

  const byConnector = new Map<string, typeof handled>();
  for (const c of handled.slice(0, BATCH)) byConnector.set(c.connectorId!, [...(byConnector.get(c.connectorId!) ?? []), c]);

  const leader = await loadGateLeader(db, leaderId);
  let marked = 0;
  for (const [connectorId, items] of byConnector) {
    const row = await db.connector.findFirst({ where: { id: connectorId, leaderId, isActive: true } });
    if (!row) continue;
    const mail = createMailConnector(db, row);
    if (!mail?.markRead) continue;
    // Пометка — не решение по письму, поэтому категория и сигналы риска здесь не участвуют: решает право подключения.
    // Включение инструмента в «Подключениях» — постоянное согласие руководителя (approvedByLeader).
    const verdict = evaluate(MARK_READ_TOOL, { leader, toolPermission: await permissionFor(db, leaderId, connectorId, row.type), approvedByLeader: true });
    await logVerdict(db, leaderId, MARK_READ_TOOL, verdict, { metadata: { connectorId, emails: items.length } });
    if (verdict.verdict !== "ALLOW") continue;
    for (const it of items) {
      try {
        await mail.markRead(it.externalId!);
        await db.emailItem.updateMany({ where: { id: it.id, leaderId }, data: { readMarkedAt: clock.now() } });
        marked++;
      } catch {
        // Не вышло (нет прав у токена, письмо удалено): остаётся непрочитанным, попробуем при следующей проверке.
      }
    }
  }
  return marked;
}
