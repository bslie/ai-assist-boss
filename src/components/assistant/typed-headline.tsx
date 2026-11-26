"use client";

import { useLayoutEffect, useState } from "react";
import { introDone } from "./intro-gate";

export type Segment = { text: string; className?: string };

const TOTAL_MS = 1900; // вся строка печатается примерно за это время

/** Заголовок, который печатается по буквам. Полный текст держит место в вёрстке, так что ничего не прыгает. */
export function TypedHeadline({ segments, className }: { segments: Segment[]; className?: string }) {
  const total = segments.reduce((n, s) => n + s.text.length, 0);
  const [count, setCount] = useState(0);

  useLayoutEffect(() => {
    if (introDone() || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setCount(total);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const next = Math.min(total, Math.floor(((t - start) / TOTAL_MS) * total));
      setCount(next);
      if (next < total) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [total]);

  const done = count >= total;
  let left = count;

  return (
    <h1 className={className} aria-label={segments.map((s) => s.text).join("")}>
      <span aria-hidden>
        {segments.map((s, i) => {
          const shown = Math.max(0, Math.min(s.text.length, left));
          left -= s.text.length;
          const caret = !done && shown > 0 && shown < s.text.length;
          return (
            <span key={i} className={s.className}>
              {s.text.slice(0, shown)}
              {caret && <span className="type-caret" />}
              <span className="invisible">{s.text.slice(shown)}</span>
            </span>
          );
        })}
        {done && <span className="type-caret type-caret-blink" />}
      </span>
    </h1>
  );
}
