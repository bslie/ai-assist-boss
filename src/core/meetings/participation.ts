/**
 * Режим участия в встрече (SPEC 7.1.3): по умолчанию ежедневные планёрки закрывает аватар, статусы — письменный статус.
 * Всё, что касается денег, клиентов, кадров, партнёров и руководства, остаётся за руководителем.
 * Правило зависит только от категории и названия, не от конкретного руководителя.
 */
import type { MeetingCategory } from "../dataset/ics";

export type ParticipationMode = "LEADER" | "AVATAR" | "ASYNC_STATUS";

export function defaultParticipation(category: MeetingCategory | string, title: string, protectedBlocks: readonly string[] = []): ParticipationMode {
  const t = title.toLowerCase();
  if (protectedBlocks.some((b) => t.includes(b.toLowerCase()))) return "LEADER";
  if (category !== "OPERATIONAL") return "LEADER";
  if (t.includes("планёрк") || t.includes("планерк")) return "AVATAR";
  if (t.startsWith("статус")) return "ASYNC_STATUS";
  return "LEADER";
}
