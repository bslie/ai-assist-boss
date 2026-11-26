"use client";

import { useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import { introDone } from "./intro-gate";

export type Segment = { text: string; className?: string };

const TOTAL_MS = 1900; // вся строка печатается примерно за это время

/**
 * Заголовок, который печатается по буквам. Полный текст держит место в вёрстке, так что ничего не прыгает.
 * Если вступление уже было (html[data-intro-done]) или движение отключено, CSS показывает весь текст сразу,
 * ещё до гидрации; состояние догоняет его в первом кадре.
 */
export function TypedHeadline({ segments, className }: { segments: Segment[]; className?: string }) {
  const total = segments.reduce((n, s) => n + s.text.length, 0);
  const [count, setCount] = useState(0);

  useLayoutEffect(() => {
    let raf = 0;
    if (introDone() || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // flushSync: перерисовать до ближайшей отрисовки, без кадра с пустым заголовком.
      raf = requestAnimationFrame(() => flushSync(() => setCount(total)));
      return () => cancelAnimationFrame(raf);
    }
    const start = performance.now();
    const tick = (t: number) => {
      const next = Math.min(total, Math.floor(((t - start) / TOTAL_MS) * total));
      setCount(next);
      if (next < total) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [total]);

  const done = count >= total;
  // Начало каждого сегмента в общей строке.
  const offsets = segments.map((_, i) => segments.slice(0, i).reduce((n, s) => n + s.text.length, 0));

  return (
    <h1 className={className} aria-label={segments.map((s) => s.text).join("")}>
      <span aria-hidden>
        {segments.map((s, i) => {
          const shown = Math.max(0, Math.min(s.text.length, count - offsets[i]));
          const caret = !done && shown > 0 && shown < s.text.length;
          return (
            <span key={i} className={s.className}>
              {s.text.slice(0, shown)}
              {caret && <span className="type-caret" />}
              <span className="typed-rest invisible">{s.text.slice(shown)}</span>
            </span>
          );
        })}
        {done && <span className="type-caret type-caret-blink" />}
      </span>
    </h1>
  );
}
