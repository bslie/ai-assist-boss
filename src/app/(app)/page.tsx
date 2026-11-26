import { Composer } from "@/components/assistant/composer";
import { DecisionStack } from "@/components/assistant/decision-stack";
import { demoDay, demoLeader } from "@/lib/demo-data";

const DOT = { amber: "bg-amber", sage: "bg-sage", coral: "bg-coral", dim: "bg-dim" } as const;
const NOTE = { amber: "text-amber", sage: "text-sage", coral: "text-coral", dim: "text-dim" } as const;
const DONE = ["Отписала 5 рассылок", "Подтвердила встречу в рабочее время", "Три статуса ушли в сводку"];

export default function TodayPage() {
  return (
    <>
      <div className="mx-auto flex w-full max-w-[1160px] flex-1 flex-wrap items-start gap-14 px-5 pb-10 pt-6 sm:px-10">
        <main className="flex min-w-0 max-w-[720px] flex-[999_1_520px] flex-col gap-8">
          <section aria-label="Утреннее сообщение" className="flex flex-col gap-4">
            <div className="text-[13px] text-dim">Четверг, 10 декабря · 08:30</div>
            <h1 className="font-serif text-[clamp(30px,5vw,44px)] font-normal leading-[1.12] tracking-[-0.02em]">
              Доброе утро, {demoLeader.firstName}. Пока вы спали, я разобрала 11 писем из 15.{" "}
              <span className="text-amber">Четыре без вас не решить.</span>
            </h1>
            <div className="flex flex-wrap gap-2">
              {DONE.map((t) => (
                <span key={t} className="flex min-h-9 items-center gap-2 rounded-full border border-line bg-sunken px-3.5 text-[13px] text-soft">
                  <span className="size-2 rounded-full bg-sage" />
                  {t}
                </span>
              ))}
            </div>
          </section>
          <section aria-label="Решения">
            <DecisionStack />
          </section>
        </main>

        <aside aria-label="Ваш день" className="flex min-w-0 flex-[1_1_280px] flex-col gap-8 pt-2">
          <div className="flex flex-col gap-1">
            <div className="text-[13px] text-dim">Ваш день</div>
            <ol className="relative flex flex-col gap-[22px] pl-[22px] pt-3.5">
              <div className="absolute bottom-2 left-[5px] top-5 w-px bg-[#3d3931]" />
              {demoDay.map((e) => (
                <li key={e.time} className="relative flex flex-col gap-0.5">
                  <span className={`absolute -left-[22px] top-1.5 size-[11px] rounded-full border-2 border-ink ${DOT[e.tone]}`} />
                  <span className="text-[13px] text-dim">{e.time}</span>
                  <span className="font-medium">{e.title}</span>
                  <span className={`text-[13px] ${NOTE[e.tone]}`}>{e.note}</span>
                </li>
              ))}
            </ol>
          </div>
          <div className="flex flex-col gap-1.5 border-t border-line pt-6">
            <div className="text-[13px] text-dim">За неделю я освободила</div>
            <div className="font-serif text-[56px] font-normal leading-none tracking-[-0.02em] text-amber">9,5 ч</div>
            <div className="text-sm text-soft">Непрочитанных писем было 38, стало 6. Открытых задач утром было 11, стало 4.</div>
          </div>
        </aside>
      </div>
      <Composer />
    </>
  );
}
