import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const SESSION_COOKIE = "assist_session";
export const SESSION_TTL_SEC = 12 * 60 * 60;

const PayloadSchema = z.object({
  uid: z.string().min(1),
  role: z.enum(["ADMIN", "LEADER"]),
  exp: z.number().int(),
});
export type SessionPayload = z.infer<typeof PayloadSchema>;

/**
 * Секрет подписи сессий. Без него (или короче 32 символов) вход не работает: fail closed.
 * Сроки сессии считаются по реальному времени, а не по `clock.now()`: демо-часы перематываются,
 * а истечение cookie не должно зависеть от перемотки.
 */
function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) throw new Error("AUTH_SECRET не задан или короче 32 символов (openssl rand -hex 32)");
  return s;
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

function sign(body: string): string {
  return createHmac("sha256", secret()).update(body).digest("base64url");
}

export function createSessionToken(uid: string, role: "ADMIN" | "LEADER", nowMs: number = Date.now()): string {
  const payload: SessionPayload = { uid, role, exp: Math.floor(nowMs / 1000) + SESSION_TTL_SEC };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

/** Разбор и проверка подписи/срока. Любая ошибка → null. */
export function readSessionToken(token: string | undefined, nowMs: number = Date.now()): SessionPayload | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  let expected: Buffer;
  try {
    expected = Buffer.from(sign(body));
  } catch {
    return null; // AUTH_SECRET не задан
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = PayloadSchema.safeParse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
    if (!parsed.success) return null;
    if (parsed.data.exp * 1000 <= nowMs) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export const sessionCookieOptions = (maxAge: number) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge,
});
