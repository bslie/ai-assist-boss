import { NextResponse } from "next/server";
import { z } from "zod";
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
  if (!parsed.success) return { ok: false, res: jsonError(400, "Невалидные данные", { issues: parsed.error.issues }) };
  return { ok: true, data: parsed.data };
}

/**
 * Руководитель запроса: `?leaderId=` или заголовок `x-leader-id`.
 * Авторизации в P0 нет (демо-стенд): без явного leaderId — 400, а не «первый попавшийся».
 */
export async function requireLeaderId(req: Request): Promise<{ ok: true; leaderId: string } | { ok: false; res: NextResponse }> {
  const id = new URL(req.url).searchParams.get("leaderId") ?? req.headers.get("x-leader-id");
  if (!id) return { ok: false, res: jsonError(400, "Нужен leaderId") };
  const exists = await db.leader.findUnique({ where: { id }, select: { id: true } });
  if (!exists) return { ok: false, res: jsonError(404, "Руководитель не найден") };
  return { ok: true, leaderId: id };
}
