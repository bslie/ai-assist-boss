/**
 * Отправка утверждённого ответа (SPEC 4.1): единственный путь письма наружу.
 * Руководитель утвердил текст в карточке — это и есть подтверждение; Policy Gate всё равно проверяет
 * права подключения: запрет (DENY) отправку останавливает.
 */
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { clock } from "../clock";
import { ensureSignature } from "../learning/draft";
import { evaluate, getConnectorToolPermission, loadGateLeader, logVerdict } from "../policy-gate";
import { createMailConnector, isMailType } from "./factory";
import type { MailConnector } from "./types";

const PayloadSchema = z.object({
  tool: z.literal("mail.reply"),
  args: z.object({
    to: z.string().min(3),
    subject: z.string(),
    connectorId: z.string().nullish(),
    externalId: z.string().nullish(),
    inReplyTo: z.string().nullish(),
  }),
});

export type ExecResult = { executed: boolean; reason: string; /** false — отправка не предполагалась, в журнал не пишем. */ applicable: boolean };

export async function executeApprovedReply(
  db: PrismaClient,
  leaderId: string,
  decisionId: string,
  deps: { connector?: MailConnector } = {},
): Promise<ExecResult> {
  const skip = (reason: string): ExecResult => ({ executed: false, reason, applicable: false });
  const d = await db.decision.findFirst({ where: { id: decisionId, leaderId } });
  if (!d || (d.status !== "APPROVED" && d.status !== "EDITED_APPROVED")) return skip("Решение не утверждено");
  const payload = PayloadSchema.safeParse(d.proposedPayload);
  if (!payload.success) return skip("Решение не про отправку письма");
  const { args } = payload.data;
  if (!args.connectorId) return skip("Письмо пришло не из подключённой почты");

  const fail = async (reason: string): Promise<ExecResult> => {
    await db.activityLog.create({
      data: { createdAt: clock.now(), leaderId, pipeline: "EMAIL", action: "MAIL_SEND_FAILED", reason, metadata: { decisionId } },
    });
    return { executed: false, reason, applicable: true };
  };

  const text = (d.editedText ?? d.draftText ?? "").trim();
  if (!text) return fail("У карточки нет текста ответа: отправлять нечего");
  const row = await db.connector.findFirst({ where: { id: args.connectorId, leaderId } });
  if (!row || !isMailType(row.type)) return fail("Подключение к почте удалено: ответ нужно отправить вручную");
  if (!row.isActive) return fail("Подключение к почте выключено: ответ не отправлен");

  const perm = await getConnectorToolPermission(db, leaderId, row.id, "mail.send_reply");
  const verdict = evaluate("mail.send_reply", { leader: await loadGateLeader(db, leaderId), toolPermission: perm, isOutbound: true });
  await logVerdict(db, leaderId, "mail.send_reply", verdict, { metadata: { decisionId, approvedByLeader: true } });
  if (verdict.verdict === "DENY") return fail("Отправка ответов запрещена в правах подключения");

  const leader = await db.leader.findFirstOrThrow({ where: { id: leaderId }, select: { name: true } });
  const mail = deps.connector ?? createMailConnector(db, row);
  if (!mail) return fail("Нет доступа к почте: войдите заново в разделе «Подключения»");
  try {
    await mail.send({ to: args.to, subject: args.subject, text: ensureSignature(text, leader.name), externalId: args.externalId, inReplyTo: args.inReplyTo });
  } catch (e) {
    return fail(`Письмо не отправилось: ${(e as Error).message}`);
  }
  await db.activityLog.create({
    data: { createdAt: clock.now(), leaderId, pipeline: "EMAIL", action: "MAIL_SENT", reason: `Ответ отправлен: ${args.subject}`, metadata: { decisionId, to: args.to, executed: true } },
  });
  return { executed: true, reason: "Отправлено", applicable: true };
}
