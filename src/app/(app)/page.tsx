import { Suspense, type CSSProperties } from "react";
import { IntroGate } from "@/components/assistant/intro-gate";
import { CountUp } from "@/components/assistant/count-up";
import { TypedHeadline } from "@/components/assistant/typed-headline";
import { Composer } from "@/components/assistant/composer";
import { DecisionStack } from "@/components/assistant/decision-stack";
import { LiveRefresh } from "@/components/assistant/live-refresh";
import { DayList } from "@/components/assistant/day-list";
import { LearningStatus } from "@/components/assistant/learning-status";
import { ConnectStrip } from "@/components/assistant/connect-strip";
import { getToday, plural } from "@/core/dashboard";
import { getLearningStatus } from "@/core/learning/mode";
import { getReadiness } from "@/core/connectors/readiness";
import { db } from "@/db/client";
import { getCurrentLeader } from "@/lib/current-leader";

const TZ = "Europe/Moscow";
const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, ...o }).format(d);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function greeting(now: Date) {
  const h = Number(fmt(now, { hour: "2-digit", hour12: false }));
  return h < 12 ? "Доброе утро" : h < 18 ? "Добрый день" : "Добрый вечер";
}

async function Today() {
  const leader = await getCurrentLeader();
  if (!leader) {
    return <main className="mx-auto w-full max-w-[720px] flex-1 px-5 py-16 text-dim">Руководитель ещё не создан. Запустите <code>npm run db:seed</code>.</main>;
  }
  const [today, delegates, learning, readiness] = await Promise.all([
    getToday(db, leader.id),
    db.employee.findMany({
      where: { leaderId: leader.id, relationType: "SUBORDINATE" },
      orderBy: { name: "asc" },
      select: { id: true, name: true, position: true },
    }),
    getLearningStatus(db, leader.id),
    getReadiness(db, leader.id),
  ]);
  const connectLabel =
    !readiness.mail && !readiness.calendar
      ? "Подключите почту и календарь — начну работать с вашими письмами и встречами, а не с демо-данными"
      : !readiness.mail
        ? "Подключите почту — начну разбирать ваши настоящие письма"
        : "Подключите календарь — буду готовить вас к встречам и беречь защищённое время";
  const connectShort = !readiness.mail && !readiness.calendar ? "Подключите почту и календарь" : !readiness.mail ? "Подключите почту" : "Подключите календарь";
  const now = new Date(today.now);
  const firstName = leader.name.split(" ")[0];
  const { headline, metrics } = today;

  return (
    <>
      <IntroGate />
      <LiveRefresh leaderId={leader.id} />
      <div className="mx-auto grid w-full max-w-[1280px] flex-1 grid-cols-1 content-start items-start gap-8 px-4 pt-2 sm:px-10 sm:pt-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-14">
        <main className="flex min-w-0 flex-col gap-6 sm:gap-8">
          <section aria-label="Утреннее сообщение" className="flex flex-col gap-4">
            <div className="text-[13px] text-dim">
              {cap(fmt(now, { weekday: "long", day: "numeric", month: "long" }))} · {fmt(now, { hour: "2-digit", minute: "2-digit" })}
            </div>
            <TypedHeadline
              className="font-serif text-[clamp(26px,5vw,44px)] font-normal leading-[1.15] tracking-[-0.02em]"
              segments={[
                {
                  text: `${greeting(now)}, ${firstName}. ${
                    headline.total > 0 ? `Я разобрала ${headline.handled} ${plural(headline.handled, "письмо", "письма", "писем")} из ${headline.total}. ` : "Новых писем пока нет. "
                  }`,
                },
                ...(headline.waiting > 0
                  ? [{ text: `${headline.waiting} без вас не решить.`, className: "text-amber" }]
                  : headline.total > 0
                    ? [{ text: "Всё, что требует вас, уже решено.", className: "text-amber" }]
                    : []),
              ]}
            />
            {today.doneChips.length > 0 && (
              <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
                {today.doneChips.map((t, i) => (
                  <span
                    key={t}
                    style={{ "--d": `${1700 + i * 110}ms` } as CSSProperties}
                    className="rise flex min-h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-line bg-sunken px-3.5 text-[13px] text-soft"
                  >
                    <span className="pulse-dot size-2 rounded-full bg-sage" style={{ "--d": `${1900 + i * 110}ms` } as CSSProperties} />
                    {t}
                  </span>
                ))}
              </div>
            )}
            <div className="rise" style={{ "--d": "1950ms" } as CSSProperties}>
              <LearningStatus leaderId={leader.id} status={learning} />
            </div>
          </section>
          <section aria-label="Решения" className="rise" style={{ "--d": "2100ms" } as CSSProperties}>
            <DecisionStack leaderId={leader.id} decisions={today.decisions} delegates={delegates} />
          </section>
        </main>

        <aside aria-label="Ваш день" className="flex min-w-0 flex-col gap-8 pt-2 lg:sticky lg:top-6">
          <div className="rise flex flex-col gap-1" style={{ "--d": "300ms" } as CSSProperties}>
            <div className="text-[13px] text-dim">Ваш день</div>
            {today.day.length === 0 ? (
              <div className="pt-3.5 text-soft">На сегодня встреч нет.</div>
            ) : (
              <DayList items={today.day} leaderId={leader.id} />
            )}
          </div>
          <div className="rise flex flex-col gap-1.5 border-t border-line pt-6" style={{ "--d": "600ms" } as CSSProperties}>
            <div className="text-[13px] text-dim">За неделю я освободила</div>
            <CountUp value={metrics.savedHours} className="font-serif text-[56px] font-normal leading-none tracking-[-0.02em] text-amber" suffix=" ч" delay={700} />
            <div className="text-sm text-soft">
              Писем, требующих вас, было {metrics.unreadBefore}, осталось {metrics.unreadAfter}. Открытых задач было {metrics.openTasksMorning.before}, на вас осталось {metrics.openTasksMorning.after}.
            </div>
          </div>
        </aside>
      </div>
      {/* Строка ввода прилипает к низу экрана на любой ширине; на десктопе стоит в колонке под карточками. */}
      <div className="sticky bottom-0 z-10 mx-auto mt-4 grid w-full max-w-[1280px] grid-cols-1 px-4 sm:px-10 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-14">
        <Composer leaderId={leader.id}>
          <ConnectStrip leaderId={leader.id} missing={readiness.missing} label={connectLabel} short={connectShort} />
        </Composer>
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
