/**
 * Проверка доступов при подключении: пользователь сразу видит, что ключ не подошёл, а не узнаёт об этом на встрече.
 * Здесь только модули, у которых нет своей проверки (почта проверяется в mail/factory).
 */
import { z } from "zod";
import { validateReplyDelay } from "../telegram/reply-delay";

export const RECALL_REGIONS = ["us-east-1", "us-west-2", "eu-central-1", "ap-northeast-1"] as const;

const RecallValues = z.object({
  apiKey: z.string().min(1),
  region: z.enum(RECALL_REGIONS, { message: `Регион: ${RECALL_REGIONS.join(", ")}` }),
  /** Берётся из запроса, пользователь его не вводит; проверка — защита от мусора в записи. */
  appUrl: z
    .string()
    .url({ message: "Не удалось определить адрес приложения" })
    .refine((s) => !URL.canParse(s) || ["https:", "http:"].includes(new URL(s).protocol), "Не удалось определить адрес приложения")
    .optional(),
});

/** Бросает Error с понятным текстом, если доступы не подходят. */
export async function verifyConnectorCredentials(moduleId: string, values: Record<string, string>): Promise<void> {
  if (moduleId === "BUILTIN_TELEGRAM_BUSINESS") {
    if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error("На сервере не задан TELEGRAM_BOT_TOKEN: без него бот не запустится.");
    const bad = validateReplyDelay(values.replyDelayMinutes);
    if (bad) throw new Error(bad);
    return;
  }
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

