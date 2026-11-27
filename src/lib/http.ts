import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser, type CurrentUser } from "@/core/auth/current-user";
import { db } from "@/db/client";

export const jsonError = (status: number, error: string, extra?: Record<string, unknown>) =>
  NextResponse.json({ error, ...extra }, { status });

/** Разбор тела запроса через zod. Невалидное тело → 400. */
export async function parseBody<S extends z.ZodType>(
  req: Request,
  schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; res: NextResponse }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, res: jsonError(400, "Тело запроса — невалидный JSON") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => i.message).join("; ");
    return { ok: false, res: jsonError(400, detail ? `Невалидные данные: ${detail}` : "Невалидные данные", { issues: parsed.error.issues }) };
  }
  return { ok: true, data: parsed.data };
}

/** Любой вошедший пользователь. Без входа — 401. */
export async function requireUser(): Promise<{ ok: true; user: CurrentUser } | { ok: false; res: NextResponse }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, res: jsonError(401, "Не выполнен вход") };
  return { ok: true, user };
}

/**
 * Руководитель запроса по сессии. `?leaderId=` или заголовок `x-leader-id` — только подсказка, не доверие.
 * Без входа — 401. LEADER работает только со своим руководителем: без leaderId берётся свой, чужой — 403,
 * без привязки — 403 (fail closed). ADMIN указывает любого существующего руководителя явно.
 */
export async function requireLeaderId(
  req: Request,
): Promise<{ ok: true; leaderId: string; user: CurrentUser } | { ok: false; res: NextResponse }> {
  const auth = await requireUser();
  if (!auth.ok) return auth;
  const { user } = auth;
  const asked = new URL(req.url).searchParams.get("leaderId") ?? req.headers.get("x-leader-id");

  let id: string;
  if (user.role === "ADMIN") {
    if (!asked) return { ok: false, res: jsonError(400, "Нужен leaderId") };
    id = asked;
  } else {
    if (!user.leaderId) return { ok: false, res: jsonError(403, "Учётная запись не привязана к руководителю") };
    if (asked && asked !== user.leaderId) return { ok: false, res: jsonError(403, "Нет доступа к этому руководителю") };
    id = user.leaderId;
  }
  const exists = await db.leader.findUnique({ where: { id }, select: { id: true } });
  if (!exists) return { ok: false, res: jsonError(404, "Руководитель не найден") };
  return { ok: true, leaderId: id, user };
}
