/**
 * Привязки чатов (SPEC 5.1): один бот для всех ролей, чат может играть несколько ролей,
 * активная переключается /role. `/start <inviteToken>` — сотрудник, `/start <slug>:<secret>` — руководитель.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { esc, type Button } from "./types";

/** Секрет привязки руководителя = HMAC(slug) от TELEGRAM_BIND_KEY. Ключа нет → привязка запрещена (fail closed). */
export function leaderBindSecret(slug: string, key = process.env.TELEGRAM_BIND_KEY): string {
  if (!key) throw new Error("TELEGRAM_BIND_KEY is not set");
  return createHmac("sha256", key).update(slug).digest("hex").slice(0, 24);
}

function secretMatches(slug: string, given: string, key?: string): boolean {
  let expected: string;
  try {
    expected = leaderBindSecret(slug, key);
  } catch {
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface Reply {
  text: string;
  buttons?: Button[][];
}

const INVITE_LEADER_FAIL = "Не удалось привязать чат: ссылка неверна или устарела.";

async function activate(db: PrismaClient, chatId: string, bindingId: string) {
  await db.$transaction([
    db.telegramBinding.updateMany({ where: { chatId }, data: { isActive: false } }),
    db.telegramBinding.update({ where: { id: bindingId }, data: { isActive: true } }),
  ]);
}

export async function handleStart(db: PrismaClient, chatId: string, payload: string, key?: string): Promise<Reply> {
  const arg = payload.trim();
  if (!arg) {
    return { text: "Здравствуйте. Я ИИ-помощник руководителя. Чтобы начать, откройте ссылку-приглашение, которую вам прислали." };
  }

  // Руководитель: <slug>:<secret>
  if (arg.includes(":")) {
    const idx = arg.indexOf(":");
    const slug = arg.slice(0, idx);
    const secret = arg.slice(idx + 1);
    const leader = await db.leader.findUnique({ where: { slug } });
    if (!leader || !secretMatches(slug, secret, key)) return { text: INVITE_LEADER_FAIL };

    const existing = await db.telegramBinding.findFirst({ where: { chatId, leaderId: leader.id, role: "LEADER", employeeId: null } });
    const binding =
      existing ?? (await db.telegramBinding.create({ data: { chatId, leaderId: leader.id, role: "LEADER" } }));
    await activate(db, chatId, binding.id);
    return {
      text: `Здравствуйте, я ИИ-помощник ${esc(leader.name)}. Чат привязан: сюда я буду приносить решения, которые нельзя принять без вас.`,
    };
  }

  // Сотрудник: inviteToken
  const employee = await db.employee.findUnique({ where: { inviteToken: arg }, include: { leader: true } });
  if (!employee) return { text: INVITE_LEADER_FAIL };
  const existing = await db.telegramBinding.findFirst({
    where: { chatId, leaderId: employee.leaderId, role: "EMPLOYEE", employeeId: employee.id },
  });
  const binding =
    existing ??
    (await db.telegramBinding.create({
      data: { chatId, leaderId: employee.leaderId, role: "EMPLOYEE", employeeId: employee.id },
    }));
  await activate(db, chatId, binding.id);
  return {
    // Этика (SPEC инвариант 7): агент всегда представляется.
    text: `Здравствуйте, ${esc(employee.name)}. Я ИИ-помощник ${esc(employee.leader.name)}. Теперь я смогу передавать вам поручения и принимать результат.`,
  };
}

export async function listRoles(db: PrismaClient, chatId: string): Promise<Reply> {
  const bindings = await db.telegramBinding.findMany({
    where: { chatId },
    include: { leader: true, employee: true },
    orderBy: { createdAt: "asc" },
  });
  if (bindings.length === 0) return { text: "Этот чат ни к чему не привязан." };
  const label = (b: (typeof bindings)[number]) =>
    b.role === "LEADER" ? `Руководитель ${b.leader.name}` : `Сотрудник ${b.employee?.name ?? ""} (у ${b.leader.name})`;
  return {
    text: `Ваши роли в этом чате. Сейчас активна: ${esc(label(bindings.find((b) => b.isActive) ?? bindings[0]))}.`,
    buttons: bindings.map((b) => [{ text: `${b.isActive ? "● " : ""}${label(b)}`, data: `r:${b.id}` }]),
  };
}

export async function switchRole(db: PrismaClient, chatId: string, bindingId: string): Promise<Reply> {
  // Привязка должна принадлежать этому чату: чужую роль переключить нельзя.
  const binding = await db.telegramBinding.findFirst({ where: { id: bindingId, chatId }, include: { leader: true, employee: true } });
  if (!binding) return { text: "Эта роль недоступна в вашем чате." };
  await activate(db, chatId, binding.id);
  return {
    text:
      binding.role === "LEADER"
        ? `Теперь вы в роли руководителя: ${esc(binding.leader.name)}.`
        : `Теперь вы в роли сотрудника: ${esc(binding.employee?.name ?? "")}.`,
  };
}

/** Руководитель, которого чат вправе представлять (любая LEADER-привязка, не только активная). */
export async function leaderIdsForChat(db: PrismaClient, chatId: string): Promise<string[]> {
  const rows = await db.telegramBinding.findMany({ where: { chatId, role: "LEADER" }, select: { leaderId: true } });
  return rows.map((r) => r.leaderId);
}
