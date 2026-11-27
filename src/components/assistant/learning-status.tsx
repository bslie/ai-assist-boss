"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ShieldCheck } from "lucide-react";
import type { LearningStatus as Status } from "@/core/learning/mode";
import { cn } from "@/lib/utils";
import { Switch } from "./switch";

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

/**
 * Статус режима обучения в «Разговоре» (SPEC 1.1, п. 4): строка-статус всегда на виду,
 * по нажатию — пояснение, выключатель режима и вопросы «такие решать без вас?».
 */
export function LearningStatus({ leaderId, status }: { leaderId: string; status: Status }) {
  const router = useRouter();
  const [open, setOpen] = useState(status.suggestions.length > 0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [later, setLater] = useState<string[]>([]);
  const suggestions = status.suggestions.filter((s) => !later.includes(s.scope));

  async function patch(body: object) {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/learning?leaderId=${encodeURIComponent(leaderId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      setNote(data.message ?? data.error ?? (res.ok ? "Готово." : "Не получилось."));
      setConfirmOff(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const { clean, resolved } = status;
  const score = resolved > 0 ? `${clean} из ${resolved} ${plural(resolved, "решения", "решений", "решений")} без правок` : "решений пока не было";

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-h-9 w-fit max-w-full items-center gap-2 rounded-full border border-line bg-sunken px-3.5 text-left text-[13px] text-soft transition-colors hover:border-line-strong hover:text-foreground"
      >
        <span className={cn("size-2 shrink-0 rounded-full", status.learningMode ? "pulse-dot bg-amber" : "bg-sage")} />
        <span className="truncate">
          {status.learningMode ? (
            <>
              Учусь<span className="hidden sm:inline">. Сама ничего не отправляю</span>
            </>
          ) : (
            "Работаю по вашим правилам"
          )}{" "}
          · {score}
        </span>
        {suggestions.length > 0 && <span className="shrink-0 rounded-full bg-amber px-1.5 text-[11px] font-semibold text-[#1b1305]">{suggestions.length}</span>}
        <ChevronDown size={14} className={cn("shrink-0 transition-transform duration-200", open && "rotate-180")} />
      </button>

      {open && (
        <section aria-label="Режим обучения" className="flex flex-col gap-3 rounded-2xl border border-line bg-sunken/70 p-4">
          <div className="flex items-start gap-3">
            <ShieldCheck size={20} className="mt-0.5 shrink-0 text-amber" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">Режим обучения</div>
              <p className="mt-0.5 text-sm text-soft">
                Пока он включён, ответы, поручения и любые действия в почте и календаре уходят только после вашего «да». Я смотрю, что вы принимаете без правок, и предлагаю отпустить такие решения. Кадры, руководство, обещания клиентам и деньги выше порога я всегда согласую с вами.
              </p>
            </div>
            <Switch
              checked={status.learningMode}
              disabled={busy}
              label="Режим обучения"
              onChange={(v) => (v ? patch({ kind: "mode", enabled: true }) : setConfirmOff(true))}
            />
          </div>

          {confirmOff && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line-strong bg-ink px-3 py-2.5 text-sm">
              <span className="min-w-0 flex-1">Выключить? Дальше буду действовать по правилам и правам подключений без вашего «да».</span>
              <button type="button" disabled={busy} onClick={() => patch({ kind: "mode", enabled: false })} className="min-h-9 rounded-full bg-amber px-3.5 font-semibold text-[#1b1305]">
                Выключить
              </button>
              <button type="button" onClick={() => setConfirmOff(false)} className="min-h-9 rounded-full px-3 text-dim hover:text-foreground">
                Отмена
              </button>
            </div>
          )}

          {suggestions.map((s) => (
            <div key={s.scope} className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-ink px-3 py-2.5 text-sm">
              <span className="min-w-0 flex-1">
                <b className="font-medium">{s.label}</b>: {s.streak} {plural(s.streak, "раз", "раза", "раз")} подряд вы приняли мой вариант без правок. Решать такие без вас?
              </span>
              <button type="button" disabled={busy} onClick={() => patch({ kind: "trust", scope: s.scope, trusted: true })} className="min-h-9 rounded-full bg-amber px-3.5 font-semibold text-[#1b1305]">
                Да
              </button>
              <button type="button" onClick={() => setLater([...later, s.scope])} className="min-h-9 rounded-full px-3 text-dim hover:text-foreground">
                Позже
              </button>
            </div>
          ))}

          {status.trusted.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-dim">Решаю сама</div>
              <div className="flex flex-wrap gap-2">
                {status.trusted.map((t) => (
                  <span key={t.scope} className="flex min-h-9 items-center gap-2 rounded-full border border-line bg-ink pl-3.5 pr-1 text-[13px]">
                    {t.label}
                    <button type="button" disabled={busy} onClick={() => patch({ kind: "trust", scope: t.scope, trusted: false })} className="min-h-7 rounded-full px-2.5 text-dim hover:bg-raised hover:text-foreground">
                      Вернуть мне
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          {note && <p role="status" className="text-sm text-soft">{note}</p>}
        </section>
      )}
    </div>
  );
}
