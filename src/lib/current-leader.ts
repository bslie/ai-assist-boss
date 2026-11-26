import { db } from "@/db/client";

/**
 * Руководитель для страниц стенда. В P0 нет авторизации: берём `DEFAULT_LEADER_SLUG`,
 * иначе самого раннего созданного. Все запросы дальше идут строго по его id.
 */
export async function getCurrentLeader() {
  const slug = process.env.DEFAULT_LEADER_SLUG;
  const leader = slug
    ? await db.leader.findUnique({ where: { slug } })
    : await db.leader.findFirst({ orderBy: { createdAt: "asc" } });
  return leader;
}
