"use client";

import { useState } from "react";
import type { TaskLinkAnswer, TaskLinkView } from "@/core/tasks/email-link";
import { cn } from "@/lib/utils";

const TZ = "Europe/Moscow";
const fmt = (iso: string) =>
  new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, weekday: "short", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const ymd = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(iso));

const STATUS: Record<string, string> = {
  NEW: "Ждёт вашего ответа",
  ACCEPTED: "Принята в работу",
  IN_PROGRESS: "В работе",
  REVIEW: "Результат на проверке",
  RETURNED: "Возвращена на доработку",
  READY_FOR_LEADER: "Ждёт приёмки руководителем",
  DONE: "Закрыта",
  ESCALATED: "У руководителя",
};

const INPUT = "w-full rounded-xl border border-line-strong bg-ink px-3 py-2.5 text-[15px] outline-none focus:border-amber";

type Mode = null | "clarify" | "reschedule";

/** Карточка поручения: «Принял» — главное действие, «Уточнить» и «Не успею» раскрывают короткую форму. */
export function TaskAnswer({ token, view }: { token: string; view: TaskLinkView }) {
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [date, setDate] = useState(ymd(view.dueAt));
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState(view.status);
  const isNew = status === "NEW";
  const closed = status === "DONE" || status === "ESCALATED";

  async function send(body: TaskLinkAnswer) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/t/${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      if (res.ok) {
        setDone(j.message ?? "Готово.");
        if (body.action === "accept" && status === "NEW") setStatus("ACCEPTED");
      }
      else setError(j.error ?? `Не получилось (${res.status})`);
    } catch {
      setError("Нет связи с сервером. Попробуйте ещё раз.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="flex flex-col gap-5 rounded-3xl border border-line bg-sunken/70 p-5 sm:p-7">
      <header className="flex items-center gap-3">
        <svg width="36" height="36" viewBox="0 0 32 32" fill="none" aria-hidden="true" className="shrink-0">
          <circle cx="16" cy="16" r="15" stroke="var(--amber)" strokeWidth="1.5" />
          <circle cx="16" cy="16" r="9" stroke="var(--amber)" strokeWidth="1.5" opacity="0.6" />
          <circle cx="16" cy="16" r="3.5" fill="var(--amber)" />
        </svg>
        <div className="min-w-0 text-sm leading-snug">
          <div className="font-medium">ИИ-помощник {view.leaderName}</div>
          <div className="text-dim">Исполнитель: {view.assigneeName}</div>
        </div>
      </header>

      <div className="flex flex-col gap-1.5">
        <span className={cn("w-fit rounded-full px-2.5 py-0.5 text-xs", isNew ? "bg-amber/15 text-amber" : "bg-raised text-soft")}>{STATUS[status] ?? status}</span>
        <h1 className="font-serif text-[26px] font-normal leading-tight tracking-[-0.01em]">{view.title}</h1>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[15px]">
        <dt className="text-dim">Срок</dt>
        <dd>{fmt(view.dueAt)}</dd>
        <dt className="text-dim">Готово, когда</dt>
        <dd className="text-soft">{view.criteria}</dd>
      </dl>

      {done ? (
        <p role="status" className="flex items-start gap-2 rounded-2xl border border-line bg-ink px-4 py-3 text-[15px]">
          <span className="mt-2 size-2 shrink-0 rounded-full bg-sage" />
          {done}
        </p>
      ) : closed ? (
        <p className="text-soft">По этой задаче ответ уже не нужен.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {isNew && mode === null && (
            <button type="button" disabled={busy} onClick={() => send({ action: "accept" })} className="min-h-12 rounded-full bg-amber text-[15px] font-semibold text-[#1b1305] transition-transform enabled:hover:scale-[1.01] enabled:active:scale-[0.99] disabled:opacity-60">
              Принял
            </button>
          )}
          <div className="grid grid-cols-2 gap-2">
            {(["clarify", "reschedule"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-expanded={mode === m}
                onClick={() => setMode(mode === m ? null : m)}
                className={cn("min-h-11 rounded-full border text-[14px] transition-colors", mode === m ? "border-amber text-foreground" : "border-line-strong text-soft hover:text-foreground")}
              >
                {m === "clarify" ? "Уточнить" : "Не успею"}
              </button>
            ))}
          </div>

          {mode === "clarify" && (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void send({ action: "clarify", question });
              }}
            >
              <label htmlFor="q" className="text-sm text-dim">Вопрос руководителю</label>
              <textarea id="q" rows={3} required minLength={3} value={question} onChange={(e) => setQuestion(e.target.value)} className={INPUT} placeholder="Что нужно уточнить?" />
              <button type="submit" disabled={busy} className="min-h-11 rounded-full bg-raised text-[14px] font-medium transition-colors hover:bg-line-strong disabled:opacity-60">
                Отправить вопрос
              </button>
            </form>
          )}

          {mode === "reschedule" && (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void send({ action: "reschedule", date, reason });
              }}
            >
              <label htmlFor="d" className="text-sm text-dim">Успею к (до 18:00 этого дня)</label>
              <input id="d" type="date" required min={ymd(view.dueAt)} value={date} onChange={(e) => setDate(e.target.value)} className={INPUT} />
              <label htmlFor="r" className="text-sm text-dim">Причина</label>
              <input id="r" required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} className={INPUT} placeholder="Например, жду данные от клиента" />
              <button type="submit" disabled={busy} className="min-h-11 rounded-full bg-raised text-[14px] font-medium transition-colors hover:bg-line-strong disabled:opacity-60">
                Попросить перенос
              </button>
              <p className="text-xs text-dim">Небольшой перенос я согласую сама, остальное передам руководителю.</p>
            </form>
          )}
          {error && <p role="alert" className="text-sm text-coral">{error}</p>}
        </div>
      )}
    </article>
  );
}
