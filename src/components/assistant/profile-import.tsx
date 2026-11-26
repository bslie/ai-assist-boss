"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

interface Diff {
  goals: { added: string[]; removed: string[] };
  rules: { added: string[]; removed: string[] };
  routines: { added: string[]; removed: string[] };
  budgetAutoLimit: { from: number; to: number } | null;
  profileVersion: { from: number; to: number };
}
interface Preview {
  draftId: string;
  diff: Diff;
  warnings: { rule: string; message: string }[];
}

const money = (n: number) => `${n.toLocaleString("ru-RU")} ₽`;

function Lines({ title, added, removed }: { title: string; added: string[]; removed: string[] }) {
  if (added.length === 0 && removed.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs text-dim">{title}</div>
      {added.map((x) => (
        <div key={`+${x}`} className="text-sage">+ {x}</div>
      ))}
      {removed.map((x) => (
        <div key={`-${x}`} className="text-coral">− {x}</div>
      ))}
    </div>
  );
}

/** Импорт профиля: markdown → черновик и diff → подтверждение → запись (SPEC 4.6, 6). */
export function ProfileImport({ leaderId, initial }: { leaderId: string; initial: string }) {
  const router = useRouter();
  const [markdown, setMarkdown] = useState(initial);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const url = `/api/leaders/import?leaderId=${encodeURIComponent(leaderId)}`;

  async function post(body: object) {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { res, json: (await res.json().catch(() => ({}))) as Partial<Preview> & { error?: string; applied?: boolean } };
  }

  async function showDiff() {
    setBusy(true);
    setNote(null);
    setPreview(null);
    try {
      const { res, json } = await post({ markdown });
      if (!res.ok || !json.draftId || !json.diff) setNote({ kind: "error", text: json.error ?? `Ошибка ${res.status}` });
      else setPreview({ draftId: json.draftId, diff: json.diff, warnings: json.warnings ?? [] });
    } catch (e) {
      setNote({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!preview) return;
    setBusy(true);
    try {
      const { res, json } = await post({ confirm: true, draftId: preview.draftId });
      if (res.ok && json.applied) {
        setNote({ kind: "ok", text: `Профиль обновлён, версия ${preview.diff.profileVersion.to}.` });
        setPreview(null);
        router.refresh();
      } else setNote({ kind: "error", text: json.error ?? `Ошибка ${res.status}` });
    } catch (e) {
      setNote({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const d = preview?.diff;
  const nothing = d && !d.goals.added.length && !d.goals.removed.length && !d.rules.added.length && !d.rules.removed.length && !d.routines.added.length && !d.routines.removed.length && !d.budgetAutoLimit;

  return (
    <section aria-labelledby="imp" className="flex flex-col gap-4">
      <h2 id="imp" className="font-serif text-2xl font-medium">Изменить профиль</h2>
      <p className="text-sm text-dim">
        Цели, правила, ритм и порог по деньгам берутся из текста. Поменяйте его и нажмите «Показать изменения»: я покажу, что поменяется, и запишу только после вашего согласия.
      </p>
      <label htmlFor="md" className="sr-only">Профиль руководителя, markdown</label>
      <textarea
        id="md"
        value={markdown}
        onChange={(e) => setMarkdown(e.target.value)}
        rows={14}
        className="w-full rounded-[18px] border border-line bg-sunken p-4 font-mono text-[13px] leading-relaxed outline-none"
      />
      <div>
        <Button className="h-11 rounded-full bg-amber px-6 font-semibold text-[#1b1305] hover:bg-amber/90" disabled={busy || markdown.trim().length < 20} onClick={showDiff}>
          Показать изменения
        </Button>
      </div>

      {preview && d && (
        <div className="flex flex-col gap-4 rounded-[18px] border border-line bg-sunken px-5 py-[18px]">
          <div className="text-xs text-dim">Что изменится (версия {d.profileVersion.from} → {d.profileVersion.to})</div>
          <Lines title="Цели квартала" {...d.goals} />
          <Lines title="Правила" {...d.rules} />
          <Lines title="Рутины" {...d.routines} />
          {d.budgetAutoLimit && (
            <div className="flex flex-col gap-1">
              <div className="text-xs text-dim">Порог по деньгам</div>
              <div>{money(d.budgetAutoLimit.from)} → {money(d.budgetAutoLimit.to)}</div>
            </div>
          )}
          {nothing && <div className="text-soft">Отличий от текущего профиля нет.</div>}
          {preview.warnings.map((w) => (
            <div key={w.rule} role="alert" className="rounded-[14px] bg-[#2a1a18] px-3.5 py-2.5 text-[13px] text-coral">
              «{w.rule}»: {w.message}
            </div>
          ))}
          <div className="flex flex-wrap gap-2.5">
            <Button className="h-11 rounded-full px-5 font-semibold" disabled={busy} onClick={apply}>Применить</Button>
            <Button variant="ghost" className="h-11 rounded-full px-5 text-dim" disabled={busy} onClick={() => setPreview(null)}>Отмена</Button>
          </div>
        </div>
      )}
      {note && (
        <div role={note.kind === "error" ? "alert" : "status"} className={`rounded-[14px] px-3.5 py-2.5 text-[13px] ${note.kind === "error" ? "bg-[#2a1a18] text-coral" : "bg-sunken text-sage"}`}>
          {note.text}
        </div>
      )}
    </section>
  );
}
