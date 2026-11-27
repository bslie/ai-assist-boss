/**
 * Проверка доступов при подключении: пользователь сразу видит, что ключ не подошёл, а не узнаёт об этом на встрече.
 * Здесь только модули, у которых нет своей проверки (почта проверяется в mail/factory).
 */
import { z } from "zod";

export const RECALL_REGIONS = ["us-east-1", "us-west-2", "eu-central-1", "ap-northeast-1"] as const;

const RecallValues = z.object({
  apiKey: z.string().min(1),
  region: z.enum(RECALL_REGIONS, { message: `Регион: ${RECALL_REGIONS.join(", ")}` }),
  appUrl: z
    .string()
    .url({ message: "Адрес приложения: полная ссылка вида https://…" })
    .refine((s) => !URL.canParse(s) || ["https:", "http:"].includes(new URL(s).protocol), "Адрес приложения должен начинаться с https://"),
  pricePerHourRub: z
    .string()
    .optional()
    .refine((s) => !s || (Number.isFinite(Number(s.replace(",", "."))) && Number(s.replace(",", ".")) >= 0), "Цена часа — число, например 35"),
});

/** Бросает Error с понятным текстом, если доступы не подходят. */
export async function verifyConnectorCredentials(moduleId: string, values: Record<string, string>): Promise<void> {
  if (moduleId !== "BUILTIN_RECALL") return;
  const parsed = RecallValues.safeParse(values);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Проверьте поля");
  const v = parsed.data;
  let res: Response;
  try {
    res = await fetch(`https://${v.region}.recall.ai/api/v1/bot/?page_size=1`, { headers: { Authorization: `Token ${v.apiKey}` }, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new Error("Не удалось связаться с Recall.ai. Проверьте регион и подключение к интернету.");
  }
  if (res.status === 401 || res.status === 403) throw new Error(`Recall не принял ключ в регионе ${v.region}. Проверьте ключ и регион: ключ работает только в своём регионе.`);
  if (!res.ok) throw new Error(`Recall ответил ошибкой ${res.status}. Попробуйте позже.`);
}

/** Цена часа из поля формы: пусто или не число → 0. */
export function parsePricePerHour(v: string | undefined): number {
  const n = Number((v ?? "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
