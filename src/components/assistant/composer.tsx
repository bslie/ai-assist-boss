"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Mic, X } from "lucide-react";
import type { ChatReply } from "@/core/chat";

const SUGGESTIONS = ["Что на сегодня?", "Ответь Павловой, что в четверг", "Запомни: вендоров в архив"];

interface Msg {
  from: "me" | "bot";
  text: string;
  actions?: ChatReply["actions"];
  /** Кнопка уже нажата: показываем итог вместо неё. */
  result?: string;
}

/** Чат с помощником: поле на всю ширину колонки и лента ответов над ним. POST /api/chat. */
export function Composer({ leaderId }: { leaderId: string }) {
  const [text, setText] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [msgs, busy]);

  const q = `?leaderId=${encodeURIComponent(leaderId)}`;

  async function send(raw: string) {
    const t = raw.trim();
    if (!t || busy) return;
    setText("");
    setMsgs((m) => [...m, { from: "me", text: t }]);
    setBusy(true);
    try {
      const res = await fetch(`/api/chat${q}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: t }) });
      const j = (await res.json().catch(() => ({}))) as Partial<ChatReply> & { error?: string };
      setMsgs((m) => [...m, { from: "bot", text: res.ok && j.text ? j.text : (j.error ?? `Ошибка ${res.status}`), actions: res.ok ? j.actions : undefined }]);
    } catch {
      setMsgs((m) => [...m, { from: "bot", text: "Не получилось связаться с сервером. Попробуйте ещё раз." }]);
    } finally {
      setBusy(false);
    }
  }

  async function run(i: number, a: NonNullable<ChatReply["actions"]>[number]) {
    const res = await fetch(`/api/decisions/${a.resolve.decisionId}/resolve${q}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a.resolve.body) });
    const result = res.ok ? "Готово: ответ утверждён." : res.status === 409 ? "Это письмо уже решено." : "Не получилось, попробуйте в карточке.";
    setMsgs((m) => m.map((x, k) => (k === i ? { ...x, actions: undefined, result } : x)));
  }

  return (
    <div className="-mx-4 flex flex-col gap-2 border-t border-line bg-ink px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 sm:mx-0 sm:border-0 sm:bg-gradient-to-b sm:from-transparent sm:to-ink sm:to-40% sm:gap-2.5 sm:px-0 sm:pb-5 sm:pt-6">
      {msgs.length > 0 && (
        <div className="relative rounded-[18px] border border-line bg-sunken">
          <button type="button" aria-label="Свернуть переписку" onClick={() => setMsgs([])} className="absolute right-1 top-1 flex size-9 items-center justify-center rounded-full text-dim hover:text-foreground">
            <X size={16} />
          </button>
          <div role="log" aria-live="polite" className="flex max-h-[40vh] flex-col gap-2.5 overflow-y-auto p-3 pr-10">
            {msgs.map((m, i) => (
              <div key={i} className={m.from === "me" ? "self-end rounded-2xl bg-raised px-3.5 py-2 text-[15px]" : "flex max-w-full flex-col gap-2 text-[15px] text-soft"}>
                <div className="whitespace-pre-wrap break-words">{m.text}</div>
                {m.actions?.map((a) => (
                  <button key={a.label} type="button" onClick={() => run(i, a)} className="min-h-11 self-start rounded-full bg-amber px-5 text-[14px] font-semibold text-[#1b1305]">
                    {a.label}
                  </button>
                ))}
                {m.result && <div className="text-[13px] text-sage">{m.result}</div>}
              </div>
            ))}
            {busy && <div className="text-[13px] text-dim">Думаю…</div>}
            <div ref={end} />
          </div>
        </div>
      )}
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => void send(s)}
            className="min-h-11 shrink-0 whitespace-nowrap rounded-full border border-[#3d3931] bg-sunken px-4 text-[13px] text-soft hover:text-foreground"
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
        className="flex items-center gap-2 rounded-full border border-line-strong bg-raised py-1 pl-5 pr-1 transition-colors focus-within:border-amber/70 sm:py-1.5 sm:pl-6 sm:pr-1.5"
      >
        <label htmlFor="say" className="sr-only">Сообщение помощнику</label>
        <input
          id="say"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Скажите, что сделать"
          className="min-h-11 min-w-0 flex-1 bg-transparent outline-none placeholder:text-dim"
        />
        <button type="button" aria-label="Голосом (скоро)" disabled className="flex size-11 items-center justify-center rounded-full text-dim"><Mic size={20} /></button>
        <button type="submit" aria-label="Отправить" disabled={busy || !text.trim()} className="flex size-11 items-center justify-center rounded-full bg-amber text-[#1b1305] disabled:opacity-50"><ArrowUp size={18} /></button>
      </form>
    </div>
  );
}
