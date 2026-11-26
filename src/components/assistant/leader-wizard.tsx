"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/** Мастер подключения нового руководителя (только администратор): создаёт пустой профиль, затем он заполняется импортом. */
export function LeaderWizard() {
  const [form, setForm] = useState({ name: "", role: "", email: "" });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/leaders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
      const j = (await res.json().catch(() => ({}))) as { error?: string; slug?: string; name?: string };
      if (res.ok) {
        setNote({ kind: "ok", text: `Создан «${j.name}» (${j.slug}). Привяжите учётную запись в «Управлении» и загрузите профиль импортом.` });
        setForm({ name: "", role: "", email: "" });
      } else setNote({ kind: "error", text: j.error ?? `Ошибка ${res.status}` });
    } catch (err) {
      setNote({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const input = "min-h-11 rounded-full border border-line bg-raised px-5 outline-none placeholder:text-dim";
  return (
    <section aria-labelledby="wiz" className="flex flex-col gap-4">
      <h2 id="wiz" className="font-serif text-2xl font-medium">Подключить ещё одного руководителя</h2>
      <form onSubmit={create} className="grid gap-3 sm:grid-cols-3">
        <input aria-label="Имя и фамилия" required minLength={2} className={input} placeholder="Имя и фамилия" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input aria-label="Должность" required className={input} placeholder="Должность" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} />
        <input aria-label="Почта" required type="email" className={input} placeholder="Почта" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <div className="sm:col-span-3">
          <Button type="submit" variant="outline" className="h-11 rounded-full px-6" disabled={busy}>Создать</Button>
        </div>
      </form>
      {note && (
        <div role={note.kind === "error" ? "alert" : "status"} className={`rounded-[14px] px-3.5 py-2.5 text-[13px] ${note.kind === "error" ? "bg-[#2a1a18] text-coral" : "bg-sunken text-sage"}`}>
          {note.text}
        </div>
      )}
    </section>
  );
}
