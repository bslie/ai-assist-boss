"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { TaskRow } from "@/core/tasks/registry";

const STATUS: Record<string, string> = {
  NEW: "Новая",
  ACCEPTED: "Принята",
  IN_PROGRESS: "В работе",
  REVIEW: "На проверке",
  RETURNED: "Возвращена",
  READY_FOR_LEADER: "Ждёт вашей приёмки",
  DONE: "Готово",
  ESCALATED: "Эскалация",
};

const fmt = (iso: string) =>
  new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

export function TaskList({ tasks }: { tasks: TaskRow[] }) {
  if (tasks.length === 0) return <p className="text-dim">Поручений пока нет.</p>;
  return (
    <ul className="flex flex-col gap-3">
      {tasks.map((t) => (
        <li key={t.id} className="flex flex-col gap-1 rounded-[18px] border border-line bg-sunken px-5 py-4">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span className="font-serif text-[19px]">{t.title}</span>
            <span className={`text-sm ${t.overdue ? "text-coral" : t.status === "DONE" ? "text-sage" : "text-dim"}`}>
              {t.overdue ? "Просрочено" : STATUS[t.status] ?? t.status}
            </span>
          </div>
          <div className="text-sm text-soft">
            {t.assignee ?? "Вы сами"}, срок {fmt(t.dueAt)}
            {t.rescheduleCount > 0 ? `, переносов: ${t.rescheduleCount}` : ""}
            {t.returnCount > 0 ? `, возвратов: ${t.returnCount}` : ""}
            {t.isClientCommitment ? ", обязательство клиенту" : ""}
          </div>
          <div className="text-sm text-dim">Критерий: {t.acceptanceCriteria}</div>
        </li>
      ))}
    </ul>
  );
}

/** Новое поручение: исполнитель получит его в Telegram через Policy Gate. */
export function NewTask({ leaderId, people }: { leaderId: string; people: { id: string; name: string; position: string }[] }) {
  const router = useRouter();
  const [form, setForm] = useState({ title: "", description: "", assigneeId: people[0]?.id ?? "", dueAt: "", isClientCommitment: false });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/tasks?leaderId=${encodeURIComponent(leaderId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // дата из поля — московское время
        body: JSON.stringify({ ...form, dueAt: new Date(`${form.dueAt}:00+03:00`).toISOString() }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) {
        setNote({ kind: "ok", text: "Поручение создано. Исполнитель получит его в Telegram." });
        setForm({ ...form, title: "", description: "", dueAt: "" });
        router.refresh();
      } else setNote({ kind: "error", text: j.error ?? `Ошибка ${res.status}` });
    } catch (err) {
      setNote({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const input = "min-h-11 rounded-full border border-line bg-raised px-5 outline-none placeholder:text-dim";
  return (
    <section aria-labelledby="nt" className="flex flex-col gap-4">
      <h2 id="nt" className="font-serif text-2xl font-medium">Новое поручение</h2>
      <form onSubmit={create} className="grid gap-3 sm:grid-cols-2">
        <input aria-label="Что нужно сделать" required minLength={3} className={`${input} sm:col-span-2`} placeholder="Что нужно сделать" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <textarea aria-label="Подробности" className="min-h-24 rounded-[18px] border border-line bg-raised p-4 outline-none placeholder:text-dim sm:col-span-2" placeholder="Подробности (по желанию): критерий готовности сформулирую сама" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <select aria-label="Исполнитель" required className={input} value={form.assigneeId} onChange={(e) => setForm({ ...form, assigneeId: e.target.value })}>
          {people.map((p) => (
            <option key={p.id} value={p.id}>{p.name}, {p.position}</option>
          ))}
        </select>
        <input aria-label="Срок" required type="datetime-local" className={input} value={form.dueAt} onChange={(e) => setForm({ ...form, dueAt: e.target.value })} />
        <label className="flex min-h-11 items-center gap-2 text-soft sm:col-span-2">
          <input type="checkbox" checked={form.isClientCommitment} onChange={(e) => setForm({ ...form, isClientCommitment: e.target.checked })} />
          Обязательство перед клиентом (перенос срока только с вашего согласия)
        </label>
        <div className="sm:col-span-2">
          <Button type="submit" className="h-11 rounded-full bg-amber px-6 font-semibold text-[#1b1305] hover:bg-amber/90" disabled={busy}>Поставить задачу</Button>
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
