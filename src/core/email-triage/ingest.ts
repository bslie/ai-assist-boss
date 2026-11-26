/**
 * Пайплайн разбора почты с записью в БД (SPEC 4.2).
 * Каждый запрос фильтруется по leaderId. Внешних побочных эффектов нет:
 * создаются только внутренние записи (EmailItem, Decision, Task, ActivityLog).
 * Отправка ответов и уведомлений идёт позже через Policy Gate.
 */
import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { clock } from "../clock";
import type { LeaderEvent } from "../events";
import type { LlmClient } from "../llm";
import type { RelationType, RiskContext } from "../policy-gate";
import { triageEmail, type CategoryRule, type EmailAction, type EmailCategory } from "./classify";
import { threadKey, type RawEmail } from "./threads";

const DEFAULT_SAVED_MINUTES: Record<string, number> = {
  IGNORE: 1,
  DIGEST: 3,
  DELEGATE: 8,
  AUTO: 5,
  REPEAT_LINKED: 2,
};

export interface IncomingEmail extends RawEmail {
  senderName: string;
  senderRole?: string | null;
  recipients?: readonly string[];
  /** Эталон из датасета, только для eval. */
  expectedAction?: EmailAction;
}

export interface IngestOptions {
  /** Черновик ответа для карточки (стиль руководителя + Memory); необязателен. */
  /** Событие для SSE (decision.created, email.processed). Ошибки подписчика не ломают разбор. */
  emit?: (event: LeaderEvent) => Promise<void> | void;
  draft?: (ctx: { leaderId: string; email: IncomingEmail; summary: string }) => Promise<string | null>;
}

export interface IngestStats {
  processed: number;
  skippedExisting: number;
  threads: number;
  repeats: number;
  decisionsCreated: number;
  tasksCreated: number;
  byAction: Record<string, number>;
}

const DECISION_TYPE_BY_CATEGORY: Partial<Record<EmailCategory, string>> = {
  MONEY: "BUDGET_APPROVAL",
  CALENDAR: "CALENDAR_INVITE",
};

