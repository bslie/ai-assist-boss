"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { DAY_LABELS, INTERVAL_OPTIONS, type Schedule, buildCron, parseSchedule } from "@/core/routine-schedule";

export interface RoutineItem {
  id: string;
  title: string;
  schedule: string;
  cron: string;
  instruction: string;
  isActive: boolean;
  lastRunAt: string | null;
}

const fmt = (iso: string) =>
  new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

/** Рутины: включить, выключить, поменять расписание. PATCH /api/routines. */
export function RoutineList({ leaderId, routines }: { leaderId: string; routines: RoutineItem[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Schedule>>({});

  async function patch(body: object) {
    const res = await fetch(`/api/routines?leaderId=${encodeURIComponent(leaderId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) setError(null);
    else setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Ошибка ${res.status}`);
    router.refresh();
  }

  if (routines.length === 0) return <p className="text-dim">Рутин нет: они приходят из профиля.</p>;
  return (
    <>
      <ul className="flex flex-col gap-3">
        {routines.map((r) => (
          <li key={r.id} className="flex flex-col gap-2 rounded-[18px] border border-line bg-sunken px-5 py-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="min-w-0 flex-[1_1_240px] font-serif text-[19px]">{r.title}</span>
              <label className="flex min-h-11 items-center gap-2 text-soft">
                <input type="checkbox" checked={r.isActive} onChange={(e) => patch({ id: r.id, isActive: e.target.checked })} />
                {r.isActive ? "Включена" : "Выключена"}
              </label>
            </div>
            <div className="text-sm text-soft">Сейчас: {r.schedule}. {r.lastRunAt ? `Последний запуск: ${fmt(r.lastRunAt)}.` : "Ещё не запускалась."}</div>
            <div className="text-sm text-dim">{r.instruction}</div>
            <ScheduleEditor
              id={r.id}
              draft={drafts[r.id] ?? parseSchedule(r.cron) ?? { kind: "daily", days: [1, 2, 3, 4, 5], time: "09:00" }}
              onChange={(d) => setDrafts({ ...drafts, [r.id]: d })}
              changed={drafts[r.id] !== undefined && buildCron(drafts[r.id]) !== r.cron}
              onSave={() => {
                const c = buildCron(drafts[r.id]);
                if (c && c !== r.cron) void patch({ id: r.id, cronExpression: c });
              }}
            />

          </li>
        ))}
      </ul>
      {error && <div role="alert" className="rounded-[14px] bg-[#2a1a18] px-3.5 py-2.5 text-[13px] text-coral">{error}</div>}
    </>
  );
}

const field = "min-h-11 rounded-full border border-line bg-raised px-4 text-sm outline-none";
const presets: { label: string; days: number[] }[] = [
  { label: "Будни", days: [1, 2, 3, 4, 5] },
  { label: "Каждый день", days: [1, 2, 3, 4, 5, 6, 7] },
];

/** Расписание без cron: «через равные промежутки» или «в определённое время по дням недели». */
function ScheduleEditor({ id, draft, onChange, changed, onSave }: { id: string; draft: Schedule; onChange: (d: Schedule) => void; changed: boolean; onSave: () => void }) {
  const valid = buildCron(draft) !== null;
  const toggleDay = (d: number) => {
    if (draft.kind !== "daily") return;
    const days = draft.days.includes(d) ? draft.days.filter((x) => x !== d) : [...draft.days, d].sort((a, b) => a - b);
    onChange({ ...draft, days });
  };
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && changed) onSave();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`k-${id}`} className="text-sm text-dim">Как часто</label>
        <select
          id={`k-${id}`}
          className={field}
          value={draft.kind}
          onChange={(e) => onChange(e.target.value === "interval" ? { kind: "interval", everyMinutes: 30 } : { kind: "daily", days: [1, 2, 3, 4, 5], time: "09:00" })}
        >
          <option value="interval">Через равные промежутки</option>
          <option value="daily">В определённое время</option>
        </select>
        {draft.kind === "interval" && (
          <select aria-label="Промежуток" className={field} value={draft.everyMinutes} onChange={(e) => onChange({ kind: "interval", everyMinutes: Number(e.target.value) })}>
            {!INTERVAL_OPTIONS.some((o) => o.minutes === draft.everyMinutes) && <option value={draft.everyMinutes}>каждые {draft.everyMinutes} мин</option>}
            {INTERVAL_OPTIONS.map((o) => <option key={o.minutes} value={o.minutes}>{o.label}</option>)}
          </select>
        )}
        {draft.kind === "daily" && (
          <>
            <label htmlFor={`t-${id}`} className="text-sm text-dim">в</label>
            <input id={`t-${id}`} type="time" required value={draft.time} onChange={(e) => onChange({ ...draft, time: e.target.value })} className={field} />
          </>
        )}
      </div>
      {draft.kind === "daily" && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Дни недели">
          {DAY_LABELS.map((label, i) => (
            <button
              key={label}
              type="button"
              aria-pressed={draft.days.includes(i + 1)}
              onClick={() => toggleDay(i + 1)}
              className={`min-h-11 min-w-11 rounded-full border px-3 text-sm ${draft.days.includes(i + 1) ? "border-line-strong bg-raised text-foreground" : "border-line text-dim hover:bg-raised"}`}
            >
              {label}
            </button>
          ))}
          {presets.map((p) => (
            <button key={p.label} type="button" onClick={() => onChange({ ...draft, days: p.days })} className="min-h-11 px-2 text-sm text-dim underline-offset-4 hover:underline">
              {p.label}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={!valid || !changed} className="min-h-11 rounded-full border border-line px-5 text-sm hover:bg-raised disabled:opacity-40">Сохранить</button>
        {!valid && <span className="text-sm text-coral">Выберите хотя бы один день</span>}
      </div>
    </form>
  );
}
