"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

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
  const [cron, setCron] = useState<Record<string, string>>({});

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
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const v = (cron[r.id] ?? r.cron).trim();
                if (v !== r.cron) void patch({ id: r.id, cronExpression: v });
              }}
            >
              <label htmlFor={`c-${r.id}`} className="text-sm text-dim">Расписание (cron, демо-время)</label>
              <input id={`c-${r.id}`} value={cron[r.id] ?? r.cron} onChange={(e) => setCron({ ...cron, [r.id]: e.target.value })} className="min-h-11 w-44 rounded-full border border-line bg-raised px-4 font-mono text-sm outline-none" />
              <button type="submit" className="min-h-11 rounded-full border border-line px-5 text-sm hover:bg-raised">Сохранить</button>
            </form>
          </li>
        ))}
      </ul>
      {error && <div role="alert" className="rounded-[14px] bg-[#2a1a18] px-3.5 py-2.5 text-[13px] text-coral">{error}</div>}
    </>
  );
}
