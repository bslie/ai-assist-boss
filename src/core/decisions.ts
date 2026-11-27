/**
 * Разрешение карточки решения руководителем (POST /api/decisions/[id]/resolve).
 *
 * Здесь фиксируется только РЕШЕНИЕ руководителя. Исполнение `proposedPayload` (отправка письма,
 * создание встречи) во внешних системах пойдёт отдельным шагом через Policy Gate, когда появятся
 * коннекторы: сегодня внешнего эффекта нет, поэтому метка `executed: false` в ActivityLog.
 */
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { readyClock } from "./clock";
import { findPlaceholders } from "./draft-placeholders";
import { publishEvent } from "./events";
import { markHandledEmails } from "./mail/mark-read";
import { executeApprovedReply } from "./mail/send";
import { executeApprovedProtocol } from "./meetings/approve";

/** Кому уходит утверждённый протокол: всем участникам встречи или только исполнителям из протокола. */
export const ProtocolRecipientsSchema = z.enum(["ALL", "IN_PROTOCOL"]);
export type ProtocolRecipients = z.infer<typeof ProtocolRecipientsSchema>;

export const ResolveSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("APPROVE"), protocolRecipients: ProtocolRecipientsSchema.optional() }),
  z.object({ action: z.literal("EDITED_APPROVED"), editedText: z.string().min(1), protocolRecipients: ProtocolRecipientsSchema.optional() }),
  z.object({ action: z.literal("DELEGATE"), delegateToId: z.string().min(1) }),
  z.object({ action: z.literal("REJECTED") }),
  z.object({ action: z.literal("SNOOZE") }),
]);
export type ResolveInput = z.infer<typeof ResolveSchema>;

const STATUS = {
  APPROVE: "APPROVED",
  EDITED_APPROVED: "EDITED_APPROVED",
  DELEGATE: "DELEGATED",
  REJECTED: "REJECTED",
  SNOOZE: "SNOOZED",
} as const;

export type ResolveResult =
  | { ok: true; status: string }
  | { ok: false; code: "NOT_FOUND" | "ALREADY_RESOLVED" | "BAD_DELEGATE" | "DRAFT_INCOMPLETE"; message: string };

export async function resolveDecision(
  db: PrismaClient,
  leaderId: string,
  decisionId: string,
  input: ResolveInput,
  savedMinutesForApproval = 6, // «Черновик ответа, утверждённый без правок» (SPEC 7.3)
): Promise<ResolveResult> {
  const clk = await readyClock();
  const decision = await db.decision.findFirst({ where: { id: decisionId, leaderId } });
  if (!decision) return { ok: false, code: "NOT_FOUND", message: "Карточка не найдена" };
  if (decision.status !== "PENDING") {
    return { ok: false, code: "ALREADY_RESOLVED", message: `Карточка уже обработана: ${decision.status}` };
  }

  if (input.action === "DELEGATE") {
    const assignee = await db.employee.findFirst({ where: { id: input.delegateToId, leaderId } });
    if (!assignee) return { ok: false, code: "BAD_DELEGATE", message: "Исполнитель не найден у этого руководителя" };
  }

  // Письмо с незаполненным пропуском («[срок]») наружу не уходит: сначала руководитель впишет значение.
  if ((input.action === "APPROVE" || input.action === "EDITED_APPROVED") && decision.type !== "MEETING_PROTOCOL") {
    const gaps = findPlaceholders(input.action === "EDITED_APPROVED" ? input.editedText : decision.draftText);
    if (gaps.length) {
      return { ok: false, code: "DRAFT_INCOMPLETE", message: `В тексте остался пропуск ${gaps.join(", ")}. Нажмите «Поправить», впишите значение и отправьте.` };
    }
  }

  const status = STATUS[input.action];
  // Условный апдейт: двойной клик/гонка не разрешит карточку дважды.
  const upd = await db.decision.updateMany({
    where: { id: decisionId, leaderId, status: "PENDING" },
    data: {
      status,
      resolvedAt: clk.now(),
      ...(input.action === "EDITED_APPROVED" ? { editedText: input.editedText } : {}),
    },
  });
  if (upd.count === 0) return { ok: false, code: "ALREADY_RESOLVED", message: "Карточка уже обработана" };

  // Протокол сам начисляет 30 минут при исполнении, поэтому здесь за него не считаем.
  const approved = input.action === "APPROVE" && decision.type !== "MEETING_PROTOCOL";
  await db.activityLog.create({
    data: {
      createdAt: clk.now(),
      leaderId,
      pipeline: "EMAIL",
      action: `DECISION_${input.action}`,
      reason: `Руководитель: ${input.action}. ${decision.title}`,
      savedMinutes: approved ? savedMinutesForApproval : 0,
      metadata: {
        decisionId,
        executed: false,
        ...(input.action === "DELEGATE" ? { delegateToId: input.delegateToId } : {}),
      },
    },
  });

  // Утверждённый ответ уходит в почту через Policy Gate. Сбой отправки не отменяет решение: он виден в журнале.
  if (input.action === "APPROVE" || input.action === "EDITED_APPROVED") {
    await executeApprovedReply(db, leaderId, decisionId).catch(() => null);
    if (decision.type === "MEETING_PROTOCOL") {
      await executeApprovedProtocol(db, leaderId, decisionId, { recipients: input.protocolRecipients ?? "ALL" }).catch(() => null);
    }
  }

  // Письмо, по которому руководитель принял решение, в ящике становится прочитанным. «Не сейчас» его не трогает.
  if (input.action !== "SNOOZE") await markHandledEmails(db, leaderId).catch(() => null);

  await publishEvent(leaderId, { type: "decision.updated", data: { id: decisionId, status } });
  await publishEvent(leaderId, { type: "metrics.updated", data: {} });
  return { ok: true, status };
}
