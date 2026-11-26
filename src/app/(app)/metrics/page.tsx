import { existsSync, readFileSync } from "node:fs";
import { Suspense } from "react";
import { getToday } from "@/core/dashboard";
import { REPORT_PATH, type InboxEvalReport } from "@/core/eval/inbox";
import { getCostReport } from "@/core/usage";
import { db } from "@/db/client";
import { getCurrentLeader } from "@/lib/current-leader";

const rub = (n: number) => `${n.toLocaleString("ru-RU", { maximumFractionDigits: 4 })} ₽`;

const Stat = ({ label, value, note }: { label: string; value: string; note?: string }) => (
  <div className="flex flex-col gap-1 rounded-[18px] border border-line bg-sunken px-5 py-4">
    <div className="text-[13px] text-dim">{label}</div>
    <div className="font-serif text-[34px] leading-none text-amber">{value}</div>
    {note && <div className="text-sm text-soft">{note}</div>}
  </div>
);

function loadEval(): InboxEvalReport | null {
  if (!existsSync(REPORT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(REPORT_PATH, "utf8")) as InboxEvalReport;
  } catch {
    return null;
  }
}

async function Metrics() {
  const leader = await getCurrentLeader();
  if (!leader) return <p className="text-dim">Руководитель ещё не создан. Запустите <code>npm run db:seed</code>.</p>;
  const [today, cost] = await Promise.all([getToday(db, leader.id), getCostReport(db, leader.id)]);
  const m = today.metrics;
  const ev = loadEval();

  return (
    <>
      <section aria-labelledby="m" className="flex flex-col gap-4">
        <h2 id="m" className="font-serif text-2xl font-medium">За неделю</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Stat label="Освобождено часов" value={`${String(m.savedHours).replace(".", ",")} ч`} />
          <Stat label="Писем без вашего участия" value={`${m.autoEmailsPct}%`} note="Потолок по эталону около 50%: остальное защищено правилами, и это честно." />
          <Stat label="Писем, требующих вас: было → стало" value={`${m.unreadBefore} → ${m.unreadAfter}`} />
          <Stat label="Открытых задач: было → на вас" value={`${m.openTasksMorning.before} → ${m.openTasksMorning.after}`} />
          <Stat label="Задач с первого раза" value={`${m.firstTimeRightPct}%`} note="Без возвратов и переносов." />
          <Stat label="Время до протокола" value={m.avgProtocolMinutes === null ? "—" : `${m.avgProtocolMinutes} мин`} note="От конца встречи до готового протокола." />
          <Stat label="Выучено правил из правок" value={String(m.learnedRules)} />
          <Stat label="Стоимость запроса" value={m.cost.perRequestRub === null ? "—" : rub(m.cost.perRequestRub)} note={`Всего потрачено ${rub(m.cost.totalRub)}.`} />
        </div>
      </section>

      <section aria-labelledby="e" className="flex flex-col gap-4">
        <h2 id="e" className="font-serif text-2xl font-medium">Проверка разбора почты</h2>
        {!ev ? (
          <p className="text-dim">Отчёта ещё нет: он появляется после прогона <code>npm test</code>.</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat label="Точность по эталону" value={`${Math.round(ev.accuracy * 1000) / 10}%`} note={`${ev.correct} из ${ev.rows} писем, порог 95%`} />
              <Stat label="Без руководителя из защищённых" value={String(ev.safetyViolations.length)} note="Должно быть 0." />
              <Stat label="Вызовов модели" value={String(ev.llmCalls + ev.cachedCalls)} note={`${ev.threads} уникальных тредов; из кэша ${ev.cachedCalls}`} />
            </div>
            <p className="text-sm text-dim">
              Модель {ev.model}, прогон {new Date(ev.generatedAt).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}. Повторы одного письма не создали лишних карточек: карточек {ev.decisions}.
            </p>
          </>
        )}
      </section>

      <section aria-labelledby="c" className="flex flex-col gap-4">
        <h2 id="c" className="font-serif text-2xl font-medium">Стоимость по конвейерам</h2>
        {cost.rows.length === 0 ? (
          <p className="text-dim">Пока ни одного вызова модели.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="text-dim">
                <tr>
                  <th className="py-2 pr-4 font-normal">Конвейер</th>
                  <th className="py-2 pr-4 font-normal">Вызовов</th>
                  <th className="py-2 pr-4 font-normal">Из кэша</th>
                  <th className="py-2 pr-4 font-normal">Токены</th>
                  <th className="py-2 pr-4 font-normal">Всего</th>
                  <th className="py-2 font-normal">За вызов</th>
                </tr>
              </thead>
              <tbody>
                {cost.rows.map((r) => (
                  <tr key={`${r.pipeline}-${r.provider}-${r.model}`} className="border-t border-line">
                    <td className="py-2 pr-4">{r.pipeline}</td>
                    <td className="py-2 pr-4">{r.calls}</td>
                    <td className="py-2 pr-4">{r.cachedCalls}</td>
                    <td className="py-2 pr-4">{(r.promptTokens + r.completionTokens).toLocaleString("ru-RU")}</td>
                    <td className="py-2 pr-4">{rub(r.costRub)}</td>
                    <td className="py-2">{r.avgCostRub === null ? "—" : rub(r.avgCostRub)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <a href={`/api/usage?format=csv&leaderId=${encodeURIComponent(leader.id)}`} className="text-sm text-amber underline-offset-4 hover:underline">Скачать расчёт стоимости (CSV)</a>
      </section>
    </>
  );
}

export default function MetricsPage() {
  return (
    <main className="mx-auto flex w-full max-w-[860px] flex-col gap-14 px-5 pb-24 pt-12 sm:px-10">
      <h1 className="font-serif text-[clamp(34px,5vw,52px)] font-normal leading-[1.1] tracking-[-0.02em]">Метрики: что я сделала и сколько это стоит.</h1>
      <Suspense fallback={<div className="text-dim">Считаю метрики…</div>}>
        <Metrics />
      </Suspense>
    </main>
  );
}
