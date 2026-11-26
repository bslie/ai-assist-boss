/**
 * Импорт профиля руководителя (SPEC 4.6): markdown → ProfileDraft → diff → запись.
 * Профиль — настройки, а не код: цели, правила, ритм, стиль, порог бюджета.
 * Инвариант: «никогда без подтверждения» всегда становится системным правилом,
 * а правила «можно без подтверждения» для защищённых категорий отбрасываются.
 */
import { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { EMAIL_ACTIONS, EMAIL_CATEGORIES } from "../email-triage/classify";
import type { LlmClient } from "../llm";
import { PROTECTED_CATEGORIES } from "../policy-gate";

const Category = z.enum(EMAIL_CATEGORIES);

export const ProfileDraftSchema = z.object({
  goals: z.array(z.string().min(1)),
  /** «Никогда без подтверждения» → Rule.isSystemLocked. */
  neverWithoutApproval: z.array(z.object({ name: z.string(), description: z.string(), category: Category })),
  /** «Можно без подтверждения» → обычные правила. */
  allowed: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      category: Category,
      action: z.enum(EMAIL_ACTIONS),
      delegateToArea: z.string().nullable(),
    }),
  ),
  routines: z.array(
    z.object({
      code: z.enum(["MORNING_DIGEST", "WEEKLY_REPORT", "DEADLINE_GUARD", "CUSTOM"]),
      title: z.string(),
      /** Cron в демо-времени, например "30 8 * * 1-5". */
      cronExpression: z.string().regex(/^\S+( \S+){4}$/),
      promptInstruction: z.string(),
    }),
  ),
  protectedBlocks: z.array(z.string()),
  stylePrompt: z.string(),
  budgetAutoLimit: z.number().min(0).nullable(),
});
export type ProfileDraft = z.infer<typeof ProfileDraftSchema>;

const isProtected = (c: string) => (PROTECTED_CATEGORIES as readonly string[]).includes(c) || c === "MONEY";

export interface ProfileWarning {
  rule: string;
  message: string;
}

/** Приводит черновик к инвариантам. Всё, что ослабляет защиту, отбрасывается с предупреждением. */
export function sanitizeDraft(draft: ProfileDraft): { draft: ProfileDraft; warnings: ProfileWarning[] } {
  const warnings: ProfileWarning[] = [];
  const allowed = draft.allowed.filter((r) => {
    if (isProtected(r.category) && r.action !== "ASK_LEADER") {
      warnings.push({ rule: r.name, message: `Категория ${r.category} защищена: правило отброшено` });
      return false;
    }
    return true;
  });
  return { draft: { ...draft, allowed }, warnings };
}

const SYSTEM = [
  "Ты превращаешь профиль руководителя (markdown) в структурированные настройки.",
  "Правила из раздела «Никогда без подтверждения» кладёшь в neverWithoutApproval, «Можно без подтверждения» — в allowed.",
  `Категории писем: ${EMAIL_CATEGORIES.join(", ")}. Действия: ${EMAIL_ACTIONS.join(", ")}.`,
  "Для передачи ответственному укажи delegateToArea (КП → «продажи», жалоба → «сервис», доступы → «доступы»).",
  "Ритм из профиля превращай в cron (пн–пт 8:30 → «30 8 * * 1-5», пт 17:00 → «0 17 * * 5»).",
  "Ничего не выдумывай: если порог бюджета не указан, budgetAutoLimit = null.",
].join(" ");

export async function importProfile(
  llm: LlmClient,
  leaderId: string,
  markdown: string,
): Promise<{ draft: ProfileDraft; warnings: ProfileWarning[] }> {
  const raw = await llm.generateStructured({
    leaderId,
    pipeline: "PROFILE_IMPORT",
    schema: ProfileDraftSchema,
    system: SYSTEM,
    prompt: markdown,
    cacheKey: markdown,
    temperature: 0,
  });
  return sanitizeDraft(raw);
}

