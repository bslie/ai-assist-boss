import { NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_TTL_SEC, createSessionToken, sessionCookieOptions } from "@/core/auth/session";
import { TelegramLoginSchema, verifyTelegramLogin } from "@/core/auth/telegram-login";
import { db } from "@/db/client";
import { jsonError, parseBody } from "@/lib/http";

/**
 * `POST /api/auth/telegram` — данные от Telegram Login Widget.
 * Вход только если подпись верна, auth_date свежий и Telegram-аккаунт привязан к AppUser (иначе 403).
 */
export async function POST(req: Request) {
  const body = await parseBody(req, TelegramLoginSchema);
  if (!body.ok) return body.res;

  const verdict = verifyTelegramLogin(body.data, process.env.TELEGRAM_BOT_TOKEN);
  if (!verdict.ok) {
    if (verdict.reason === "no_token") return jsonError(503, "Вход через Telegram не настроен: нет TELEGRAM_BOT_TOKEN");
    if (verdict.reason === "expired") return jsonError(401, "Сессия Telegram устарела, попробуйте ещё раз");
    return jsonError(401, "Подпись Telegram не сошлась");
  }

  const user = await db.appUser.findUnique({ where: { telegramId: verdict.telegramId } });
  if (!user) return jsonError(403, "Этот Telegram-аккаунт не привязан к доступу в приложение");

  const res = NextResponse.json({ ok: true, role: user.role });
  res.cookies.set(SESSION_COOKIE, createSessionToken(user.id, user.role), sessionCookieOptions(SESSION_TTL_SEC));
  return res;
}
