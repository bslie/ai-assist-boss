import { RuleInput } from "@/components/assistant/rule-input";

const Chip = ({ children }: { children: React.ReactNode }) => (
  <span className="inline-block rounded-full border border-[#3d3931] bg-raised px-3 font-sans text-xl">{children}</span>
);

const Label = ({ color, children, id }: { color: string; children: React.ReactNode; id: string }) => (
  <div id={id} className="flex items-center gap-2.5 text-[13px] font-semibold" style={{ color }}>
    <span className="size-2.5 rounded-full" style={{ background: color }} />
    {children}
  </div>
);

export default function RulesPage() {
  return (
    <main className="mx-auto flex w-full max-w-[860px] flex-col gap-14 px-5 pb-24 pt-12 sm:px-10">
      <h1 className="font-serif text-[clamp(34px,5vw,52px)] font-normal leading-[1.1] tracking-[-0.02em]">
        Вот как я с вами работаю. Скажите, если что-то нужно поменять.
      </h1>

      <section aria-labelledby="a" className="flex flex-col gap-4">
        <Label id="a" color="var(--sage)">Делаю сама</Label>
        <p className="font-serif text-[26px] leading-[1.7]">
          Рассылки и вендоров <Chip>отправляю в архив</Chip>, статусы и отчёты <Chip>складываю в утреннюю сводку</Chip>, встречи в рабочее время <Chip>подтверждаю сама</Chip>. Ежедневные планёрки <Chip>закрывает аватар</Chip>, а протокол я пришлю вам.
        </p>
        <div className="text-sm text-dim">Одно из этих правил я выучила сама: вы три раза подряд подтверждали такие встречи без правок.</div>
      </section>

      <section aria-labelledby="b" className="flex flex-col gap-4">
        <Label id="b" color="var(--amber)">Показываю вам</Label>
        <p className="font-serif text-[26px] leading-[1.7]">
          Всё про деньги выше
          <span className="mx-2 inline-flex items-center gap-1.5 rounded-full bg-amber py-0 pl-3.5 pr-1.5 font-sans text-xl font-semibold text-[#1b1305]">
            <label htmlFor="lim" className="sr-only">Порог по деньгам, рублей</label>
            <input id="lim" inputMode="numeric" defaultValue="0" className="min-h-9 w-14 bg-transparent text-right outline-none" />
            <span className="pr-2.5">₽</span>
          </span>
          и всё незнакомое я приношу вам с готовым черновиком. Если не уверена, тоже спрашиваю.
        </p>
      </section>

      <section aria-labelledby="c" className="flex flex-col gap-4 rounded-3xl border border-line-strong bg-sunken p-8">
        <Label id="c" color="var(--coral)">Никогда не решаю одна</Label>
        <p className="font-serif text-[26px] leading-normal">
          Кадры. Письма руководству. Обещания клиентам. Ни правилом, ни словами этого не переключить, даже если вы попросите.
        </p>
      </section>

      <RuleInput />
    </main>
  );
}
