/**
 * Сидер: `npm run db:seed`. Руководитель 1 из data/tz_dataset.
 * Профиль берётся из `leader_profile.draft.json` (проверяется той же zod-схемой);
 * если файла нет — импорт через LLM (нужны LLM_BASE_URL и LLM_MODEL).
 * Письма inbox.csv через пайплайн 4.2 подключаются отдельным шагом (нужна LLM).
 */
import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DATASET_DIR, loadOrg, loadProfileMarkdown, loadTasks } from "@/core/dataset";
import { loadCalendar } from "@/core/dataset/ics";
import { ProfileDraftSchema, importProfile, type ProfileDraft } from "@/core/profile";
import { db } from "@/db/client";
import { seedLeader } from "@/db/seed-leader";

async function resolveDraft(markdown: string): Promise<ProfileDraft> {
  const file = path.join(DATASET_DIR, "leader_profile.draft.json");
  if (existsSync(file)) return ProfileDraftSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const { createLlmClientFromEnv } = await import("@/core/llm/providers");
  // leaderId для UsageLog появится после создания руководителя: черновик строится заранее без записи в лог.
  const llm = createLlmClientFromEnv();
  const { draft, warnings } = await importProfile(llm, "seed", markdown);
  warnings.forEach((w) => console.warn(`profile warning: ${w.rule}: ${w.message}`));
  return draft;
}

async function main() {
  const org = loadOrg();
  const markdown = loadProfileMarkdown();
  const areasFile = path.join(DATASET_DIR, "responsibility_areas.json");
  const areas = existsSync(areasFile)
    ? (JSON.parse(readFileSync(areasFile, "utf8")) as Record<string, string>)
    : {};

  const res = await seedLeader(db, {
    leader: { name: org.leader.name, role: org.leader.position, email: org.leader.email },
    members: org.members,
    areas,
    profileMarkdown: markdown,
    draft: await resolveDraft(markdown),
    meetings: loadCalendar(),
    tasks: loadTasks(),
  });
  console.log("seeded", { ...res, diff: undefined });
  console.log("profile diff", JSON.stringify(res.diff));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
