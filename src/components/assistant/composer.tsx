"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, ChevronDown, Mic, X } from "lucide-react";
import { z } from "zod";
import type { ChatReply } from "@/core/chat";
import { cn } from "@/lib/utils";

/** Пока подсказки генерируются или сервер не ответил, показываем нейтральный набор. */
const PLACEHOLDER_SUGGESTIONS = ["Что на сегодня?", "Что ты умеешь?"];

interface Msg {
  from: "me" | "bot";
  text: string;
  draft?: string;
  actions?: ChatReply["actions"];
  /** Кнопка уже нажата: показываем итог вместо неё. */
  result?: string;
}

const MAX_SAVED = 40;
const SavedSchema = z.object({
  open: z.boolean(),
  msgs: z.array(
    z.object({
      from: z.enum(["me", "bot"]),
      text: z.string(),
      draft: z.string().optional(),
      result: z.string().optional(),
      actions: z.array(z.record(z.string(), z.unknown())).optional(),
    }),
  ),
});

/** Сохранённая переписка; битые или чужие данные в хранилище игнорируем. */
function loadChat(key: string): { msgs: Msg[]; open: boolean } | null {
  try {
    const raw = sessionStorage.getItem(key);
    const parsed = raw ? SavedSchema.safeParse(JSON.parse(raw)) : null;
    return parsed?.success ? (parsed.data as { msgs: Msg[]; open: boolean }) : null;
  } catch {
    return null;
  }
}

function saveChat(key: string, v: { msgs: Msg[]; open: boolean }) {
  try {
    if (v.msgs.length === 0) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify({ open: v.open, msgs: v.msgs.slice(-MAX_SAVED) }));
  } catch {
    // хранилище недоступно или переполнено: чат работает, просто не переживёт перезагрузку
  }
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
export function Composer({ leaderId, children }: { leaderId: string; /** Под полем ввода: подсказка подключить почту и календарь. */ children?: ReactNode }) {
  const [text, setText] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(true);
  const end = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [msgs, busy, open]);

  // Переписка переживает перезагрузку страницы и сворачивание: лежит в sessionStorage вкладки, отдельно для каждого руководителя.
  // «Закрыть чат» (крестик) стирает её. Читаем после монтирования, чтобы разметка сервера и клиента совпала.
  const storeKey = `chat:${leaderId}`;
  const restored = useRef(false);
  const restore = useCallback(() => {
    const saved = loadChat(storeKey);
    if (saved) {
      setMsgs(saved.msgs);
      setOpen(saved.open);
    }
    restored.current = true;
  }, [storeKey]);
  useEffect(() => {
    // Чтение внешнего хранилища после монтирования: единственный способ не получить расхождение гидрации.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    restore();
  }, [restore]);
  useEffect(() => {
    if (restored.current) saveChat(storeKey, { msgs, open });
  }, [msgs, open, storeKey]);

  // Клик мимо чата (и поля ввода) сворачивает переписку, но не закрывает её.
  useEffect(() => {
    function onDown(e: PointerEvent) {
      if (root.current && e.target instanceof Node && !root.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);

  const q = `?leaderId=${encodeURIComponent(leaderId)}`;

  // Подсказки составляет модель по контексту руководителя; после действия в чате они обновляются.
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const refreshSuggestions = useRef(() => {});
  refreshSuggestions.current = () => {
    fetch(`/api/chat/suggestions${q}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { suggestions?: string[] } | null) => setSuggestions(j?.suggestions?.length ? j.suggestions : PLACEHOLDER_SUGGESTIONS))
      .catch(() => setSuggestions(PLACEHOLDER_SUGGESTIONS));
  };
  useEffect(() => {
    refreshSuggestions.current();
  }, [leaderId]);

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
    let result: string;
    if ("resolve" in a) {
      const res = await fetch(`/api/decisions/${a.resolve.decisionId}/resolve${q}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a.resolve.body) });
      result = res.ok ? "Ответ утверждён" : res.status === 409 ? "Это письмо уже решено" : "Не получилось, попробуйте в карточке";
    } else if ("post" in a) {
      const res = await fetch(`${a.post.path}${q}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a.post.body) });
      const j = (await res.json().catch(() => ({}))) as { error?: string; status?: string; reason?: string };
      result = res.ok && j.status === "launched" ? a.done : (j.error ?? j.reason ?? "Не получилось отправить помощника");
      if (res.ok) router.refresh();
    } else {
      // Изменение настроек — тем же API, что и страницы; страница перечитается по SSE.
      const res = await fetch(`${a.patch.path}${q}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(a.patch.body) });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      result = res.ok ? a.done : (j.error ?? "Не получилось применить");
      if (res.ok) router.refresh();
    }
    setMsgs((m) => m.map((x, k) => (k === i ? { ...x, actions: undefined, result } : x)));
  }

  return (
    <div ref={root} className="-mx-4 flex flex-col gap-2.5 bg-gradient-to-b from-transparent via-ink/90 to-ink px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-6 sm:mx-0 sm:px-0 sm:pb-5">
      {msgs.length > 0 && (
        <section aria-label="Переписка с помощником" className="chat-panel overflow-hidden rounded-3xl border border-line-strong bg-sunken/90 shadow-[0_18px_50px_-18px_rgba(0,0,0,0.8)] backdrop-blur-md">
          {/* В свёрнутом виде отступы симметричны, иначе заголовок съезжает вниз. */}
          <header className={cn("flex items-center gap-2 px-4 transition-[padding] duration-300", open ? "pt-2.5" : "py-2.5")}>
            <span className="text-xs font-medium uppercase tracking-[0.08em] text-dim">Разговор</span>
            <button
              type="button"
              aria-label={open ? "Свернуть" : "Развернуть"}
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              className="ml-auto flex size-9 items-center justify-center rounded-full text-dim transition-colors hover:bg-raised hover:text-foreground"
            >
              <ChevronDown size={18} className={cn("transition-transform duration-300", !open && "rotate-180")} />
            </button>
            <button
              type="button"
              aria-label="Закрыть чат"
              onClick={() => {
                setMsgs([]);
                refreshSuggestions.current();
              }}
              className="flex size-9 items-center justify-center rounded-full text-dim transition-colors hover:bg-raised hover:text-foreground"
            >
              <X size={18} />
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
      {/* Подсказки видны только когда переписки нет (чат закрыт крестиком); в свёрнутом чате они скрыты. */}
      {msgs.length === 0 && (
      // Пока подсказки готовятся в фоне, место под них пустое (min-h держит высоту), потом они появляются по одной.
      <div className="no-scrollbar -mx-4 -my-1 flex min-h-[52px] gap-2 overflow-x-auto px-4 py-1 sm:mx-0 sm:h-[52px] sm:flex-wrap sm:overflow-hidden sm:px-0">
        {(suggestions ?? []).map((s, i) => (
          <button
            key={s}
            type="button"
            onClick={() => void send(s)}
            style={{ "--d": `${i * 90}ms` } as React.CSSProperties}
            className="chip-in min-h-11 shrink-0 whitespace-nowrap rounded-full border border-line-strong bg-sunken/80 px-4 text-[13px] text-soft transition-[transform,border-color,color] hover:-translate-y-0.5 hover:border-amber/50 hover:text-foreground active:translate-y-0"
          >
            {s}
          </button>
        ))}
      </div>
      )}
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
          onFocus={() => setOpen(true)}
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
      {children}
    </div>
  );
}
