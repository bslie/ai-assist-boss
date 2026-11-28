import { Suspense } from "react";
import { RoutineList } from "@/components/assistant/routines-panel";
import { describeCron, listRoutines } from "@/core/routines";
import { db } from "@/db/client";
import { getCurrentLeader } from "@/lib/current-leader";

export const metadata = { title: "Рутины · ИИ-помощник руководителя" };

async function Routines() {
  const leader = await getCurrentLeader();
  if (!leader) return <p className="text-dim">Руководитель ещё не создан. Запустите <code>npm run db:seed</code>.</p>;
  const routines = await listRoutines(db, leader.id);
  return (
    <RoutineList
      leaderId={leader.id}
      routines={routines.map((r) => ({
        id: r.id,
        title: r.title,
        schedule: describeCron(r.cronExpression),
        cron: r.cronExpression,
        instruction: r.promptInstruction,
        isActive: r.isActive,
        lastRunAt: r.lastRunAt ? r.lastRunAt.toISOString() : null,
      }))}
    />
  );
}

export default function RoutinesPage() {
  return (
    <main className="mx-auto flex w-full max-w-[860px] flex-col gap-14 px-5 pb-24 pt-12 sm:px-10">
      <h1 className="font-serif text-[clamp(34px,5vw,52px)] font-normal leading-[1.1] tracking-[-0.02em]">Рутины: когда я пишу вам сама.</h1>
      <Suspense fallback={<div className="text-dim">Загружаю рутины…</div>}>
        <Routines />
      </Suspense>
    </main>
  );
}
