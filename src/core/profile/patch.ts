/**
 * Точечная правка профиля из чата (SPEC 1.1, «Управление через чат»): цели квартала, манера писем, порог по деньгам.
 * Правила и рутины здесь не трогаем: для них есть свои пути (RULE, ROUTINE). Текст профиля обновляется
 * детерминированно, чтобы страница «Профиль» и настройки не расходились.
 */
import { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

export const ProfilePatchSchema = z
  .object({
    /** Полный новый список целей. */
    goals: z.array(z.string().trim().min(3).max(300)).max(10).optional(),
    stylePrompt: z.string().trim().min(3).max(500).optional(),
    budgetAutoLimit: z.number().int().min(0).max(100_000_000).optional(),
  })
  .refine((v) => v.goals !== undefined || v.stylePrompt !== undefined || v.budgetAutoLimit !== undefined, { message: "Нечего менять" });
export type ProfilePatch = z.infer<typeof ProfilePatchSchema>;

const money = (n: number) => `${n.toLocaleString("ru-RU")} ₽`.replace(/ /g, " ");

/** Заменяет тело раздела `## …` (первого, чей заголовок подходит под `heading`); нет раздела — добавляет в конец. */
function replaceSection(md: string, heading: RegExp, title: string, body: (old: string) => string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^##\s/.test(l) && heading.test(l));
  if (start === -1) return `${lines.join("\n").trimEnd()}\n\n## ${title}\n${body("")}\n`;
  let end = lines.findIndex((l, i) => i > start && /^#{1,2}\s/.test(l));
  if (end === -1) end = lines.length;
  const old = lines.slice(start + 1, end).join("\n").trim();
  return [...lines.slice(0, start + 1), body(old), "", ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function patchMarkdown(md: string, p: ProfilePatch): string {
  let out = md;
  if (p.goals) {
    const goals = p.goals;
    out = replaceSection(out, /цел/i, "Цели на квартал", () => `\n${goals.map((g, i) => `${i + 1}. ${g}`).join("\n")}`);
  }
  if (p.budgetAutoLimit !== undefined) {
    const sum = money(p.budgetAutoLimit);
    const zero = p.budgetAutoLimit === 0;
    out = replaceSection(out, /порог/i, "Порог по деньгам", (old) => {
      if (/\d[\d\s]*\s?(₽|руб)/.test(old)) return `\n${old.replace(/\d[\d\s]*\s?(?:₽|руб\.?)/, sum)}`;
      return `\n${zero ? "Любые деньги согласую только я." : `Расходы до ${sum} можно согласовывать без меня, итог показывать в сводке. Всё, что выше, согласую только я.`}`;
    });
  }
  if (p.stylePrompt) {
    const style = p.stylePrompt;
    out = replaceSection(out, /стиль|манер/i, "Стиль общения", () => `\n${style}`);
  }
  return out;
}

/** Записывает правку одной транзакцией и поднимает версию профиля. */
export async function applyProfilePatch(db: PrismaClient, leaderId: string, patch: ProfilePatch): Promise<{ profileVersion: number }> {
  return db.$transaction(async (tx) => {
    const leader = await tx.leader.findFirstOrThrow({ where: { id: leaderId }, select: { profileMarkdown: true, profileVersion: true } });
    const profileVersion = leader.profileVersion + 1;
    await tx.leader.update({
      where: { id: leaderId },
      data: {
        profileMarkdown: patchMarkdown(leader.profileMarkdown, patch),
        profileVersion,
        ...(patch.goals ? { quarterGoals: patch.goals as Prisma.InputJsonValue } : {}),
        ...(patch.stylePrompt ? { stylePrompt: patch.stylePrompt } : {}),
        ...(patch.budgetAutoLimit !== undefined ? { budgetAutoLimit: patch.budgetAutoLimit } : {}),
      },
    });
    return { profileVersion };
  });
}
