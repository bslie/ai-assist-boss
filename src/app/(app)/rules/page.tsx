import { Suspense } from "react";
import { LearnedRules } from "@/components/assistant/learned-rules";
import { RuleInput } from "@/components/assistant/rule-input";
import { BudgetLimit, ProtectedBlocks, RuleList, type RuleItem } from "@/components/assistant/rules-panel";
import { readyClock } from "@/core/clock";
import { listLearned } from "@/core/memory";
import { isLockedCategory } from "@/core/policy-gate";
import { listRules } from "@/core/rules";
import { db } from "@/db/client";
import { getCurrentLeader } from "@/lib/current-leader";

const Label = ({ color, children, id }: { color: string; children: React.ReactNode; id: string }) => (
  <div id={id} className="flex items-center gap-2.5 text-[13px] font-semibold" style={{ color }}>
    <span className="size-2.5 rounded-full" style={{ background: color }} />
    {children}
  </div>
);

async function Rules() {
  const leader = await getCurrentLeader();
  if (!leader) return null;
  const clk = await readyClock();
  const now = clk.now();
  const [{ settings, rules }, learned] = await Promise.all([listRules(db, leader.id), listLearned(db, leader.id)]);

  const items: RuleItem[] = rules
    // Просроченные «на неделю» уже не действуют: не показываем их как действующие.
    .filter((r) => !r.expiresAt || r.expiresAt > now)
    .map((r) => {
      const cond = (r.condition as { category?: string; senderEmail?: string } | null) ?? {};
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        action: r.action,
        category: cond.category ?? null,
        senderEmail: cond.senderEmail ?? null,
        isSystemLocked: r.isSystemLocked,
        locked: Boolean(cond.category && isLockedCategory(cond.category)),
        expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      };
    });
  const locked = items.filter((r) => r.isSystemLocked);
  const mine = items.filter((r) => !r.isSystemLocked);
  const auto = mine.filter((r) => r.action !== "ASK_LEADER");
  const ask = mine.filter((r) => r.action === "ASK_LEADER");

  return (
    <>
      <section aria-labelledby="a" className="flex flex-col gap-4">
        <Label id="a" color="var(--sage)">Делаю сама</Label>
        <RuleList leaderId={leader.id} rules={auto} />
      </section>

      <section aria-labelledby="b" className="flex flex-col gap-4">
        <Label id="b" color="var(--amber)">Показываю вам</Label>
        <p className="font-serif text-[26px] leading-[1.7]">
          Всё про деньги выше
          <BudgetLimit leaderId={leader.id} value={settings.budgetAutoLimit} />
          и всё незнакомое я приношу вам с готовым черновиком. Если не уверена, тоже спрашиваю.
        </p>
        {settings.budgetAutoLimit === 0 && <div className="text-sm text-dim">Порог 0 ₽ значит, что любые деньги я согласую только с вами.</div>}
        {ask.length > 0 && <RuleList leaderId={leader.id} rules={ask} />}
      </section>

      <section aria-labelledby="c" className="flex flex-col gap-4 rounded-3xl border border-line-strong bg-sunken p-8">
        <Label id="c" color="var(--coral)">Никогда не решаю одна</Label>
        <p className="font-serif text-[26px] leading-normal">
          Кадры. Письма руководству. Обещания клиентам. Деньги выше порога. Ни правилом, ни словами этого не переключить, даже если вы попросите.
        </p>
        {locked.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm text-soft">
            {locked.map((r) => (
              <li key={r.id}>
                <span className="text-foreground">{r.name}.</span> {r.description}
              </li>
            ))}
          </ul>
        )}
      </section>

      <ProtectedBlocks leaderId={leader.id} blocks={settings.protectedBlocks} />

      <LearnedRules leaderId={leader.id} rules={learned.map((r) => ({ id: r.id, ruleText: r.ruleText }))} />

      <RuleInput leaderId={leader.id} />
    </>
  );
}

export default function RulesPage() {
  return (
    <main className="mx-auto flex w-full max-w-[860px] flex-col gap-14 px-5 pb-24 pt-12 sm:px-10">
      <h1 className="font-serif text-[clamp(34px,5vw,52px)] font-normal leading-[1.1] tracking-[-0.02em]">
        Вот как я с вами работаю. Скажите, если что-то нужно поменять.
      </h1>
      <Suspense fallback={<div className="text-dim">Загружаю правила…</div>}>
        <Rules />
      </Suspense>
    </main>
  );
}
