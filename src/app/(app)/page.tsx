import { Suspense } from "react";
import { Composer } from "@/components/assistant/composer";
import { DecisionStack } from "@/components/assistant/decision-stack";
import { LiveRefresh } from "@/components/assistant/live-refresh";
import { getToday, plural, type Tone } from "@/core/dashboard";
import { db } from "@/db/client";
import { getCurrentLeader } from "@/lib/current-leader";

const DOT: Record<Tone, string> = { amber: "bg-amber", sage: "bg-sage", coral: "bg-coral", dim: "bg-dim" };
const NOTE: Record<Tone, string> = { amber: "text-amber", sage: "text-sage", coral: "text-coral", dim: "text-dim" };

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
      <div className="mx-auto flex w-full max-w-[1160px] flex-1 flex-wrap items-start gap-14 px-5 pb-10 pt-6 sm:px-10">
        <main className="flex min-w-0 max-w-[720px] flex-[999_1_520px] flex-col gap-8">
          <section aria-label="Утреннее сообщение" className="flex flex-col gap-4">
            <div className="text-[13px] text-dim">
              {cap(fmt(now, { weekday: "long", day: "numeric", month: "long" }))} · {fmt(now, { hour: "2-digit", minute: "2-digit" })}
            </div>
            <h1 className="font-serif text-[clamp(30px,5vw,44px)] font-normal leading-[1.12] tracking-[-0.02em]">
              {greeting(now)}, {firstName}.{" "}
              {headline.total > 0 ? `Я разобрала ${headline.handled} ${plural(headline.handled, "письмо", "письма", "писем")} из ${headline.total}. ` : "Новых писем пока нет. "}
              {headline.waiting > 0 ? (
                <span className="text-amber">{headline.waiting} без вас не решить.</span>
              ) : headline.total > 0 ? (
                <span className="text-amber">Всё, что требует вас, уже решено.</span>
              ) : null}
            </h1>
            {today.doneChips.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {today.doneChips.map((t) => (
                  <span key={t} className="flex min-h-9 items-center gap-2 rounded-full border border-line bg-sunken px-3.5 text-[13px] text-soft">
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

        <aside aria-label="Ваш день" className="flex min-w-0 flex-[1_1_280px] flex-col gap-8 pt-2">
          <div className="flex flex-col gap-1">
            <div className="text-[13px] text-dim">Ваш день</div>
            {today.day.length === 0 ? (
              <div className="pt-3.5 text-soft">На сегодня встреч нет.</div>
            ) : (
              <ol className="relative flex flex-col gap-[22px] pl-[22px] pt-3.5">
                <div className="absolute bottom-2 left-[5px] top-5 w-px bg-[#3d3931]" />
                {today.day.map((e, i) => (
                  <li key={`${e.time}-${e.title}-${i}`} className="relative flex flex-col gap-0.5">
                    <span className={`absolute -left-[22px] top-1.5 size-[11px] rounded-full border-2 border-ink ${DOT[e.tone]}`} />
                    <span className="text-[13px] text-dim">{e.time}</span>
                    <span className="font-medium">{e.title}</span>
                    {e.note && <span className={`text-[13px] ${NOTE[e.tone]}`}>{e.note}</span>}
                  </li>
                ))}
              </ol>
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
      <Composer />
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
