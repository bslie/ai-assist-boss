/**
 * Предложение правила после правки (SPEC 4.4.1): фоново, после EDITED_APPROVED.
 * «Заметил правку: <правило>. Запомнить?» [Да, запомнить] [Только этот раз].
 * Предложение хранится как Memory с isActive=false; «Да» включает, «Только этот раз» удаляет.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { clock } from "../clock";
import { publishEvent } from "../events";
import type { LlmClient } from "../llm";
import { esc, type Messenger } from "../telegram/types";
import { extractRuleFromEdit } from "./extract";

export interface LearnDeps {
  db: PrismaClient;
  messenger: Messenger;
  llm: LlmClient;
}

export type ProposeResult =
  | { status: "proposed"; memoryId: string; chats: number }
  | { status: "no_chat"; memoryId: string }
  | { status: "none" }
  | { status: "duplicate" }
  | { status: "skipped"; reason: string };

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Короткий фрагмент для сравнения «было → стало». */
export const excerpt = (s: string, max = 90): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max).trimEnd()}…` : one;
};

/** Сообщение руководителю (его LEADER-чатам); ошибки доставки не ломают разбор правки. */
async function tell(deps: LearnDeps, leaderId: string, text: string) {
  const rows = await deps.db.telegramBinding.findMany({ where: { leaderId, role: "LEADER" }, select: { chatId: true } });
  for (const chatId of new Set(rows.map((r) => r.chatId))) await deps.messenger.send(chatId, text).catch(() => {});
}

export async function proposeLearning(deps: LearnDeps, leaderId: string, decisionId: string): Promise<ProposeResult> {
  const { db, messenger, llm } = deps;
  const d = await db.decision.findFirst({ where: { id: decisionId, leaderId } });
  if (!d || d.status !== "EDITED_APPROVED") return { status: "skipped", reason: "карточка не с правкой" };
  if (!d.draftText || !d.editedText) return { status: "skipped", reason: "нет черновика для сравнения" };

  // Идемпотентность: одно событие обрабатывается один раз (событие может прийти повторно).
  const seen = await db.activityLog.findFirst({
    where: { leaderId, action: { startsWith: "LEARNING_" }, metadata: { path: ["decisionId"], equals: decisionId } },
    select: { id: true },
  });
  if (seen) return { status: "skipped", reason: "уже обработано" };

  const log = (action: string, reason: string, extra: Record<string, unknown> = {}) =>
    db.activityLog.create({
      data: { leaderId, createdAt: clock.now(), pipeline: "EMAIL", action, reason, metadata: { decisionId, ...extra } as object },
    });

  const src = await db.emailItem.findFirst({ where: { leaderId, decisionId, occurrence: 1 }, select: { subject: true } });
  const found = await extractRuleFromEdit(llm, d.draftText, d.editedText, {
    leaderId,
    decisionId,
    subject: src?.subject ?? d.title,
    summary: d.contextSummary,
  });
  if (!found) {
    await log("LEARNING_NONE", "Устойчивого различия в правке не найдено");
    // Молчание после «скажу, если заметила правило» выглядит как поломка: сообщаем и о пустом результате.
    await tell(deps, leaderId, "В этой правке постоянного правила не вижу: считаю её разовой.");
    return { status: "none" };
  }

  const existing = await db.memory.findMany({ where: { leaderId }, select: { ruleText: true } });
  if (existing.some((m) => norm(m.ruleText) === norm(found.rule))) {
    await log("LEARNING_DUPLICATE", `Такое правило уже есть: ${found.rule}`);
    await tell(deps, leaderId, `Такое правило у меня уже записано: «${esc(found.rule)}»`);
    return { status: "duplicate" };
  }

  const memory = await db.memory.create({
    data: { leaderId, sourceType: "EDIT_LEARNING", ruleText: found.rule, scope: found.scope, isActive: false },
  });

  const bindings = await db.telegramBinding.findMany({ where: { leaderId, role: "LEADER" }, select: { chatId: true } });
  const chats = [...new Set(bindings.map((b) => b.chatId))];
  await log("LEARNING_PROPOSED", `Предложено правило: ${found.rule}`, { memoryId: memory.id, confidence: found.confidence });
  if (chats.length === 0) return { status: "no_chat", memoryId: memory.id };

  const text = [
    `Заметила в вашей правке: <b>${esc(found.rule)}</b>`,
    "",
    `Было: «${esc(excerpt(d.draftText))}»`,
    `Стало: «${esc(excerpt(d.editedText))}»`,
    "",
    "Запомнить на будущее?",
  ].join("\n");
  for (const chatId of chats) {
    await messenger.send(chatId, text, [
      [
        { text: "Да, запомнить", data: `m:y:${memory.id}` },
        { text: "Только этот раз", data: `m:n:${memory.id}` },
      ],
    ]);
  }
  return { status: "proposed", memoryId: memory.id, chats: chats.length };
}

/** «Да, запомнить»: правило становится активным и попадает в следующие черновики. Только своё и только предложенное. */
export async function acceptMemory(db: PrismaClient, leaderId: string, memoryId: string): Promise<"ok" | "already" | "missing"> {
  const m = await db.memory.findFirst({ where: { id: memoryId, leaderId } });
  if (!m) return "missing";
  if (m.isActive) return "already";
  const upd = await db.memory.updateMany({ where: { id: memoryId, leaderId, isActive: false }, data: { isActive: true } });
  if (upd.count === 0) return "already";
  await db.activityLog.create({
    data: { leaderId, createdAt: clock.now(), pipeline: "EMAIL", action: "LEARNING_ACCEPTED", reason: `Запомнила правило: ${m.ruleText}`, metadata: { memoryId } },
  });
  await publishEvent(leaderId, { type: "metrics.updated", data: {} });
  return "ok";
}

/** «Только этот раз»: предложение удаляется. Уже принятое правило так не удалить. */
export async function rejectMemory(db: PrismaClient, leaderId: string, memoryId: string): Promise<"ok" | "already" | "missing"> {
  const m = await db.memory.findFirst({ where: { id: memoryId, leaderId } });
  if (!m) return "missing";
  if (m.isActive) return "already";
  await db.memory.deleteMany({ where: { id: memoryId, leaderId, isActive: false } });
  return "ok";
}
