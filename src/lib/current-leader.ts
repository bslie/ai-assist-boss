import { getCurrentUser } from "@/core/auth/current-user";
import { db } from "@/db/client";

/**
 * Руководитель для страниц стенда по сессии. Без входа — null.
 * LEADER видит только своего руководителя (без привязки — null, fail closed).
 * ADMIN — `DEFAULT_LEADER_SLUG`, иначе самого раннего созданного. Все запросы дальше идут строго по его id.
 */
export async function getCurrentLeader() {
  const user = await getCurrentUser();
  if (!user) return null;
  if (user.role !== "ADMIN") {
    return user.leaderId ? db.leader.findUnique({ where: { id: user.leaderId } }) : null;
  }
  const slug = process.env.DEFAULT_LEADER_SLUG;
  return slug
    ? db.leader.findUnique({ where: { slug } })
    : db.leader.findFirst({ orderBy: { createdAt: "asc" } });
}
