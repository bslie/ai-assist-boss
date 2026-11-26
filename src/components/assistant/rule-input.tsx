"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/** Правила словами (P1): текст → diff Rule → «Запомнить / Только на неделю / Не надо». */
export function RuleInput() {
  const [text, setText] = useState("");
  const [understood, setUnderstood] = useState<string | null>(null);

  return (
    <section aria-labelledby="d" className="flex flex-col gap-3.5">
      <h2 id="d" className="font-serif text-2xl font-medium">Хотите добавить правило? Просто скажите.</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) setUnderstood(text.trim()); // TODO: POST /api/rules/parse
        }}
        className="flex items-center gap-2 rounded-full border border-line-strong bg-raised py-1.5 pl-[22px] pr-1.5"
      >
        <label htmlFor="nr" className="sr-only">Правило словами</label>
        <input
          id="nr"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Например: письма от логистов по пятницам читай только в сводке"
          className="min-h-11 min-w-0 flex-1 bg-transparent outline-none placeholder:text-dim"
        />
        <Button type="submit" className="h-11 rounded-full bg-amber px-[22px] font-semibold text-[#1b1305] hover:bg-amber/90">Понять</Button>
      </form>
      {understood && (
        <div className="flex flex-col gap-3 rounded-[18px] border border-line bg-sunken px-5 py-[18px]">
          <div className="text-xs text-dim">Я поняла так</div>
          <div className="font-serif text-[19px]">{understood}</div>
          <div className="flex flex-wrap gap-2.5">
            <Button className="h-11 rounded-full px-5 font-semibold" onClick={() => setUnderstood(null)}>Запомнить</Button>
            <Button variant="outline" className="h-11 rounded-full px-5" onClick={() => setUnderstood(null)}>Только на неделю</Button>
            <Button variant="ghost" className="h-11 rounded-full px-5 text-dim" onClick={() => setUnderstood(null)}>Не надо</Button>
          </div>
        </div>
      )}
    </section>
  );
}
