/**
 * «Загрузить датасет» для уже существующего руководителя: оргструктура, поручения и календарь из data/tz_dataset.
 * Профиль, имя и настройки руководителя не трогаем. Идемпотентно: сотрудники обновляются по почте,
 * а встречи и поручения добавляются, только если у руководителя их ещё нет (чтобы не стереть протоколы и ход задач).
 */
import { DATASET_DIR, loadAreas, loadOrg, loadTasks } from "@/core/dataset";
import { loadCalendar } from "@/core/dataset/ics";
import type { PrismaClient } from "@/generated/prisma/client";
import { seedEmployees, seedMeetings, seedTasks } from "./seed-leader";

export interface DatasetBaseResult {
  employees: number;
  meetingsAdded: number;
  tasksAdded: number;
}

export async function ensureDatasetBase(db: PrismaClient, leaderId: string): Promise<DatasetBaseResult> {
  const leader = await db.leader.findFirstOrThrow({ where: { id: leaderId }, select: { protectedBlocks: true } });
  const org = loadOrg(DATASET_DIR, "company.example", "org_structure.csv");
  const byName = await seedEmployees(db, leaderId, org.members, loadAreas());
  // Имя → id и для уже существующих сотрудников: поручения привязываются к ним, даже если оргструктура грузилась раньше.
  for (const e of await db.employee.findMany({ where: { leaderId }, select: { id: true, name: true } })) byName.set(e.name, e.id);

  const haveMeetings = await db.meeting.count({ where: { leaderId, externalId: { not: null }, NOT: { externalId: { startsWith: "gcal:" } } } });
  const haveTasks = await db.task.count({ where: { leaderId, sourceType: "DATASET" } });
  const meetings = haveMeetings === 0 ? loadCalendar() : [];
  const tasks = haveTasks === 0 ? loadTasks() : [];
  if (meetings.length > 0) await seedMeetings(db, leaderId, meetings, leader.protectedBlocks);
  if (tasks.length > 0) await seedTasks(db, leaderId, tasks, byName);
  return { employees: org.members.length, meetingsAdded: meetings.length, tasksAdded: tasks.length };
}
