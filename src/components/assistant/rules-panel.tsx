"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

const ACTIONS: { value: string; label: string }[] = [
  { value: "ASK_LEADER", label: "Показываю вам" },
  { value: "DIGEST", label: "В сводку" },
  { value: "DELEGATE", label: "Передаю ответственному" },
  { value: "IGNORE", label: "В архив" },
  { value: "AUTO", label: "Делаю сама" },
];

export interface RuleItem {
  id: string;
  name: string;
  description: string;
  action: string;
  category: string | null;
  senderEmail: string | null;
  isSystemLocked: boolean;
  /** Категория защищена: действие можно только оставить «Показываю вам». */
  locked: boolean;
  expiresAt: string | null;
}

async function patch(leaderId: string, body: unknown): Promise<string | null> {
  const res = await fetch(`/api/rules?leaderId=${encodeURIComponent(leaderId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return null;
  const j = (await res.json().catch(() => ({}))) as { error?: string };
  return j.error ?? `Ошибка ${res.status}`;
}

const Alert = ({ children }: { children: React.ReactNode }) => (
  <div role="alert" className="rounded-[14px] bg-[#2a1a18] px-3.5 py-2.5 text-[13px] text-coral">{children}</div>
);

/** Порог по деньгам: рублей. 0 — всегда спрашивать. PATCH /api/rules { kind: "settings" }. */
export function BudgetLimit({ leaderId, value }: { leaderId: string; value: number }) {
  const router = useRouter();
  const [text, setText] = useState(String(value));
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const n = Number(text.replace(/\s/g, ""));
    if (!Number.isFinite(n) || n < 0) {
      setError("Порог — число не меньше нуля");
      setText(String(value));
      return;
    }
    if (n === value) return;
    setError(await patch(leaderId, { kind: "settings", budgetAutoLimit: n }));
    router.refresh();
  }

  return (
    <>
      <span className="mx-2 inline-flex items-center gap-1.5 rounded-full bg-amber py-0 pl-3.5 pr-1.5 font-sans text-xl font-semibold text-[#1b1305]">
        <label htmlFor="lim" className="sr-only">Порог по деньгам, рублей</label>
        <input
          id="lim"
          inputMode="numeric"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className="min-h-9 w-20 bg-transparent text-right outline-none"
        />
        <span className="pr-2.5">₽</span>
      </span>
      {error && <Alert>{error}</Alert>}
    </>
  );
}

/** Защищённые блоки календаря: на них я не ставлю встречи без вас. */
export function ProtectedBlocks({ leaderId, blocks }: { leaderId: string; blocks: string[] }) {
  const router = useRouter();
  const [list, setList] = useState(blocks);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function save(next: string[]) {
    setError(await patch(leaderId, { kind: "settings", protectedBlocks: next }));
    setList(next);
    router.refresh();
  }

  return (
    <section aria-labelledby="blocks" className="flex flex-col gap-3.5">
      <h2 id="blocks" className="font-serif text-2xl font-medium">Время, которое я берегу для вас</h2>
      <div className="flex flex-wrap gap-2">
        {list.length === 0 && <span className="text-dim">Защищённых блоков нет.</span>}
        {list.map((b) => (
          <span key={b} className="flex min-h-11 items-center gap-2 rounded-full border border-line bg-sunken pl-4 pr-1.5">
            {b}
            <button aria-label={`Убрать «${b}»`} className="size-8 rounded-full text-dim hover:text-foreground" onClick={() => save(list.filter((x) => x !== b))}>×</button>
          </span>
        ))}
      </div>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const v = text.trim();
          if (v && !list.includes(v)) save([...list, v]);
          setText("");
        }}
      >
        <label htmlFor="blk" className="sr-only">Новый защищённый блок</label>
        <input id="blk" value={text} onChange={(e) => setText(e.target.value)} placeholder="Название встречи, например «Стратегия»" className="min-h-11 min-w-0 flex-1 rounded-full border border-line bg-raised px-5 outline-none placeholder:text-dim" />
        <Button type="submit" variant="outline" className="h-11 rounded-full px-5">Добавить</Button>
      </form>
      {error && <Alert>{error}</Alert>}
    </section>
  );
}

/** Правила писем: действие можно сменить, кроме защищённых (кадры, деньги, руководство, обязательства клиентам). */
export function RuleList({ leaderId, rules }: { leaderId: string; rules: RuleItem[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function change(id: string, action: string) {
    setBusy(id);
    setError(await patch(leaderId, { kind: "rule", id, patch: { action } }));
    setBusy(null);
    router.refresh();
  }

  if (rules.length === 0) return <p className="text-dim">Правил пока нет: скажите мне, как поступать с письмами.</p>;
  return (
    <>
      <ul className="flex flex-col gap-3">
        {rules.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-[18px] border border-line bg-sunken px-5 py-4">
            <div className="min-w-0 flex-[1_1_280px]">
              <div className="font-serif text-[19px]">{r.name}</div>
              <div className="text-sm text-dim">
                {r.description}
                {r.expiresAt ? ` Действует до ${new Date(r.expiresAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "Europe/Moscow" })}.` : ""}
              </div>
            </div>
            {r.isSystemLocked ? (
              <span className="rounded-full border border-line-strong px-4 py-2 text-sm text-coral">Нельзя изменить</span>
            ) : (
              <select
                aria-label={`Действие для правила «${r.name}»`}
                value={r.action}
                disabled={busy === r.id}
                onChange={(e) => change(r.id, e.target.value)}
                className="min-h-11 rounded-full border border-line bg-raised px-4"
              >
                {ACTIONS.filter((a) => !r.locked || a.value === "ASK_LEADER").map((a) => (
                  <option key={a.value} value={a.value}>{a.label}</option>
                ))}
              </select>
            )}
          </li>
        ))}
      </ul>
      {error && <Alert>{error}</Alert>}
    </>
  );
}
