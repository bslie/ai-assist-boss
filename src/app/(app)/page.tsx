import { Suspense } from "react";
import { Composer } from "@/components/assistant/composer";
import { DecisionStack } from "@/components/assistant/decision-stack";
import { LiveRefresh } from "@/components/assistant/live-refresh";
import { DayList } from "@/components/assistant/day-list";
import { getToday, plural } from "@/core/dashboard";
import { db } from "@/db/client";
import { getCurrentLeader } from "@/lib/current-leader";

const TZ = "Europe/Moscow";
const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, ...o }).format(d);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function greeting(now: Date) {
  const h = Number(fmt(now, { hour: "2-digit", hour12: false }));
  return h < 12 ? "Доброе утро" : h < 18 ? "Добрый день" : "Добрый вечер";
}

const num = (n: number) => String(n).replace(".", ",");

async function Today() {
  const leader = await getCurrentLeader();
  if (!leader) {
    return <main className="mx-auto w-full max-w-[720px] flex-1 px-5 py-16 text-dim">Руководитель ещё не создан. Запустите <code>npm run db:seed</code>.</main>;
  }
  const [today, delegates] = await Promise.all([
    getToday(db, leader.id),
    db.employee.findMany({
      where: { leaderId: leader.id, relationType: "SUBORDINATE" },
      orderBy: { name: "asc" },
      select: { id: true, name: true, position: true },
    }),
  ]);
  const now = new Date(today.now);
  const firstName = leader.name.split(" ")[0];
  const { headline, metrics } = today;

  return (
    <>
      <LiveRefresh leaderId={leader.id} />
      <div className="mx-auto grid w-full max-w-[1280px] flex-1 grid-cols-1 content-start items-start gap-8 px-4 pt-2 sm:px-10 sm:pt-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-14">
        <main className="flex min-w-0 flex-col gap-6 sm:gap-8">
          <section aria-label="Утреннее сообщение" className="flex flex-col gap-4">
            <div className="text-[13px] text-dim">
              {cap(fmt(now, { weekday: "long", day: "numeric", month: "long" }))} · {fmt(now, { hour: "2-digit", minute: "2-digit" })}
            </div>
            <h1 className="font-serif text-[clamp(26px,5vw,44px)] font-normal leading-[1.15] tracking-[-0.02em]">
              {greeting(now)}, {firstName}.{" "}
              {headline.total > 0 ? `Я разобрала ${headline.handled} ${plural(headline.handled, "письмо", "письма", "писем")} из ${headline.total}. ` : "Новых писем пока нет. "}
              {headline.waiting > 0 ? (
                <span className="text-amber">{headline.waiting} без вас не решить.</span>
              ) : headline.total > 0 ? (
                <span className="text-amber">Всё, что требует вас, уже решено.</span>
              ) : null}
            </h1>
            {today.doneChips.length > 0 && (
              <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
                {today.doneChips.map((t) => (
                  <span key={t} className="flex min-h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-line bg-sunken px-3.5 text-[13px] text-soft">
                    <span className="size-2 rounded-full bg-sage" />
                    {t}
                  </span>
                ))}
              </div>
            )}
          </section>
          <section aria-label="Решения">
            <DecisionStack leaderId={leader.id} decisions={today.decisions} delegates={delegates} />
          </section>
        </main>

        <aside aria-label="Ваш день" className="flex min-w-0 flex-col gap-8 pt-2 lg:sticky lg:top-6">
          <div className="flex flex-col gap-1">
            <div className="text-[13px] text-dim">Ваш день</div>
            {today.day.length === 0 ? (
              <div className="pt-3.5 text-soft">На сегодня встреч нет.</div>
            ) : (
              <DayList items={today.day} />
            )}
          </div>
          <div className="flex flex-col gap-1.5 border-t border-line pt-6">
            <div className="text-[13px] text-dim">За неделю я освободила</div>
            <div className="font-serif text-[56px] font-normal leading-none tracking-[-0.02em] text-amber">{num(metrics.savedHours)} ч</div>
            <div className="text-sm text-soft">
              Писем, требующих вас, было {metrics.unreadBefore}, осталось {metrics.unreadAfter}. Открытых задач было {metrics.openTasksMorning.before}, на вас осталось {metrics.openTasksMorning.after}.
            </div>
          </div>
        </aside>
      </div>
      {/* Строка ввода прилипает к низу экрана на любой ширине; на десктопе стоит в колонке под карточками. */}
      <div className="sticky bottom-0 z-10 mx-auto mt-4 grid w-full max-w-[1280px] grid-cols-1 px-4 sm:px-10 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-14">
        <Composer leaderId={leader.id} />
      </div>
    </>
  );
}

export default function TodayPage() {
  return (
    <Suspense fallback={<main className="mx-auto w-full max-w-[720px] flex-1 px-5 py-16 text-dim">Загружаю план дня…</main>}>
      <Today />
    </Suspense>
  );
}
