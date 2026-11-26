import { NextResponse } from "next/server";
import { getCurrentUser, type CurrentUser } from "@/core/auth/current-user";

/** Доступ к панели управления: только ADMIN. Без входа — 401, с другой ролью — 403. */
export async function requireAdmin(): Promise<{ ok: true; user: CurrentUser } | { ok: false; res: NextResponse }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, res: NextResponse.json({ error: "Не выполнен вход" }, { status: 401 }) };
  if (user.role !== "ADMIN") return { ok: false, res: NextResponse.json({ error: "Нужна роль администратора" }, { status: 403 }) };
  return { ok: true, user };
}