function parseDeadline(raw: string | null, fallback: Date): Date {
  if (!raw) return fallback;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

export async function ingestEmails(
  db: PrismaClient,
  llm: LlmClient,
  leaderId: string,
  emails: readonly IncomingEmail[],
  opts: IngestOptions = {},
): Promise<IngestStats> {
  const leader = await db.leader.findUniqueOrThrow({ where: { id: leaderId } });
  const employees = await db.employee.findMany({ where: { leaderId } });
  const rules = await db.rule.findMany({ where: { leaderId } });
  const now = clock.now();

  const risk: RiskContext = {
    leaderEmail: leader.email,
    org: employees.map((e) => ({
      email: e.email,
      position: e.position,
      relationType: e.relationType as RelationType,
    })),
  };
  const categoryRules: CategoryRule[] = [];
  for (const r of rules) {
    const cat = (r.condition as { category?: EmailCategory } | null)?.category;
    if (cat && (!r.expiresAt || r.expiresAt > now)) categoryRules.push({ category: cat, action: r.action });
  }
  const minutes = {
    ...DEFAULT_SAVED_MINUTES,
    ...((leader.savedMinutesConfig as Record<string, number> | null) ?? {}),
  };

  const stats: IngestStats = {
    processed: 0, skippedExisting: 0, threads: 0, repeats: 0,
    decisionsCreated: 0, tasksCreated: 0, byAction: {},
  };
  const bump = (a: string) => (stats.byAction[a] = (stats.byAction[a] ?? 0) + 1);

  const sorted = [...emails].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());

  for (const email of sorted) {
    if (email.externalId) {
      const exists = await db.emailItem.findUnique({
        where: { leaderId_externalId: { leaderId, externalId: email.externalId } },
        select: { id: true },
      });
      if (exists) {
        stats.skippedExisting++;
        continue;
      }
    }

    const key = threadKey(email.senderEmail, email.subject, email.body);
    const first = await db.emailItem.findFirst({
      where: { leaderId, threadKey: key, occurrence: 1 },
    });
    const occurrence = first ? (await db.emailItem.count({ where: { leaderId, threadKey: key } })) + 1 : 1;

    const base = {
      leaderId,
      externalId: email.externalId ?? null,
      threadKey: key,
      occurrence,
      senderName: email.senderName,
      senderEmail: email.senderEmail,
      senderRole: email.senderRole ?? null,
      subject: email.subject,
      body: email.body,
      receivedAt: email.receivedAt,
      expectedAction: email.expectedAction ?? null,
    };

    // Повтор: наследует результат первого письма, новых карточек не создаёт.
    if (first) {
      stats.repeats++;
      let linked = false;
      if (first.decisionId) {
        const upd = await db.decision.updateMany({
          where: { id: first.decisionId, leaderId, status: "PENDING" },
          data: { reminderCount: { increment: 1 } },
        });
        linked = upd.count > 0;
      }
      await db.emailItem.create({
        data: {
          ...base,
          category: first.category,
          confidence: first.confidence,
          riskSignals: first.riskSignals,
          action: first.action,
          decisionId: first.decisionId,
          taskId: first.taskId,
        },
      });
      const saved = linked ? minutes.REPEAT_LINKED : 0;
      await db.activityLog.create({
        data: {
          createdAt: clock.now(),
          leaderId,
          pipeline: "EMAIL",
          action: linked ? "REPEAT_LINKED" : "REPEAT_TO_DIGEST",
          reason: linked
            ? `Повтор письма №${occurrence} привязан к открытой карточке`
            : `Повтор письма №${occurrence}: тред уже решён, попадёт в сводку`,
          savedMinutes: saved,
          metadata: { threadKey: key },
        },
      });
      stats.processed++;
      await opts.emit?.({ type: "email.processed", data: { externalId: email.externalId ?? null, repeat: true, occurrence } });
      if (linked) await opts.emit?.({ type: "decision.updated", data: { id: first.decisionId } });
      continue;
    }

    stats.threads++;
    const result = await triageEmail(
      llm,
      { leaderId, threadKey: key, senderEmail: email.senderEmail, subject: email.subject, body: email.body, recipients: email.recipients },
      risk,
      categoryRules,
    );
    const { classification: c, signals, decision } = result;

    let decisionId: string | null = null;
    let taskId: string | null = null;

    if (decision.action === "ASK_LEADER") {
      const draftText = (await opts.draft?.({ leaderId, email, summary: c.summary })) ?? null;
      const d = await db.decision.create({
        data: {
          createdAt: clock.now(),
          leaderId,
          type: DECISION_TYPE_BY_CATEGORY[c.category] ?? "EMAIL_REPLY",
          title: email.subject,
          contextSummary: c.summary,
          gateReasons: decision.reasons,
          aiRecommendation: "Спросить руководителя",
          proposedPayload: { tool: "mail.reply", args: { to: email.senderEmail, subject: email.subject } },
          draftText,
        },
      });
      decisionId = d.id;
      stats.decisionsCreated++;
      await opts.emit?.({ type: "decision.created", data: { id: d.id } });
    } else if (decision.action === "DELEGATE") {
      const rule = rules.find((r) => (r.condition as { category?: string } | null)?.category === c.category && r.delegateToArea);
      const assignee = rule?.delegateToArea
        ? await db.employee.findFirst({
            where: { leaderId, responsibilityArea: { contains: rule.delegateToArea, mode: "insensitive" } },
          })
        : null;
      if (assignee) {
        const due = parseDeadline(c.deadline, new Date(now.getTime() + 24 * 3_600_000));
        const t = await db.task.create({
          data: {
            leaderId,
            assigneeId: assignee.id,
            title: email.subject,
            description: c.summary,
            // TODO: LLM-формулировка измеримого критерия (SPEC 4.3.1).
            acceptanceCriteria: `Ответ или результат по письму «${email.subject}» передан отправителю`,
            sourceType: "EMAIL",
            sourceRefId: email.externalId ?? null,
            isClientCommitment: false,
            dueAt: due,
          },
        });
        taskId = t.id;
        stats.tasksCreated++;

      }
    }

    await db.emailItem.create({
      data: {
        ...base,
        category: c.category,
        confidence: c.confidence,
        riskSignals: signals,
        extracted: { amount: c.amount, client: c.client, deadline: c.deadline, summary: c.summary } as Prisma.InputJsonValue,
        action: decision.action,
        decisionId,
        taskId,
      },
    });
    // Воркер подхватит событие и отправит поручение исполнителю через Policy Gate.
    // Шлём после создания EmailItem: шлюзу нужны категория и уверенность исходного письма.
    if (taskId) await opts.emit?.({ type: "task.updated", data: { id: taskId, created: true } });

    const delegatedWithoutAssignee = decision.action === "DELEGATE" && !taskId;
    await db.activityLog.create({
      data: {
          createdAt: clock.now(),
        leaderId,
        pipeline: "EMAIL",
        action: decision.action,
        reason: [c.summary, ...decision.reasons, delegatedWithoutAssignee ? "Исполнитель по зоне ответственности не найден" : ""]
          .filter(Boolean)
          .join(". "),
        savedMinutes: decision.action === "ASK_LEADER" || delegatedWithoutAssignee ? 0 : (minutes[decision.action] ?? 0),
        metadata: { category: c.category, confidence: c.confidence, signals, emailId: email.externalId ?? null },
      },
    });
    bump(decision.action);
    stats.processed++;
    await opts.emit?.({ type: "email.processed", data: { externalId: email.externalId ?? null, action: decision.action } });
  }

  return stats;
}
