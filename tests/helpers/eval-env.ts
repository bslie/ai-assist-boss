import { readFileSync } from "node:fs";
import path from "node:path";
import { DATASET_DIR, loadOrg, loadProfileMarkdown, loadTasks } from "@/core/dataset";
import { loadCalendar } from "@/core/dataset/ics";
import { ProfileDraftSchema } from "@/core/profile";
import type { PrismaClient } from "@/generated/prisma/client";
import { seedLeader } from "@/db/seed-leader";

/** Создаёт временного руководителя из датасета для eval/интеграционных тестов. */
export async function seedTempLeader(db: PrismaClient, label: string): Promise<string> {
  const org = loadOrg();
  const stamp = Date.now();
  const res = await seedLeader(db, {
    leader: { name: `Тест ${label} ${stamp}`, role: org.leader.position, email: `${label}-${stamp}@${org.emailDomain}` },
    members: org.members,
    areas: JSON.parse(readFileSync(path.join(DATASET_DIR, "responsibility_areas.json"), "utf8")) as Record<string, string>,
    profileMarkdown: loadProfileMarkdown(),
    draft: ProfileDraftSchema.parse(JSON.parse(readFileSync(path.join(DATASET_DIR, "leader_profile.draft.json"), "utf8"))),
    meetings: loadCalendar(),
    tasks: loadTasks(),
  });
  return res.leaderId;
}
