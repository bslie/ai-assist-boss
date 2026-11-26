"use client";

import { useState } from "react";
import { ArrowUp, Mic } from "lucide-react";

const SUGGESTIONS = ["Что на сегодня?", "Ответь Павловой, что в четверг", "Запомни: вендоров в архив"];

/** Поле «скажите помощнику» на всю ширину колонки. Отправка подключится к POST /api/chat (P1). */
export function Composer() {
  const [text, setText] = useState("");
  return (
    <div className="sticky bottom-0 z-10 -mx-1 flex flex-col gap-2.5 bg-gradient-to-b from-transparent to-ink to-40% px-1 pb-5 pt-6">
      <div className="flex flex-wrap gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setText(s)}
            className="min-h-11 rounded-full border border-[#3d3931] bg-sunken px-4 text-[13px] text-soft hover:text-foreground"
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
        className="flex items-center gap-2 rounded-full border border-line-strong bg-raised py-1.5 pl-6 pr-1.5 transition-colors focus-within:border-amber/70"
      >
        <label htmlFor="say" className="sr-only">Сообщение помощнику</label>
        <input
          id="say"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Скажите, что сделать, или объясните правило словами"
          className="min-h-11 min-w-0 flex-1 bg-transparent outline-none placeholder:text-dim"
        />
        <button type="button" aria-label="Голосом" className="flex size-11 items-center justify-center rounded-full text-soft hover:text-foreground"><Mic size={20} /></button>
        <button type="submit" aria-label="Отправить" className="flex size-11 items-center justify-center rounded-full bg-amber text-[#1b1305]"><ArrowUp size={18} /></button>
      </form>
    </div>
  );
}
