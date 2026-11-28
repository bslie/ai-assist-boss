/**
 * Удаление руководителя целиком (панель управления). Всё, что принадлежит ему, уходит каскадом: сотрудники, письма, карточки,
 * поручения, встречи, подключения, привязки Telegram. Учётные записи-руководители этого кабинета удаляются тоже:
 * без кабинета они бесполезны, а привязка к чужому недопустима. Записи администраторов остаются (привязка сбрасывается).
 */
import type { PrismaClient } from "@/generated/prisma/client";

export async function deleteLeader(db: PrismaClient, leaderId: string): Promise<{ accountsDeleted: number }> {
  return db.$transaction(async (tx) => {
    const accounts = await tx.appUser.deleteMany({ where: { leaderId, role: "LEADER" } });
    await tx.leader.delete({ where: { id: leaderId } });
    return { accountsDeleted: accounts.count };
  });
}
