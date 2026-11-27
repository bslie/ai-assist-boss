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
import { isLockedCategory, TELEGRAM_CONNECTOR } from "../policy-gate";

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

export interface ProfileWarning {
  rule: string;
  message: string;
}

/** Приводит черновик к инвариантам. Всё, что ослабляет защиту, отбрасывается с предупреждением. */
export function sanitizeDraft(draft: ProfileDraft): { draft: ProfileDraft; warnings: ProfileWarning[] } {
  const warnings: ProfileWarning[] = [];
  const allowed = draft.allowed.filter((r) => {
    if (isLockedCategory(r.category) && r.action !== "ASK_LEADER") {
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

/** Имя правила для людей: модель иногда отдаёт технический ключ («money»), тогда берём описание. */
export function ruleLabel(r: { name: string; description: string }): string {
  return /^[\w\s-]+$/.test(r.name.trim()) && r.description.trim() ? r.description.trim() : r.name.trim();
}

/** Смысл правила: системное ли, категория, действие. Имя не в счёт — его модель формулирует по-разному. */
const meaningKey = (locked: boolean, category: unknown, action: string) => `${locked ? "L" : "U"}|${String(category ?? "")}|${action}`;

/** Diff-превью для подтверждения в вебе перед записью. Сравнение по смыслу, а не по формулировке. */
export async function diffProfile(db: PrismaClient, leaderId: string, draft: ProfileDraft): Promise<ProfileDiff> {
  const leader = await db.leader.findFirstOrThrow({ where: { id: leaderId } });
  const rules = await db.rule.findMany({ where: { leaderId, source: "PROFILE_IMPORT" } });
  const routines = await db.routine.findMany({ where: { leaderId } });
  const split = (before: string[], after: string[]) => ({
    added: after.filter((x) => !before.includes(x)),
    removed: before.filter((x) => !after.includes(x)),
  });
  const before = rules.map((r) => ({ key: meaningKey(r.isSystemLocked, (r.condition as { category?: unknown } | null)?.category, r.action), label: r.name }));
  const after = [
    ...draft.neverWithoutApproval.map((r) => ({ key: meaningKey(true, r.category, "ASK_LEADER"), label: ruleLabel(r) })),
    ...draft.allowed.map((r) => ({ key: meaningKey(false, r.category, r.action), label: ruleLabel(r) })),
  ];
  const beforeKeys = new Set(before.map((r) => r.key));
  const afterKeys = new Set(after.map((r) => r.key));
  const newLimit = draft.budgetAutoLimit ?? leader.budgetAutoLimit;
  return {
    goals: split((leader.quarterGoals as string[]) ?? [], draft.goals),
    rules: {
      added: after.filter((r) => !beforeKeys.has(r.key)).map((r) => r.label),
      removed: before.filter((r) => !afterKeys.has(r.key)).map((r) => r.label),
    },
    // applyProfile рутины не удаляет (только добавляет и обновляет), поэтому и в diff только добавленные.
    routines: { added: draft.routines.filter((r) => !routines.some((x) => x.code === r.code)).map((r) => r.title), removed: [] },
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
          name: ruleLabel(r),
          description: r.description,
          condition: { category: r.category },
          action: "ASK_LEADER" as const,
          isSystemLocked: true,
          source: "PROFILE_IMPORT",
          priority: i, // системные выше всех
        })),
        ...safe.allowed.map((r, i) => ({
          leaderId,
          name: ruleLabel(r),
          description: r.description,
          condition: { category: r.category },
          action: r.action,
          delegateToArea: r.delegateToArea,
          source: "PROFILE_IMPORT",
          priority: 100 + i,
        })),
      ],
    });

    // Коннектор Telegram: права по умолчанию выводятся из профиля. Если в профиле есть правило
    // «передавать ответственному», поручения сотрудникам идут сами (AUTO), иначе спрашиваем (APPROVE).
    // Уже существующий коннектор не трогаем: там права, выставленные руководителем.
    const hasConnector = await tx.connector.findFirst({ where: { leaderId, type: TELEGRAM_CONNECTOR }, select: { id: true } });
    if (!hasConnector) {
      const delegates = safe.allowed.some((r) => r.action === "DELEGATE");
      await tx.connector.create({
        data: {
          leaderId,
          name: "Telegram",
          type: TELEGRAM_CONNECTOR,
          encryptedConfig: "", // токен бота лежит в env воркера, в БД секретов нет
          toolPermissions: {
            "telegram.assign_task": delegates ? "AUTO" : "APPROVE",
            "telegram.send_digest": "AUTO",
          },
        },
      });
    }

    const hasGuard = safe.routines.some((r) => r.code === "DEADLINE_GUARD") || (await tx.routine.findFirst({ where: { leaderId, code: "DEADLINE_GUARD" }, select: { id: true } }));
    if (!hasGuard) {
      await tx.routine.create({
        data: { leaderId, code: "DEADLINE_GUARD", title: "Контроль сроков", cronExpression: "*/30 * * * *", promptInstruction: "За 24 часа до срока — чек-ин исполнителю, при просрочке — напоминание, через сутки — эскалация руководителю." },
      });
    }

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
