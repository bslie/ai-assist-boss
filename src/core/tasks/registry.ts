/**
 * Реестр поручений (SPEC 6: /api/tasks, P1). Все запросы по leaderId.
 * Создание поручения только внутренняя запись; сообщение исполнителю уходит позже через Policy Gate
 * (воркер подхватывает событие task.updated с created=true).
 */
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { clock } from "../clock";
import { publishEvent } from "../events";
import type { LlmClient } from "../llm";
import { formulateCriteria } from "./criteria";

export const CreateTaskSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(2000).default(""),
  assigneeId: z.string().min(1),
  dueAt: z.coerce.date(),
  /** Пусто → формулирует модель (SPEC 4.3.1); нет модели → текст по умолчанию. */
  acceptanceCriteria: z.string().trim().max(500).optional(),
  isClientCommitment: z.boolean().default(false),
  isTypical: z.boolean().default(false),
});
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;

export interface TaskRow {
  id: string;
  title: string;
  assignee: string | null;
  status: string;
  dueAt: string;
  overdue: boolean;
  acceptanceCriteria: string;
  isClientCommitment: boolean;
  isTypical: boolean;
  rescheduleCount: number;
  returnCount: number;
  source: string;
}

const OPEN_LAST = new Set(["DONE"]);

export async function listTasks(db: PrismaClient, leaderId: string): Promise<TaskRow[]> {
  const now = clock.now();
  const tasks = await db.task.findMany({ where: { leaderId }, include: { assignee: { select: { name: true } } }, orderBy: { dueAt: "asc" } });
  return tasks
    .map((t) => ({
      id: t.id,
      title: t.title,
      assignee: t.assignee?.name ?? null,
      status: t.status,
      dueAt: t.dueAt.toISOString(),
      // SPEC 4.3.6: просрочена, если срок прошёл или в CSV «просрочена».
      overdue: t.status !== "DONE" && (t.dueAt < now || t.csvStatus === "просрочена"),
      acceptanceCriteria: t.acceptanceCriteria,
      isClientCommitment: t.isClientCommitment,
      isTypical: t.isTypical,
      rescheduleCount: t.rescheduleCount,
      returnCount: t.returnCount,
      source: t.sourceType,
    }))
    .sort((a, b) => Number(OPEN_LAST.has(a.status)) - Number(OPEN_LAST.has(b.status)));
}

export type CreateTaskResult = { ok: true; id: string } | { ok: false; code: "BAD_ASSIGNEE" | "PAST_DUE"; message: string };

export async function createTask(db: PrismaClient, llm: LlmClient | null, leaderId: string, input: CreateTaskInput): Promise<CreateTaskResult> {
  const assignee = await db.employee.findFirst({ where: { id: input.assigneeId, leaderId }, select: { id: true } });
  if (!assignee) return { ok: false, code: "BAD_ASSIGNEE", message: "Исполнитель не найден у этого руководителя" };
  if (input.dueAt.getTime() <= clock.now().getTime()) return { ok: false, code: "PAST_DUE", message: "Срок уже прошёл" };

  let criteria = input.acceptanceCriteria?.trim() || "";
  if (!criteria && llm) criteria = await formulateCriteria(llm, leaderId, { title: input.title, description: input.description }).catch(() => "");
  if (!criteria) criteria = `Результат по задаче «${input.title}» предоставлен к сроку`;

  const t = await db.task.create({
    data: {
      leaderId,
      assigneeId: assignee.id,
      title: input.title,
      description: input.description,
      acceptanceCriteria: criteria,
      isClientCommitment: input.isClientCommitment,
      isTypical: input.isTypical,
      sourceType: "CHAT",
      dueAt: input.dueAt,
    },
  });
  await publishEvent(leaderId, { type: "task.updated", data: { id: t.id, created: true } });
  return { ok: true, id: t.id };
}
