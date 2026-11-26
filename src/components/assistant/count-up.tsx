"use client";

import { useLayoutEffect, useRef } from "react";
import { introDone } from "./intro-gate";

/** Одна десятичная, запятая; целые — без дробной части. */
const format = (n: number, target: number) => (Number.isInteger(target) ? Math.round(n) : Math.round(n * 10) / 10).toString().replace(".", ",");

/**
 * Число, которое плавно набирается от нуля. Кадры анимации пишутся прямо в DOM (без setState на каждый кадр);
 * React рендерит итоговое значение, так что SSR и повторный показ сразу дают правильное число.
 */
export function CountUp({ value, suffix = "", delay = 0, className }: { value: number; suffix?: string; delay?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || introDone() || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.textContent = format(0, value);
    let raf = 0;
    const timer = setTimeout(() => {
      const start = performance.now();
      const tick = (t: number) => {
        const p = Math.min(1, (t - start) / 1200);
        el.textContent = format(value * (1 - Math.pow(1 - p, 3)), value);
        if (p < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }, delay);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      el.textContent = format(value, value);
    };
  }, [value, delay]);

  return (
    <div className={className} style={{ fontVariantNumeric: "tabular-nums" }}>
      <span ref={ref}>{format(value, value)}</span>
      {suffix}
    </div>
  );
}
