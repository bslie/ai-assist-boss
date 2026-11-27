/**
 * Сидер: `npm run db:seed` (оба руководителя) или `npm run db:seed -- --only <slug>`.
 * Руководитель 1 — из data/tz_dataset, руководитель 2 — из data/profiles (SPEC 7.1).
 * Профиль берётся из `*.draft.json` рядом с markdown (проверяется той же zod-схемой);
 * если файла нет — импорт через LLM (нужны LLM_BASE_URL и LLM_MODEL).
 * Письма inbox.csv через пайплайн 4.2 подключаются отдельным шагом (нужна LLM): POST /api/demo/simulate.
 * Сидер идемпотентен, но пересоздаёт календарь и задачи датасета выбранного руководителя:
 * чтобы не затронуть уже настроенного руководителя, укажите `--only`.
 */
import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DATASET_DIR, PROFILES_DIR, loadAreas, loadOrg, loadProfileMarkdown, loadTasks } from "@/core/dataset";
import { loadCalendar } from "@/core/dataset/ics";
import { ProfileDraftSchema, importProfile, type ProfileDraft } from "@/core/profile";
import { db } from "@/db/client";
import { seedLeader, slugify } from "@/db/seed-leader";

interface LeaderSource {
  dir: string;
  org: string;
  areas: string;
  profile: string;
  draft: string;
  tasks: string;
  /** Календарь датасета подключается только первому руководителю: встречи привязаны к его людям. */
  calendar: boolean;
}

const SOURCES: LeaderSource[] = [
  {
    dir: DATASET_DIR,
    org: "org_structure.csv",
    areas: "responsibility_areas.json",
    profile: "leader_profile.md",
    draft: "leader_profile.draft.json",
    tasks: "tasks.csv",
    calendar: true,
  },
  {
    dir: PROFILES_DIR,
    org: "leader2_org.csv",
    areas: "leader2_areas.json",
    profile: "leader2_profile.md",
    draft: "leader2_profile.draft.json",
    tasks: "leader2_tasks.csv",
    calendar: false,
  },
];

async function resolveDraft(src: LeaderSource, markdown: string): Promise<ProfileDraft> {
  const file = path.join(src.dir, src.draft);
  if (existsSync(file)) return ProfileDraftSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const { createLlmClientFromEnv } = await import("@/core/llm/providers");
  // leaderId для UsageLog появится после создания руководителя: черновик строится заранее без записи в лог.
  const llm = createLlmClientFromEnv();
  const { draft, warnings } = await importProfile(llm, "seed", markdown);
  warnings.forEach((w) => console.warn(`profile warning: ${w.rule}: ${w.message}`));
  return draft;
}

async function seedOne(src: LeaderSource) {
  const org = loadOrg(src.dir, "company.example", src.org);
  const markdown = loadProfileMarkdown(path.join(src.dir, src.profile));
  const res = await seedLeader(db, {
    leader: { name: org.leader.name, role: org.leader.position, email: org.leader.email },
    members: org.members,
    areas: loadAreas(path.join(src.dir, src.areas)),
    profileMarkdown: markdown,
    draft: await resolveDraft(src, markdown),
    meetings: src.calendar ? loadCalendar() : [],
    tasks: loadTasks(src.dir, src.tasks),
  });
  console.log(`seeded ${slugify(org.leader.name)}`, { ...res, diff: undefined });
  console.log("profile diff", JSON.stringify(res.diff));
}

async function main() {
  const i = process.argv.indexOf("--only");
  const only = i >= 0 ? process.argv[i + 1] : null;
  let done = 0;
  for (const src of SOURCES) {
    const org = loadOrg(src.dir, "company.example", src.org);
    if (only && only !== slugify(org.leader.name)) continue;
    await seedOne(src);
    done++;
  }
  if (done === 0) throw new Error(`Руководитель «${only}» не найден среди источников сидера`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
