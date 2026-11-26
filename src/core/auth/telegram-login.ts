import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Telegram Login Widget: https://core.telegram.org/widgets/login#checking-authorization
 * Подпись: HMAC-SHA256 над строкой `key=value` (отсортировано, через \n) с ключом SHA256(bot token).
 */
export const TelegramLoginSchema = z.object({
  id: z.coerce.number().int().positive(),
  first_name: z.string().max(200).optional(),
  last_name: z.string().max(200).optional(),
  username: z.string().max(200).optional(),
  photo_url: z.string().max(2000).optional(),
  auth_date: z.coerce.number().int().positive(),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type TelegramLoginPayload = z.infer<typeof TelegramLoginSchema>;

export const TELEGRAM_AUTH_MAX_AGE_SEC = 24 * 60 * 60;

export type TelegramVerdict =
  | { ok: true; telegramId: string }
  | { ok: false; reason: "bad_signature" | "expired" | "no_token" };

/** Проверка подписи и свежести `auth_date`. Реальное время — это защита от повтора старой подписи. */
export function verifyTelegramLogin(
  payload: TelegramLoginPayload,
  botToken: string | undefined,
  nowMs: number = Date.now(),
): TelegramVerdict {
  if (!botToken) return { ok: false, reason: "no_token" };

  const fields = Object.entries({
    id: String(payload.id),
    first_name: payload.first_name,
    last_name: payload.last_name,
    username: payload.username,
    photo_url: payload.photo_url,
    auth_date: String(payload.auth_date),
  })
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dataCheckString = fields.map(([k, v]) => `${k}=${v}`).join("\n");

  const key = createHash("sha256").update(botToken).digest();
  const computed = createHmac("sha256", key).update(dataCheckString).digest();
  const given = Buffer.from(payload.hash, "hex");
  if (given.length !== computed.length || !timingSafeEqual(given, computed)) {
    return { ok: false, reason: "bad_signature" };
  }
  if (nowMs / 1000 - payload.auth_date > TELEGRAM_AUTH_MAX_AGE_SEC) return { ok: false, reason: "expired" };
  return { ok: true, telegramId: String(payload.id) };
}
