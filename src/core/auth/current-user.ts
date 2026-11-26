import { cookies } from "next/headers";
import { connection } from "next/server";
import { db } from "@/db/client";
import { SESSION_COOKIE, readSessionToken } from "./session";

export type CurrentUser = {
  id: string;
  login: string;
  displayName: string;
  role: "ADMIN" | "LEADER";
  leaderId: string | null;
};

/**
 * Текущий пользователь по cookie. Роль и привязка читаются из БД заново,
 * поэтому отключение учётной записи действует сразу, без ожидания истечения cookie.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  await connection(); // запрос динамический: без этого Date.now() в проверке срока ломает prerender
  const jar = await cookies();
  const session = readSessionToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) return null;
  const user = await db.appUser.findUnique({ where: { id: session.uid } });
  if (!user) return null;
  return { id: user.id, login: user.login, displayName: user.displayName, role: user.role, leaderId: user.leaderId };
}
