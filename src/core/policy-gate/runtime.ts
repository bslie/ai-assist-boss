/**
 * Рантайм Policy Gate (SPEC 4.1): чтение прав инструмента из Connector.toolPermissions
 * и запись каждого вердикта в ActivityLog (pipeline = GATE). Решение принимает чистая `evaluate`.
 */
import { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { clock } from "../clock";
import { ToolPermissionSchema, type GateLeader, type GateResult, type ToolPermission } from "./evaluate";

const PermissionsSchema = z.record(z.string(), ToolPermissionSchema);

export const TELEGRAM_CONNECTOR = "BUILTIN_TELEGRAM";

/** Права инструмента руководителя. Нет коннектора, записи или она битая → null (шлюз трактует как APPROVE). */
export async function getToolPermission(
  db: PrismaClient,
  leaderId: string,
  connectorType: string,
  toolName: string,
): Promise<ToolPermission | null> {
  const connector = await db.connector.findFirst({ where: { leaderId, type: connectorType, isActive: true } });
  if (!connector) return null;
  const parsed = PermissionsSchema.safeParse(connector.toolPermissions);
  return parsed.success ? (parsed.data[toolName] ?? null) : null;
}

/** Права инструмента конкретного подключения (когда подключений одного типа может быть несколько). */
export async function getConnectorToolPermission(
  db: PrismaClient,
  leaderId: string,
  connectorId: string,
  toolName: string,
): Promise<ToolPermission | null> {
  const connector = await db.connector.findFirst({ where: { id: connectorId, leaderId, isActive: true } });
  if (!connector) return null;
  const parsed = PermissionsSchema.safeParse(connector.toolPermissions);
  return parsed.success ? (parsed.data[toolName] ?? null) : null;
}

export async function loadGateLeader(db: PrismaClient, leaderId: string): Promise<GateLeader> {
  const l = await db.leader.findFirstOrThrow({
    where: { id: leaderId },
    select: { budgetAutoLimit: true, protectedBlocks: true, shadowMode: true, learningMode: true, trustedScopes: true },
  });
  return {
    budgetAutoLimit: l.budgetAutoLimit,
    protectedBlocks: l.protectedBlocks,
    shadowMode: l.shadowMode,
    learningMode: l.learningMode,
    trustedScopes: l.trustedScopes,
  };
}

/** Каждый вердикт — в журнал с причинами. `savedMinutes` начисляется только за ALLOW. */
export async function logVerdict(
  db: PrismaClient,
  leaderId: string,
  toolName: string,
  result: GateResult,
  opts: { savedMinutes?: number; metadata?: Prisma.InputJsonValue } = {},
): Promise<void> {
  await db.activityLog.create({
    data: {
      leaderId,
      createdAt: clock.now(),
      pipeline: "GATE",
      action: `${result.verdict}:${toolName}`,
      reason: result.reasons.join("; "),
      savedMinutes: result.verdict === "ALLOW" ? (opts.savedMinutes ?? 0) : 0,
      metadata: { signals: result.signals, ...(opts.metadata as object | undefined) } as Prisma.InputJsonValue,
    },
  });
}
