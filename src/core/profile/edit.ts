/**
 * Правка профиля словами (чат): одна дешёвая структурная правка вместо переписывания всего профиля.
 * Ничего не пишется до подтверждения: запись идёт кнопкой через PATCH /api/profile.
 */
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import type { LlmClient } from "../llm";
import type { ProfilePatch } from "./patch";

const EditSchema = z.object({
  /** Полный новый список целей, если просят их изменить; иначе null. */
  goals: z.array(z.string().min(3).max(300)).max(10).nullable(),
  /** Новая манера писем одним-двумя предложениями; иначе null. */
  stylePrompt: z.string().min(3).max(500).nullable(),
  /** Новый порог по деньгам в рублях (целое число); иначе null. */
  budgetAutoLimit: z.number().min(0).max(100_000_000).nullable(),
});

const SYSTEM = [
  "Ты вносишь правку в профиль руководителя по его просьбе. Верни только те поля, которые он просит изменить, остальные null.",
  "goals — ПОЛНЫЙ новый список целей: возьми текущие, примени просьбу (добавить, убрать, переформулировать), остальные оставь дословно.",
  "stylePrompt — полный новый текст манеры писем: текущий с учётом просьбы. budgetAutoLimit — число в рублях («50 тысяч» → 50000).",
  "Ничего не выдумывай: числа и формулировки бери только из просьбы. Если просьба не про цели, манеру писем или порог по деньгам, верни все null.",
].join(" ");

export type ProfileEditResult =
  | { ok: true; patch: ProfilePatch; goals?: { added: string[]; removed: string[] }; style?: string; budget?: { from: number; to: number } }
  | { ok: false; message: string };

export async function proposeProfileEdit(db: PrismaClient, llm: LlmClient, leaderId: string, instruction: string): Promise<ProfileEditResult> {
  const leader = await db.leader.findFirstOrThrow({ where: { id: leaderId }, select: { quarterGoals: true, stylePrompt: true, budgetAutoLimit: true } });
  const goals = (leader.quarterGoals as string[]) ?? [];
  const res = await llm.generateStructured({
    leaderId,
    pipeline: "PROFILE_IMPORT",
    schema: EditSchema,
    system: SYSTEM,
    prompt: [
      `ЦЕЛИ СЕЙЧАС:\n${goals.map((g, i) => `${i + 1}. ${g}`).join("\n") || "нет"}`,
      `МАНЕРА ПИСЕМ СЕЙЧАС: ${leader.stylePrompt || "не задана"}`,
      `ПОРОГ ПО ДЕНЬГАМ СЕЙЧАС: ${leader.budgetAutoLimit} ₽`,
      `ПРОСЬБА РУКОВОДИТЕЛЯ: ${instruction}`,
    ].join("\n\n"),
    cacheKey: `profile-edit\u0000${JSON.stringify([goals, leader.stylePrompt, leader.budgetAutoLimit, instruction])}`,
    temperature: 0,
  });

  const patch: ProfilePatch = {};
  const out: Extract<ProfileEditResult, { ok: true }> = { ok: true, patch };
  const newGoals = res.goals;
  if (newGoals && JSON.stringify(newGoals) !== JSON.stringify(goals)) {
    patch.goals = newGoals;
    out.goals = { added: newGoals.filter((g) => !goals.includes(g)), removed: goals.filter((g) => !newGoals.includes(g)) };
  }
  if (res.stylePrompt && res.stylePrompt.trim() !== leader.stylePrompt.trim()) {
    patch.stylePrompt = res.stylePrompt;
    out.style = res.stylePrompt;
  }
  if (res.budgetAutoLimit !== null && Math.round(res.budgetAutoLimit) !== leader.budgetAutoLimit) {
    patch.budgetAutoLimit = Math.round(res.budgetAutoLimit);
    out.budget = { from: leader.budgetAutoLimit, to: patch.budgetAutoLimit };
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, message: "Не нашла, что поменять: цели, манеру писем или порог по деньгам. Скажите, например: «добавь цель квартала…»." };
  }
  return out;
}
