import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyPassword } from "@/core/auth/password";
import { SESSION_COOKIE, SESSION_TTL_SEC, createSessionToken, sessionCookieOptions } from "@/core/auth/session";
import { db } from "@/db/client";
import { jsonError, parseBody } from "@/lib/http";

const Body = z.object({
  login: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(200),
});

/** `POST /api/auth/login` с `{ login, password }` → cookie сессии. Ошибка — одна и та же, чтобы не раскрывать логины. */
export async function POST(req: Request) {
  const body = await parseBody(req, Body);
  if (!body.ok) return body.res;

  const user = await db.appUser.findUnique({ where: { login: body.data.login } });
  const valid = await verifyPassword(body.data.password, user?.passwordHash ?? null);
  if (!user || !valid) return jsonError(401, "Неверный логин или пароль");

  const res = NextResponse.json({ ok: true, role: user.role });
  res.cookies.set(SESSION_COOKIE, createSessionToken(user.id, user.role), sessionCookieOptions(SESSION_TTL_SEC));
  return res;
}
