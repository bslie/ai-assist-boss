/**
 * Категория встречи из Google Календаря (у события нет поля «категория», как в датасете).
 * Правило по названию и участникам, без LLM. Fail closed: внешние участники → CLIENT, а всё,
 * что не OPERATIONAL, остаётся за руководителем (см. defaultParticipation).
 */
import type { MeetingCategory } from "../dataset/ics";

const domain = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";

export function categorizeEvent(title: string, attendees: readonly string[], ownEmail?: string | null): MeetingCategory {
  const t = title.toLowerCase();
  const own = ownEmail ? domain(ownEmail) : "";
  const external = own ? attendees.some((a) => domain(a) !== own) : false;

  if (/\b1\s*(?::|на)\s*1\b|один на один|one[- ]on[- ]one/.test(t)) return "ONE_ON_ONE";
  if (/бюджет|оплат|счёт|счет|платёж|платеж|инвойс|закупк/.test(t)) return "MONEY";
  if (/совет директоров|правлени|стратег|руководств/.test(t)) return "MANAGEMENT";
  if (/партн[её]р/.test(t)) return "PARTNER";
  if (external || /клиент|заказчик|демо клиент/.test(t)) return "CLIENT";
  return "OPERATIONAL";
}
