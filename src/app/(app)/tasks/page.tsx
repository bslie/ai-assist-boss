import { Suspense } from "react";
import { NewTask, TaskList } from "@/components/assistant/tasks-panel";
import { readyClock } from "@/core/clock";
import { listTasks } from "@/core/tasks/registry";
import { db } from "@/db/client";
import { getCurrentLeader } from "@/lib/current-leader";

async function Tasks() {
  const leader = await getCurrentLeader();
  if (!leader) return <p className="text-dim">Руководитель ещё не создан. Запустите <code>npm run db:seed</code>.</p>;
  await readyClock();
  const [tasks, people] = await Promise.all([
    listTasks(db, leader.id),
    db.employee.findMany({ where: { leaderId: leader.id, relationType: "SUBORDINATE" }, orderBy: { name: "asc" }, select: { id: true, name: true, position: true } }),
  ]);
  const open = tasks.filter((t) => t.status !== "DONE");
  const done = tasks.filter((t) => t.status === "DONE");
  return (
    <>
      <NewTask leaderId={leader.id} people={people} />
      <section aria-labelledby="open" className="flex flex-col gap-4">
        <h2 id="open" className="font-serif text-2xl font-medium">В работе ({open.length})</h2>
        <TaskList tasks={open} />
      </section>
      {done.length > 0 && (
        <section aria-labelledby="done" className="flex flex-col gap-4">
          <h2 id="done" className="font-serif text-2xl font-medium">Закрыто ({done.length})</h2>
          <TaskList tasks={done} />
        </section>
      )}
    </>
  );
}

export default function TasksPage() {
  return (
    <main className="mx-auto flex w-full max-w-[860px] flex-col gap-14 px-5 pb-24 pt-12 sm:px-10">
      <h1 className="font-serif text-[clamp(34px,5vw,52px)] font-normal leading-[1.1] tracking-[-0.02em]">Поручения: что в работе и у кого.</h1>
      <Suspense fallback={<div className="text-dim">Загружаю поручения…</div>}>
        <Tasks />
      </Suspense>
    </main>
  );
}
