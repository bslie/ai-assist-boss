"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export interface LearnedItem {
  id: string;
  ruleText: string;
}

/** Выученные из правок правила с кнопкой «Забыть» (DELETE /api/memory). */
export function LearnedRules({ leaderId, rules }: { leaderId: string; rules: LearnedItem[] }) {
  const router = useRouter();
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visible = rules.filter((r) => !gone.has(r.id));

  async function forget(id: string) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/memory?leaderId=${encodeURIComponent(leaderId)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok && res.status !== 404) throw new Error(`Ошибка ${res.status}`);
      setGone((s) => new Set(s).add(id));
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="learned" className="flex flex-col gap-4">
      <h2 id="learned" className="font-serif text-2xl font-medium">Чему я научилась на ваших правках</h2>
      {visible.length === 0 ? (
        <p className="text-dim">Пока ничего. Когда вы поправите мой черновик, я предложу запомнить вашу манеру.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {visible.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-[18px] border border-line bg-sunken px-5 py-4">
              <span className="min-w-0 flex-[1_1_280px] font-serif text-[19px]">{r.ruleText}</span>
              <Button variant="ghost" className="h-11 rounded-full px-4 text-dim" disabled={busy === r.id} onClick={() => forget(r.id)}>
                Забыть
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && <div role="alert" className="rounded-[14px] bg-[#2a1a18] px-3.5 py-2.5 text-[13px] text-coral">{error}</div>}
      <p className="text-sm text-dim">Эти правила меняют только манеру моих черновиков. Что нельзя решать без вас, они не затрагивают.</p>
    </section>
  );
}
