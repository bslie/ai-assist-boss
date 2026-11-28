/**
 * У каждого пользователя-руководителя свой кабинет: почта, календарь, Telegram, Recall, письма и карточки принадлежат
 * руководителю (`leaderId`), поэтому две учётные записи на одного руководителя видели бы чужие интеграции.
 * Эти функции не дают такого завести и создают чистого руководителя под новую запись.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { slugify } from "@/db/seed-leader";

/** Логин учётной записи-руководителя, которой уже принадлежит этот кабинет, или null, если кабинет свободен. */
export async function leaderOwnerLogin(db: PrismaClient, leaderId: string): Promise<string | null> {
  const owner = await db.appUser.findFirst({ where: { leaderId, role: "LEADER" }, select: { login: true } });
  return owner?.login ?? null;
}

export const leaderTakenMessage = (login: string) =>
  `Этот руководитель уже закреплён за учётной записью «${login}»: у каждого пользователя свой кабинет, иначе он увидит чужие подключения и письма. Создайте нового руководителя.`;

/** Пустой руководитель, как в мастере (/api/leaders): профиль, правила и подключения у него свои и пустые. */
export async function createEmptyLeader(db: PrismaClient, input: { displayName: string; login: string }): Promise<{ id: string }> {
  const base = slugify(input.displayName) || slugify(input.login) || "leader";
  const slug = (await db.leader.findUnique({ where: { slug: base }, select: { id: true } })) ? `${base}-${Date.now().toString(36)}` : base;
  return db.leader.create({
    data: { slug, name: input.displayName, role: "Руководитель", email: `${slug}@leader.local`, quarterGoals: [], stylePrompt: "", savedMinutesConfig: {}, profileMarkdown: "" },
    select: { id: true },
  });
}
