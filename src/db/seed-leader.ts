/**
 * Создание руководителя из данных: оргструктура, профиль, календарь, задачи.
 * Никакой логики конкретного руководителя: всё приходит параметрами (SPEC инвариант 5).
 */
import type { PrismaClient, TaskStatus } from "@/generated/prisma/client";
import type { CalendarEvent } from "../core/dataset/ics";
import type { DatasetTask, OrgMember } from "../core/dataset";
import { applyProfile, diffProfile, type ProfileDiff, type ProfileDraft } from "../core/profile";

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l",
  м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh",
  щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .split("")
    .map((c) => TRANSLIT[c] ?? c)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const TASK_STATUS: Record<string, TaskStatus> = {
  новая: "NEW",
  "в работе": "IN_PROGRESS",
  // «просрочена» — это признак срока (SPEC 4.3.6), а не отдельный статус: работа идёт.
  просрочена: "IN_PROGRESS",
};

export interface SeedLeaderInput {
  leader: { name: string; role: string; email: string };
  members: OrgMember[];
  areas: Record<string, string>;
  profileMarkdown: string;
  draft: ProfileDraft;
  meetings: CalendarEvent[];
  tasks: DatasetTask[];
}

export interface SeedLeaderResult {
  leaderId: string;
  diff: ProfileDiff;
  employees: number;
  meetings: number;
  tasks: number;
}

export async function seedLeader(db: PrismaClient, input: SeedLeaderInput): Promise<SeedLeaderResult> {
  const slug = slugify(input.leader.name);
  const leader = await db.leader.upsert({
    where: { slug },
    update: { name: input.leader.name, role: input.leader.role, email: input.leader.email },
    create: {
      slug,
      name: input.leader.name,
      role: input.leader.role,
      email: input.leader.email,
      quarterGoals: [],
      stylePrompt: "",
      savedMinutesConfig: {},
      profileMarkdown: "",
    },
  });
  const leaderId = leader.id;

  const byName = new Map<string, string>();
  for (const m of input.members) {
    const e = await db.employee.upsert({
      where: { leaderId_email: { leaderId, email: m.email } },
      update: { name: m.name, position: m.position, relationType: m.relationType, responsibilityArea: input.areas[m.externalId] ?? null },
      create: {
        leaderId,
        externalId: m.externalId,
        name: m.name,
        email: m.email,
        position: m.position,
        relationType: m.relationType,
        responsibilityArea: input.areas[m.externalId] ?? null,
      },
    });
    byName.set(m.name, e.id);
  }

  const diff = await diffProfile(db, leaderId, input.draft);
  await applyProfile(db, leaderId, input.draft, input.profileMarkdown);

  // Календарь и задачи пересоздаются целиком: сидер идемпотентен.
  await db.meeting.deleteMany({ where: { leaderId, externalId: { not: null } } });
  await db.meeting.createMany({
    data: input.meetings.map((e) => ({
      leaderId,
      externalId: e.uid,
      title: e.summary,
      category: e.category,
      startAt: e.start,
      endAt: e.end,
    })),
  });

  await db.task.deleteMany({ where: { leaderId, sourceType: "DATASET" } });
  await db.task.createMany({
    data: input.tasks.map((t) => ({
      leaderId,
      externalId: t.externalId,
      assigneeId: byName.get(t.ownerName) ?? null, // задачи самого руководителя без исполнителя
      title: t.title,
      description: `Источник: ${t.source}`,
      // TODO: измеримый критерий формулирует LLM при постановке (SPEC 4.3.1).
      acceptanceCriteria: `Результат по задаче «${t.title}» предоставлен к сроку`,
      sourceType: "DATASET",
      dueAt: t.dueAt,
      csvStatus: t.csvStatus,
      status: TASK_STATUS[t.csvStatus] ?? "NEW",
    })),
  });

  return { leaderId, diff, employees: input.members.length, meetings: input.meetings.length, tasks: input.tasks.length };
}
