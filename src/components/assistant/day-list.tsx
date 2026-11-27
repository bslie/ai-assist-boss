"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { DayItem, Tone } from "@/core/dashboard";
import { cn } from "@/lib/utils";

const DOT: Record<Tone, string> = { amber: "bg-amber", sage: "bg-sage", coral: "bg-coral", dim: "bg-dim" };
const NOTE: Record<Tone, string> = { amber: "text-amber", sage: "text-sage", coral: "text-coral", dim: "text-dim" };

/** На телефоне видны первые пункты, остальные по кнопке: день не должен вытеснять решения. */
const HEAD = 3;

/** Ссылка встречи + кнопка «Отправить помощника»: сервер сам проверяет платформу и права. */
function JoinControl({ leaderId, join }: { leaderId: string; join: NonNullable<DayItem["join"]> }) {
  const [url, setUrl] = useState(join.url);
  const [state, setState] = useState<{ busy: boolean; msg: string; done: boolean }>({ busy: false, msg: "", done: join.botActive });
  async function send() {
    setState({ busy: true, msg: "", done: false });
    try {
      const res = await fetch(`/api/meetings/${join.meetingId}/join?leaderId=${encodeURIComponent(leaderId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; status?: string; reason?: string };
      if (res.ok && body.status === "launched") setState({ busy: false, msg: "Помощник отправлен на встречу.", done: true });
      else setState({ busy: false, msg: body.error ?? body.reason ?? `Ошибка ${res.status}`, done: false });
    } catch {
      setState({ busy: false, msg: "Нет связи с сервером.", done: false });
    }
  }
  if (state.done) return <div className="text-sage">{state.msg || "Помощник уже на встрече."}</div>;
  return (
    <div className="flex flex-col gap-1.5 pt-1">
      <input
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="Ссылка Zoom, Meet, Teams…"
        aria-label="Ссылка на встречу"
        className="min-h-11 rounded-xl border border-line bg-sunken px-3 text-[13px]"
      />
      <button type="button" disabled={state.busy || url.trim() === ""} onClick={send} className="min-h-11 self-start rounded-full border border-line px-4 text-amber disabled:opacity-50">
        {state.busy ? "Отправляю…" : "Отправить помощника"}
      </button>
      {state.msg && <div className="text-coral">{state.msg}</div>}
    </div>
  );
}

/** «Ваш день»: каждый пункт раскрывается и показывает, что за ним стоит. */
export function DayList({ items, leaderId }: { items: DayItem[]; leaderId: string }) {
  const [open, setOpen] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  const hidden = items.length - HEAD;
  return (
    <>
      <ol className="relative flex flex-col gap-1 pl-[22px] pt-3">
        <div className="absolute bottom-3 left-[5px] top-6 w-px bg-[#3d3931]" />
        {items.map((e, i) => {
          const isOpen = open === i;
          return (
            <li key={`${e.time}-${e.title}-${i}`} data-avatar-anchor="day-item" className={cn("relative", i >= HEAD && !all && "hidden lg:block")}>
              <span className={`absolute -left-[22px] top-[18px] size-[11px] rounded-full border-2 border-ink ${DOT[e.tone]}`} />
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : i)}
                className="flex min-h-11 w-full items-start gap-2 rounded-xl px-2 py-1.5 text-left hover:bg-sunken"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[13px] text-dim">{e.time}</span>
                  <span className="font-medium">{e.title}</span>
                  {e.note && <span className={`text-[13px] ${NOTE[e.tone]}`}>{e.note}</span>}
                </span>
                <ChevronDown size={16} className={cn("mt-1.5 shrink-0 text-dim transition-transform", isOpen && "rotate-180")} aria-hidden="true" />
              </button>
              {isOpen && (
                <div className="flex flex-col gap-1 px-2 pb-2 pt-1 text-[13px] text-soft">
                  {e.details.map((d) => (
                    <div key={d} className="break-words">{d}</div>
                  ))}
                  {e.join && <JoinControl leaderId={leaderId} join={e.join} />}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {hidden > 0 && (
        <button type="button" onClick={() => setAll(!all)} className="mt-1 min-h-11 self-start rounded-full px-3 text-[13px] text-amber lg:hidden">
          {all ? "Свернуть" : `Показать все (ещё ${hidden})`}
        </button>
      )}
    </>
  );
}
