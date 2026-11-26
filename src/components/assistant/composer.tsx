"use client";

import { useState } from "react";
import { ArrowUp, Mic } from "lucide-react";

const SUGGESTIONS = ["Что на сегодня?", "Ответь Павловой, что в четверг", "Запомни: вендоров в архив"];

/** Поле «скажите помощнику» на всю ширину колонки. Отправка подключится к POST /api/chat (P1). */
export function Composer() {
  const [text, setText] = useState("");
  return (
    <div className="-mx-4 flex flex-col gap-2 border-t border-line bg-ink px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 sm:mx-0 sm:border-0 sm:bg-gradient-to-b sm:from-transparent sm:to-ink sm:to-40% sm:gap-2.5 sm:px-0 sm:pb-5 sm:pt-6">
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setText(s)}
            className="min-h-11 shrink-0 whitespace-nowrap rounded-full border border-[#3d3931] bg-sunken px-4 text-[13px] text-soft hover:text-foreground"
          >
            {s}
          </button>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setText("");
        }}
        // Рамка фокуса рисуется вокруг всей капсулы, а не вокруг самого поля.
        className="flex items-center gap-2 rounded-full border border-line-strong bg-raised py-1 pl-5 pr-1 sm:py-1.5 sm:pl-6 sm:pr-1.5 transition-colors focus-within:border-amber/70"
      >
        <label htmlFor="say" className="sr-only">Сообщение помощнику</label>
        <input
          id="say"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Скажите, что сделать"
          className="min-h-11 min-w-0 flex-1 bg-transparent outline-none placeholder:text-dim"
        />
        <button type="button" aria-label="Голосом" className="flex size-11 items-center justify-center rounded-full text-soft hover:text-foreground"><Mic size={20} /></button>
        <button type="submit" aria-label="Отправить" className="flex size-11 items-center justify-center rounded-full bg-amber text-[#1b1305]"><ArrowUp size={18} /></button>
      </form>
    </div>
  );
}