export interface ProfileDiff {
  goals: { added: string[]; removed: string[] };
  rules: { added: string[]; removed: string[] };
  routines: { added: string[]; removed: string[] };
  budgetAutoLimit: { from: number; to: number } | null;
  profileVersion: { from: number; to: number };
}

const ruleKey = (name: string) => name.trim().toLowerCase();

/** Diff-превью для подтверждения в вебе перед записью. */
export async function diffProfile(db: PrismaClient, leaderId: string, draft: ProfileDraft): Promise<ProfileDiff> {
  const leader = await db.leader.findFirstOrThrow({ where: { id: leaderId } });
  const rules = await db.rule.findMany({ where: { leaderId, source: "PROFILE_IMPORT" } });
  const routines = await db.routine.findMany({ where: { leaderId } });
  const split = (before: string[], after: string[]) => ({
    added: after.filter((x) => !before.includes(x)),
    removed: before.filter((x) => !after.includes(x)),
  });
  const newRules = [...draft.neverWithoutApproval, ...draft.allowed].map((r) => ruleKey(r.name));
  const newLimit = draft.budgetAutoLimit ?? leader.budgetAutoLimit;
  return {
    goals: split((leader.quarterGoals as string[]) ?? [], draft.goals),
    rules: split(rules.map((r) => ruleKey(r.name)), newRules),
    routines: split(routines.map((r) => r.code), draft.routines.map((r) => r.code)),
    budgetAutoLimit: newLimit === leader.budgetAutoLimit ? null : { from: leader.budgetAutoLimit, to: newLimit },
    profileVersion: { from: leader.profileVersion, to: leader.profileVersion + 1 },
  };
}

/**
 * Записывает подтверждённый профиль. Правила, пришедшие не из профиля (чат, обучение на правках),
 * сохраняются. Всё в одной транзакции.
 */
export async function applyProfile(
  db: PrismaClient,
  leaderId: string,
  draft: ProfileDraft,
  markdown: string,
): Promise<void> {
  const { draft: safe } = sanitizeDraft(draft);
  await db.$transaction(async (tx) => {
    const leader = await tx.leader.findFirstOrThrow({ where: { id: leaderId } });
    await tx.leader.update({
      where: { id: leaderId },
      data: {
        quarterGoals: safe.goals as Prisma.InputJsonValue,
        stylePrompt: safe.stylePrompt,
        profileMarkdown: markdown,
        profileVersion: leader.profileVersion + 1,
        ...(safe.budgetAutoLimit !== null ? { budgetAutoLimit: safe.budgetAutoLimit } : {}),
        ...(safe.protectedBlocks.length ? { protectedBlocks: safe.protectedBlocks } : {}),
      },
    });

    await tx.rule.deleteMany({ where: { leaderId, source: "PROFILE_IMPORT" } });
    await tx.rule.createMany({
      data: [
        ...safe.neverWithoutApproval.map((r, i) => ({
          leaderId,
          name: r.name,
          description: r.description,
          condition: { category: r.category },
          action: "ASK_LEADER" as const,
          isSystemLocked: true,
          source: "PROFILE_IMPORT",
          priority: i, // системные выше всех
        })),
        ...safe.allowed.map((r, i) => ({
          leaderId,
          name: r.name,
          description: r.description,
          condition: { category: r.category },
          action: r.action,
          delegateToArea: r.delegateToArea,
          source: "PROFILE_IMPORT",
          priority: 100 + i,
        })),
      ],
    });

    for (const r of safe.routines) {
      const existing = await tx.routine.findFirst({ where: { leaderId, code: r.code, title: r.title } });
      if (existing) {
        await tx.routine.update({
          where: { id: existing.id },
          data: { cronExpression: r.cronExpression, promptInstruction: r.promptInstruction },
        });
      } else {
        await tx.routine.create({ data: { leaderId, ...r } });
      }
    }
  });
}
