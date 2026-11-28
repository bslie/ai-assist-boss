import { NextResponse } from "next/server";
import { z } from "zod";
import { hashPassword } from "@/core/auth/password";
import { db } from "@/db/client";
import { createEmptyLeader, leaderOwnerLogin, leaderTakenMessage } from "@/core/auth/leader-account";
import { jsonError, parseBody } from "@/lib/http";
import { requireAdmin } from "@/lib/require-admin";

const CreateBody = z
  .object({
    login: z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9._-]+$/, "Только латиница, цифры, точка, дефис, подчёркивание"),
    displayName: z.string().trim().min(1).max(120),
    role: z.enum(["ADMIN", "LEADER"]),
    leaderId: z.string().min(1).nullable().optional(),
    /** Завести нового пустого руководителя под эту запись: чистый кабинет без чужих подключений. */
    newLeader: z.boolean().optional(),
    password: z.string().min(8).max(200).optional(),
    telegramId: z.string().regex(/^\d{1,20}$/, "Telegram ID — только цифры").optional(),
  })
  .refine((b) => b.password || b.telegramId, { message: "Нужен пароль или Telegram ID" })
  .refine((b) => b.role !== "LEADER" || Boolean(b.leaderId) || b.newLeader, { message: "Руководителю нужна привязка к руководителю" })
  .refine((b) => !(b.leaderId && b.newLeader), { message: "Выберите существующего руководителя или нового, но не оба" });

type UserRow = {
  id: string;
  login: string;
  displayName: string;
  role: string;
  leaderId: string | null;
  telegramId: string | null;
  passwordHash: string | null;
  createdAt: Date;
  leader: { name: string } | null;
};

// Хэш пароля наружу не отдаём: только факт наличия.
const publicUser = (u: UserRow) => ({
  id: u.id,
  login: u.login,
  displayName: u.displayName,
  role: u.role,
  leaderId: u.leaderId,
  leaderName: u.leader?.name ?? null,
  telegramId: u.telegramId,
  hasPassword: Boolean(u.passwordHash),
  createdAt: u.createdAt.toISOString(),
});

/** `GET /api/control/users` — учётные записи для входа (только ADMIN). */
export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.res;
  const users = await db.appUser.findMany({ orderBy: { createdAt: "asc" }, include: { leader: { select: { name: true } } } });
  return NextResponse.json({ users: users.map(publicUser) });
}

/** `POST /api/control/users` — создать учётную запись (только ADMIN). */
export async function POST(req: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.res;
  const body = await parseBody(req, CreateBody);
  if (!body.ok) return body.res;
  const d = body.data;

  if (d.leaderId) {
    const leader = await db.leader.findUnique({ where: { id: d.leaderId }, select: { id: true } });
    if (!leader) return jsonError(404, "Руководитель не найден");
    // Один кабинет — одна учётная запись руководителя: иначе второй пользователь увидит чужие интеграции и письма.
    if (d.role === "LEADER") {
      const owner = await leaderOwnerLogin(db, d.leaderId);
      if (owner) return jsonError(409, leaderTakenMessage(owner));
    }
  }
  const clash = await db.appUser.findFirst({
    where: { OR: [{ login: d.login }, ...(d.telegramId ? [{ telegramId: d.telegramId }] : [])] },
    select: { id: true },
  });
  if (clash) return jsonError(409, "Такой логин или Telegram ID уже заведён");

  let leaderId = d.leaderId ?? null;
  if (d.newLeader) leaderId = (await createEmptyLeader(db, { displayName: d.displayName, login: d.login })).id;

  const user = await db.appUser.create({
    data: {
      login: d.login,
      displayName: d.displayName,
      role: d.role,
      leaderId,
      telegramId: d.telegramId ?? null,
      passwordHash: d.password ? await hashPassword(d.password) : null,
    },
    include: { leader: { select: { name: true } } },
  });
  return NextResponse.json({ user: publicUser(user) }, { status: 201 });
}
