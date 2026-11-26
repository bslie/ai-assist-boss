/**
 * Правила руководителя (SPEC 6: /api/rules). Системные правила и защищённые категории
 * нельзя ослабить ни правилом, ни PATCH-ом: fail closed, ответ с объяснением.
 */
import { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { EMAIL_ACTIONS, EMAIL_CATEGORIES } from "./email-triage/classify";
import { isLockedCategory } from "./policy-gate";

export const CreateRuleSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(500),
  category: z.enum(EMAIL_CATEGORIES),
  action: z.enum(EMAIL_ACTIONS),
  delegateToArea: z.string().min(1).nullable().optional(),
  notifyImmediately: z.boolean().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
});
export type CreateRuleInput = z.infer<typeof CreateRuleSchema>;

export const PatchSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rule"),
    id: z.string().min(1),
    patch: z.object({
      name: z.string().min(1).max(120).optional(),
      description: z.string().min(1).max(500).optional(),
      action: z.enum(EMAIL_ACTIONS).optional(),
      delegateToArea: z.string().min(1).nullable().optional(),
      notifyImmediately: z.boolean().optional(),
      expiresAt: z.coerce.date().nullable().optional(),
    }),
  }),
  z.object({
    kind: z.literal("settings"),
    budgetAutoLimit: z.number().finite().min(0).optional(),
    protectedBlocks: z.array(z.string().min(1)).optional(),
  }),
]);
export type PatchInput = z.infer<typeof PatchSchema>;

export type RuleError = { ok: false; code: "NOT_FOUND" | "LOCKED"; message: string };
export type RuleOk<T> = { ok: true; value: T };

const LOCKED_CATEGORY_MSG = (c: string) =>
  `Категория ${c} защищена: её нельзя перевести в авто ни правилом, ни словами. Допустимо только «спросить руководителя».`;

export async function listRules(db: PrismaClient, leaderId: string) {
  const [leader, rules] = await Promise.all([
    db.leader.findFirstOrThrow({ where: { id: leaderId }, select: { budgetAutoLimit: true, protectedBlocks: true } }),
    db.rule.findMany({ where: { leaderId }, orderBy: [{ priority: "asc" }, { createdAt: "asc" }] }),
  ]);
  return { settings: leader, rules };
}

export async function createRule(db: PrismaClient, leaderId: string, input: CreateRuleInput): Promise<RuleOk<{ id: string }> | RuleError> {
  if (isLockedCategory(input.category) && input.action !== "ASK_LEADER") {
    return { ok: false, code: "LOCKED", message: LOCKED_CATEGORY_MSG(input.category) };
  }
  const rule = await db.rule.create({
    data: {
      leaderId,
      name: input.name,
      description: input.description,
      condition: { category: input.category } as Prisma.InputJsonValue,
      action: input.action,
      delegateToArea: input.delegateToArea ?? null,
      notifyImmediately: input.notifyImmediately ?? false,
      expiresAt: input.expiresAt ?? null,
      source: "MANUAL",
      priority: 100,
    },
  });
  return { ok: true, value: { id: rule.id } };
}

export async function patchRules(db: PrismaClient, leaderId: string, input: PatchInput): Promise<RuleOk<null> | RuleError> {
  if (input.kind === "settings") {
    const data: Prisma.LeaderUpdateManyMutationInput = {};
    if (input.budgetAutoLimit !== undefined) data.budgetAutoLimit = input.budgetAutoLimit;
    if (input.protectedBlocks !== undefined) data.protectedBlocks = input.protectedBlocks;
    await db.leader.updateMany({ where: { id: leaderId }, data });
    return { ok: true, value: null };
  }

  const rule = await db.rule.findFirst({ where: { id: input.id, leaderId } });
  if (!rule) return { ok: false, code: "NOT_FOUND", message: "Правило не найдено" };
  if (rule.isSystemLocked) {
    return { ok: false, code: "LOCKED", message: "Системное правило нельзя изменить: оно защищает кадры, деньги, руководство и обязательства клиентам." };
  }
  const category = (rule.condition as { category?: string } | null)?.category;
  if (input.patch.action && input.patch.action !== "ASK_LEADER" && category && isLockedCategory(category)) {
    return { ok: false, code: "LOCKED", message: LOCKED_CATEGORY_MSG(category) };
  }
  await db.rule.updateMany({ where: { id: input.id, leaderId }, data: input.patch });
  return { ok: true, value: null };
}
