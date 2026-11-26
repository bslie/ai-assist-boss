"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, Mic } from "lucide-react";
import type { ChatReply } from "@/core/chat";
import { cn } from "@/lib/utils";

const SUGGESTIONS = ["Что на сегодня?", "Какие встречи можно пропустить?", "Ответь Павловой, что в четверг", "Запомни: вендоров в архив"];

interface Msg {
  from: "me" | "bot";
  text: string;
  draft?: string;
  actions?: ChatReply["actions"];
  /** Кнопка уже нажата: показываем итог вместо неё. */
  result?: string;
}

function Avatar() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" fill="none" aria-hidden="true" className="mt-0.5 shrink-0">
      <circle cx="16" cy="16" r="15" stroke="var(--amber)" strokeWidth="1.8" />
      <circle cx="16" cy="16" r="5" fill="var(--amber)" />
    </svg>
  );
}

/** Чат с помощником: поле на всю ширину колонки и лента ответов над ним. POST /api/chat. */
export function Composer({ leaderId }: { leaderId: string }) {
  const [text, setText] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(true);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [msgs, busy, open]);

  const q = `?leaderId=${encodeURIComponent(leaderId)}`;

  async function send(raw: string) {
    const t = raw.trim();
    if (!t || busy) return;
    // Предыдущие реплики уходят вместе с вопросом: помощник помнит, о чём шла речь.
    const history = msgs.slice(-8).map((m) => ({ from: m.from, text: m.draft ? `${m.text}\n${m.draft}` : m.text }));
    setText("");
    setOpen(true);
    setMsgs((m) => [...m, { from: "me", text: t }]);
    setBusy(true);
    try {
      const res = await fetch(`/api/chat${q}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: t, history }) });
      const j = (await res.json().catch(() => ({}))) as Partial<ChatReply> & { error?: string };
      setMsgs((m) => [
        ...m,
        res.ok && j.text
          ? { from: "bot", text: j.text, draft: j.draft, actions: j.actions }
          : { from: "bot", text: j.error ?? `Ошибка ${res.status}` },
      ]);
    } catch {
      setMsgs((m) => [...m, { from: "bot", text: "Не получилось связаться с сервером. Попробуйте ещё раз." }]);
    } finally {
      setBusy(false);
    }
  }

  async function run(i: number, a: NonNullable<ChatReply["actions"]>[number]) {
    const res = await fetch(`/api/decisions/${a.resolve.decisionId}/resolve${q}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a.resolve.body) });
    const result = res.ok ? "Ответ утверждён" : res.status === 409 ? "Это письмо уже решено" : "Не получилось, попробуйте в карточке";
    setMsgs((m) => m.map((x, k) => (k === i ? { ...x, actions: undefined, result } : x)));
  }

  return (
    <div className="-mx-4 flex flex-col gap-2.5 bg-gradient-to-b from-transparent via-ink/90 to-ink px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-6 sm:mx-0 sm:px-0 sm:pb-5">
      {msgs.length > 0 && (
        <section aria-label="Переписка с помощником" className="chat-panel overflow-hidden rounded-3xl border border-line-strong bg-sunken/90 shadow-[0_18px_50px_-18px_rgba(0,0,0,0.8)] backdrop-blur-md">
          <header className="flex items-center gap-2 px-4 pt-2.5">
            <span className="text-xs font-medium uppercase tracking-[0.08em] text-dim">Разговор</span>
            <button type="button" onClick={() => setMsgs([])} className="ml-auto min-h-9 rounded-full px-3 text-[13px] text-dim transition-colors hover:text-foreground">
              Очистить
            </button>
            <button
              type="button"
              aria-label={open ? "Свернуть" : "Развернуть"}
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              className="flex size-9 items-center justify-center rounded-full text-dim transition-colors hover:bg-raised hover:text-foreground"
            >
              <ChevronDown size={18} className={cn("transition-transform duration-300", !open && "rotate-180")} />
            </button>
          </header>
          {/* Высота плавно схлопывается: grid-rows 1fr → 0fr. */}
          <div className={cn("grid transition-[grid-template-rows] duration-300 ease-out", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
            <div className="min-h-0 overflow-hidden">
              <div role="log" aria-live="polite" className="no-scrollbar chat-fade flex max-h-[42vh] flex-col gap-3 overflow-y-auto px-4 py-3">
                {msgs.map((m, i) =>
                  m.from === "me" ? (
                    <div key={i} className="chat-in max-w-[85%] self-end whitespace-pre-wrap break-words rounded-[20px] rounded-br-md bg-amber px-4 py-2.5 text-[15px] font-medium text-[#1b1305]">
                      {m.text}
                    </div>
                  ) : (
                    <div key={i} className="chat-in flex gap-2.5">
                      <Avatar />
                      <div className="flex min-w-0 flex-1 flex-col gap-2.5 text-[15px] text-foreground">
                        <div className="whitespace-pre-wrap break-words leading-relaxed">{m.text}</div>
                        {m.draft && (
                          <blockquote className="whitespace-pre-wrap break-words rounded-2xl border border-line bg-ink px-4 py-3 font-serif text-[16px] leading-normal text-soft">
                            {m.draft}
                          </blockquote>
                        )}
                        {m.actions?.map((a) => (
                          <button
                            key={a.label}
                            type="button"
                            onClick={() => run(i, a)}
                            className="min-h-11 self-start rounded-full bg-amber px-5 text-[14px] font-semibold text-[#1b1305] transition-transform hover:scale-[1.03] active:scale-95"
                          >
                            {a.label}
                          </button>
                        ))}
                        {m.result && <div className="chat-in flex items-center gap-1.5 text-[13px] text-sage"><span className="size-1.5 rounded-full bg-sage" />{m.result}</div>}
                      </div>
                    </div>
                  ),
                )}
                {busy && (
                  <div className="chat-in flex items-center gap-2.5" aria-label="Помощник печатает">
                    <Avatar />
                    <div className="flex gap-1 rounded-full bg-raised px-3.5 py-3">
                      {[0, 1, 2].map((d) => (
                        <span key={d} className="chat-dot size-1.5 rounded-full bg-soft" style={{ animationDelay: `${d * 150}ms` }} />
                      ))}
                    </div>
                  </div>
                )}
                <div ref={end} />
              </div>
            </div>
          </div>
        </section>
      )}
      <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => void send(s)}
            className="min-h-11 shrink-0 whitespace-nowrap rounded-full border border-line-strong bg-sunken/80 px-4 text-[13px] text-soft transition-all hover:-translate-y-0.5 hover:border-amber/50 hover:text-foreground active:translate-y-0"
          >
            {s}
          </button>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
        // Рамка фокуса рисуется вокруг всей капсулы, а не вокруг самого поля.
        className="flex items-center gap-2 rounded-full border border-line-strong bg-raised py-1 pl-5 pr-1 shadow-[0_8px_30px_-12px_rgba(0,0,0,0.9)] transition-all duration-200 focus-within:border-amber/70 focus-within:shadow-[0_0_0_4px_rgba(240,179,90,0.12)] sm:py-1.5 sm:pl-6 sm:pr-1.5"
      >
        <label htmlFor="say" className="sr-only">Сообщение помощнику</label>
        <input
          id="say"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Скажите, что сделать"
          autoComplete="off"
          className="min-h-11 min-w-0 flex-1 bg-transparent outline-none placeholder:text-dim"
        />
        <button type="button" aria-label="Голосом (скоро)" disabled className="flex size-11 items-center justify-center rounded-full text-dim"><Mic size={20} /></button>
        <button
          type="submit"
          aria-label="Отправить"
          disabled={busy || !text.trim()}
          className="flex size-11 items-center justify-center rounded-full bg-amber text-[#1b1305] transition-all duration-200 enabled:hover:scale-105 enabled:active:scale-95 disabled:bg-line-strong disabled:text-dim"
        >
          <ArrowUp size={18} />
        </button>
      </form>
    </div>
  );
}
