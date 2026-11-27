"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { introDone } from "./intro-gate";

export type Segment = { text: string; className?: string };

const TOTAL_MS = 1900; // вся строка печатается примерно за это время
const ERASE_CHAR_MS = 32; // стирание чуть быстрее печати
const ERASE_MAX_MS = 1600;
const TYPE_CHAR_MS = 48;
const TYPE_MAX_MS = 2400;
const PAUSE_MS = 250;
const MAX_FRAME_MS = 100; // длиннее кадр считаем зависанием и не даём анимации перескочить

const length = (segs: Segment[]) => segs.reduce((n, s) => n + s.text.length, 0);

/** Сколько первых символов у двух заголовков совпадает вместе с цветом сегмента: до них стирать не нужно. */
function commonPrefix(a: Segment[], b: Segment[]): number {
  let n = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i].className !== b[i].className) break;
    const x = a[i].text;
    const y = b[i].text;
    let k = 0;
    while (k < x.length && k < y.length && x[k] === y[k]) k++;
    n += k;
    if (k < x.length || k < y.length) break;
  }
  return n;
}

/**
 * Заголовок, который печатается по буквам. Полный текст держит место в вёрстке, так что ничего не прыгает.
 * Если вступление уже было (html[data-intro-done]) или движение отключено, CSS показывает весь текст сразу,
 * ещё до гидрации; состояние догоняет его в первом кадре.
 * Когда текст меняется (пришли новые письма, решили карточку), старый хвост стирается до общего начала,
 * а новый печатается заново.
 */
export function TypedHeadline({ segments, className }: { segments: Segment[]; className?: string }) {
  const [view, setView] = useState<{ segments: Segment[]; count: number }>({ segments, count: 0 });
  const [live, setLive] = useState(false);
  const viewRef = useRef(view);
  useLayoutEffect(() => {
    viewRef.current = view;
  });
  /** Ключ текста, который уже показан целиком или печатается; null — вступление ещё не началось. */
  const applied = useRef<string | null>(null);
  const key = segments.map((s) => `${s.className ?? ""}\u0001${s.text}`).join("\u0002");

  useLayoutEffect(() => {
    let raf = 0;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const cancel = () => cancelAnimationFrame(raf);
    const total = length(segments);

    if (applied.current === null) {
      // Первый показ: вступление печатает заголовок, а если оно уже было, показываем сразу.
      setView({ segments, count: 0 });
      setLive(true);
      if (introDone() || reduced) {
        // flushSync: перерисовать до ближайшей отрисовки, без кадра с пустым заголовком.
        raf = requestAnimationFrame(() => {
          applied.current = key;
          flushSync(() => setView({ segments, count: total }));
        });
        return cancel;
      }
      const start = performance.now();
      const tick = (t: number) => {
        const next = Math.min(total, Math.floor(((t - start) / TOTAL_MS) * total));
        setView({ segments, count: next });
        if (next < total) raf = requestAnimationFrame(tick);
        else applied.current = key;
      };
      raf = requestAnimationFrame(tick);
      return cancel;
    }

    if (applied.current === key) return;

    // Текст поменялся: стираем до общего начала, потом печатаем новый.
    const from = viewRef.current;
    if (reduced) {
      applied.current = key;
      setView({ segments, count: total });
      return;
    }
    const keep = Math.min(from.count, commonPrefix(from.segments, segments));
    const eraseN = from.count - keep;
    const typeN = total - keep;
    const erasePer = eraseN ? Math.min(ERASE_CHAR_MS, ERASE_MAX_MS / eraseN) : 0;
    const typePer = typeN ? Math.min(TYPE_CHAR_MS, TYPE_MAX_MS / typeN) : 0;
    let erasing = eraseN > 0;
    if (!erasing) setView({ segments, count: keep });
    // Прогресс копится по кадрам, а не по часам: если страница на секунду зависла, анимация не перескакивает, а идёт дальше.
    let prev = 0;
    let progress = 0; // символов уже стёрто / напечатано в текущей фазе
    let pause = erasing ? PAUSE_MS : 0; // короткая пауза между стиранием и печатью

    const tick = (t: number) => {
      const dt = prev ? Math.min(t - prev, MAX_FRAME_MS) : 0;
      prev = t;
      if (erasing) {
        progress += dt / erasePer;
        const left = Math.max(keep, from.count - Math.floor(progress));
        setView({ segments: from.segments, count: left });
        if (left > keep) {
          raf = requestAnimationFrame(tick);
          return;
        }
        erasing = false;
        progress = 0;
        setView({ segments, count: keep });
        raf = requestAnimationFrame(tick);
        return;
      }
      if (pause > 0) {
        pause -= dt;
        raf = requestAnimationFrame(tick);
        return;
      }
      progress += typePer ? dt / typePer : typeN;
      const next = Math.min(total, keep + Math.floor(progress));
      setView({ segments, count: next });
      if (next < total) raf = requestAnimationFrame(tick);
      else applied.current = key;
    };
    applied.current = key;
    raf = requestAnimationFrame(tick);
    return cancel;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- сегменты определяются ключом
  }, [key]);

  const shownSegments = view.segments;
  const total = length(shownSegments);
  const count = view.count;
  const done = count >= total;
  // Начало каждого сегмента в общей строке.
  const offsets = shownSegments.map((_, i) => shownSegments.slice(0, i).reduce((n, s) => n + s.text.length, 0));
  // Курсор стоит там, где кончается напечатанное: в первом сегменте, который ещё не показан целиком.
  const caretAt = count > 0 && !done ? shownSegments.findIndex((s, i) => count <= offsets[i] + s.text.length) : -1;

  return (
    <h1 className={`typed-headline ${className ?? ""}`} data-live={live ? "" : undefined} aria-label={segments.map((s) => s.text).join("")}>
      <span aria-hidden>
        {shownSegments.map((s, i) => {
          const shown = Math.max(0, Math.min(s.text.length, count - offsets[i]));
          return (
            <span key={i} className={s.className}>
              {s.text.slice(0, shown)}
              {i === caretAt && <span className="type-caret" />}
              {/* Хвост держит место в вёрстке. Inline-стиль, чтобы CSS «вступление уже было» не показал его во время стирания. */}
              <span className="typed-rest" style={live ? { visibility: "hidden" } : undefined}>
                {s.text.slice(shown)}
              </span>
            </span>
          );
        })}
        {done && <span className="type-caret type-caret-blink" />}
      </span>
    </h1>
  );
}
