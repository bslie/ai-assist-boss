import { Suspense } from "react";
import { LeaderWizard } from "@/components/assistant/leader-wizard";
import { ProfileImport } from "@/components/assistant/profile-import";
import { ProfileText } from "@/components/assistant/profile-text";
import { getCurrentUser } from "@/core/auth/current-user";
import { describeCron } from "@/core/routines";
import { db } from "@/db/client";
import { getCurrentLeader } from "@/lib/current-leader";

export const metadata = { title: "Профиль · ИИ-помощник руководителя" };

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
      <section aria-labelledby="who" className="flex flex-col gap-3">
        <h2 id="who" className="font-serif text-[34px] font-normal leading-tight tracking-[-0.01em]">{leader.name}</h2>
        <div className="text-soft">{leader.role}</div>
        <div className="flex flex-wrap gap-2 pt-1 text-[13px] text-dim">
          {[`Версия профиля ${leader.profileVersion}`, `${employees} в оргструктуре`, `${ruleCount} правил`].map((t) => (
            <span key={t} className="rounded-full border border-line px-3 py-1">{t}</span>
          ))}
        </div>
        <p className="mt-2 rounded-[18px] border border-line bg-sunken px-5 py-4 text-[15px] leading-relaxed text-soft">
          Чтобы что-то изменить, напишите мне в чате на странице «Разговор»: «добавь цель квартала…», «порог по деньгам 50 тысяч», «пиши мне короче». Я покажу, что поменяется, и запишу после вашего «да».
        </p>
      </section>

      <section aria-labelledby="goals" className="flex flex-col gap-4">
        <h2 id="goals" className="font-serif text-2xl font-medium">Цели квартала</h2>
        {goals.length === 0 ? (
          <p className="text-dim">Не заданы.</p>
        ) : (
          <ol className="flex flex-col rounded-[18px] border border-line bg-sunken">
            {goals.map((g, i) => (
              <li key={g} className="flex items-baseline gap-5 border-t border-line px-6 py-4 first:border-t-0">
                <span className="w-6 shrink-0 font-serif text-[28px] leading-none text-amber">{i + 1}</span>
                <span className="text-[17px] leading-snug">{g}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-label="Порог и манера" className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-[18px] border border-line bg-sunken px-6 py-5">
          <div className="text-[13px] text-dim">Порог по деньгам</div>
          <div className="font-serif text-[34px] leading-none text-amber">{leader.budgetAutoLimit.toLocaleString("ru-RU")} ₽</div>
          <div className="text-sm text-soft">{leader.budgetAutoLimit > 0 ? "До этой суммы я согласую расходы сама, выше — только с вами." : "Любые деньги я согласую только с вами."}</div>
        </div>
        <div className="flex flex-col gap-2 rounded-[18px] border border-line bg-sunken px-6 py-5">
          <div className="text-[13px] text-dim">Манера писем</div>
          <div className="font-serif text-[19px] leading-snug">{leader.stylePrompt || "Не задана."}</div>
        </div>
      </section>

      <section aria-labelledby="rhythm" className="flex flex-col gap-4">
        <h2 id="rhythm" className="font-serif text-2xl font-medium">Ритм</h2>
        {routines.length === 0 ? (
          <p className="text-dim">Пока нет: утренний план и итог недели появятся после загрузки профиля ниже.</p>
        ) : (
          <ul className="flex flex-col rounded-[18px] border border-line bg-sunken">
            {routines.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-t border-line px-6 py-4 first:border-t-0">
                <span className="font-serif text-[19px]">{r.title}</span>
                <span className="text-sm text-soft">{describeCron(r.cronExpression)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="full">
        <details className="group rounded-[18px] border border-line bg-sunken">
          <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 px-6 py-4 [&::-webkit-details-marker]:hidden">
            <h2 id="full" className="font-serif text-xl font-medium">Профиль целиком</h2>
            <span className="text-sm text-dim group-open:hidden">Показать</span>
            <span className="hidden text-sm text-dim group-open:inline">Скрыть</span>
          </summary>
          <div className="border-t border-line px-6 py-5">
            <ProfileText markdown={leader.profileMarkdown} />
          </div>
        </details>
      </section>

      {/* SPEC 4.6: «скопировать leader_profile.md, поменять — агент работает без изменения кода». */}
      <section aria-labelledby="import">
        <details className="group rounded-[18px] border border-line bg-sunken">
          <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 px-6 py-4 [&::-webkit-details-marker]:hidden">
            <h2 id="import" className="font-serif text-xl font-medium">Загрузить профиль из текста</h2>
            <span className="text-sm text-dim group-open:hidden">leader_profile.md</span>
            <span className="hidden text-sm text-dim group-open:inline">Скрыть</span>
          </summary>
          <div className="border-t border-line px-6 py-5">
            <ProfileImport leaderId={leader.id} initial={leader.profileMarkdown} />
          </div>
        </details>
      </section>

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
