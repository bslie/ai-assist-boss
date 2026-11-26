import { Suspense } from "react";
import { LeaderWizard } from "@/components/assistant/leader-wizard";
import { ProfileImport } from "@/components/assistant/profile-import";
import { getCurrentUser } from "@/core/auth/current-user";
import { db } from "@/db/client";
import { getCurrentLeader } from "@/lib/current-leader";

const cron = (c: string) => {
  const [min, hour, , , dow] = c.split(" ");
  const time = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  const days = dow === "1-5" ? "по будням" : dow === "5" ? "по пятницам" : dow === "*" ? "каждый день" : `дни ${dow}`;
  return `${days} в ${time}`;
};

async function Profile() {
  const [leader, user] = await Promise.all([getCurrentLeader(), getCurrentUser()]);
  if (!leader) return <p className="text-dim">Руководитель ещё не создан. Запустите <code>npm run db:seed</code>.</p>;
  const [routines, ruleCount, employees, others] = await Promise.all([
    db.routine.findMany({ where: { leaderId: leader.id }, orderBy: { code: "asc" } }),
    db.rule.count({ where: { leaderId: leader.id } }),
    db.employee.count({ where: { leaderId: leader.id } }),
    user?.role === "ADMIN" ? db.leader.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, name: true, role: true, profileVersion: true } }) : Promise.resolve([]),
  ]);
  const goals = (leader.quarterGoals as string[]) ?? [];

  return (
    <>
      <section aria-labelledby="who" className="flex flex-col gap-4">
        <h2 id="who" className="font-serif text-2xl font-medium">{leader.name}</h2>
        <div className="text-soft">{leader.role}. Версия профиля {leader.profileVersion}, людей в оргструктуре: {employees}, правил: {ruleCount}.</div>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <div className="text-[13px] text-dim">Цели квартала</div>
            {goals.length === 0 ? <div className="text-dim">Не заданы.</div> : <ol className="list-decimal pl-5">{goals.map((g) => <li key={g}>{g}</li>)}</ol>}
          </div>
          <div className="flex flex-col gap-2">
            <div className="text-[13px] text-dim">Ритм</div>
            {routines.length === 0 ? <div className="text-dim">Рутин нет.</div> : <ul>{routines.map((r) => <li key={r.id}>{r.title}: {cron(r.cronExpression)}</li>)}</ul>}
            <div className="mt-2 text-[13px] text-dim">Порог по деньгам</div>
            <div>{leader.budgetAutoLimit > 0 ? `${leader.budgetAutoLimit.toLocaleString("ru-RU")} ₽` : "0 ₽: любые деньги только с вами"}</div>
            <div className="mt-2 text-[13px] text-dim">Манера писем</div>
            <div>{leader.stylePrompt || "Не задана."}</div>
          </div>
        </div>
      </section>

      <ProfileImport leaderId={leader.id} initial={leader.profileMarkdown} />

      {user?.role === "ADMIN" && (
        <>
          <section aria-labelledby="all" className="flex flex-col gap-3">
            <h2 id="all" className="font-serif text-2xl font-medium">Все профили</h2>
            <ul className="flex flex-col gap-2">
              {others.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center gap-x-4 rounded-[18px] border border-line bg-sunken px-5 py-3">
                  <span className="font-serif text-[19px]">{l.name}</span>
                  <span className="text-sm text-dim">{l.role}, версия {l.profileVersion}</span>
                </li>
              ))}
            </ul>
          </section>
          <LeaderWizard />
        </>
      )}
    </>
  );
}

export default function ProfilePage() {
  return (
    <main className="mx-auto flex w-full max-w-[860px] flex-col gap-14 px-5 pb-24 pt-12 sm:px-10">
      <h1 className="font-serif text-[clamp(34px,5vw,52px)] font-normal leading-[1.1] tracking-[-0.02em]">Профиль: цели, правила и ритм.</h1>
      <Suspense fallback={<div className="text-dim">Загружаю профиль…</div>}>
        <Profile />
      </Suspense>
    </main>
  );
}
