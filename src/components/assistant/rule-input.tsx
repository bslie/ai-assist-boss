"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

interface Understood {
  summary: string;
}

/** Правила словами: текст → черновик правила → «Запомнить / Только на неделю / Не надо». POST /api/rules/parse. */
export function RuleInput({ leaderId }: { leaderId: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [understood, setUnderstood] = useState<(Understood & { text: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const url = `/api/rules/parse?leaderId=${encodeURIComponent(leaderId)}`;

  async function call(body: object) {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { res, json: (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string; proposal?: { summary: string }; saved?: boolean } };
  }

  async function understand() {
    const t = text.trim();
    if (t.length < 3 || busy) return;
    setBusy(true);
    setNote(null);
    setUnderstood(null);
    try {
      const { res, json } = await call({ text: t });
      if (!res.ok) setNote({ kind: "error", text: json.error ?? `Ошибка ${res.status}` });
      else if (!json.ok || !json.proposal) setNote({ kind: "error", text: json.message ?? "Не поняла, переформулируйте." });
      else setUnderstood({ summary: json.proposal.summary, text: t });
    } catch (e) {
      setNote({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function confirm(kind: "save" | "week") {
    if (!understood || busy) return;
    setBusy(true);
    try {
      const { res, json } = await call({ text: understood.text, confirm: kind });
      if (res.ok && json.saved) {
        setNote({ kind: "ok", text: kind === "week" ? "Запомнила на неделю." : "Запомнила." });
        setUnderstood(null);
        setText("");
        router.refresh();
      } else setNote({ kind: "error", text: json.error ?? json.message ?? `Ошибка ${res.status}` });
    } catch (e) {
      setNote({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="d" className="flex flex-col gap-3.5">
      <h2 id="d" className="font-serif text-2xl font-medium">Хотите добавить правило? Просто скажите.</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void understand();
        }}
        className="flex items-center gap-2 rounded-full border border-line-strong bg-raised py-1.5 pl-[22px] pr-1.5"
      >
        <label htmlFor="nr" className="sr-only">Правило словами</label>
        <input
          id="nr"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Например: письма от Орлова присылай сразу"
          className="min-h-11 min-w-0 flex-1 bg-transparent outline-none placeholder:text-dim"
        />
        <Button type="submit" disabled={busy} className="h-11 rounded-full bg-amber px-[22px] font-semibold text-[#1b1305] hover:bg-amber/90">Понять</Button>
      </form>
      {understood && (
        <div className="flex flex-col gap-3 rounded-[18px] border border-line bg-sunken px-5 py-[18px]">
          <div className="text-xs text-dim">Я поняла так</div>
          <div className="font-serif text-[19px]">{understood.summary}</div>
          <div className="flex flex-wrap gap-2.5">
            <Button className="h-11 rounded-full px-5 font-semibold" disabled={busy} onClick={() => confirm("save")}>Запомнить</Button>
            <Button variant="outline" className="h-11 rounded-full px-5" disabled={busy} onClick={() => confirm("week")}>Только на неделю</Button>
            <Button variant="ghost" className="h-11 rounded-full px-5 text-dim" disabled={busy} onClick={() => setUnderstood(null)}>Не надо</Button>
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
