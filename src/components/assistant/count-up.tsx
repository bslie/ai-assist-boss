"use client";

import { useLayoutEffect, useState } from "react";
import { introDone } from "./intro-gate";

/** Число, которое плавно набирается от нуля. Формат: одна десятичная, запятая. */
export function CountUp({ value, suffix = "", delay = 0, className }: { value: number; suffix?: string; delay?: number; className?: string }) {
  const [shown, setShown] = useState(value);

  useLayoutEffect(() => {
    if (introDone() || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setShown(0);
    let raf = 0;
    const timer = setTimeout(() => {
      const start = performance.now();
      const tick = (t: number) => {
        const p = Math.min(1, (t - start) / 1200);
        setShown(value * (1 - Math.pow(1 - p, 3)));
        if (p < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }, delay);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [value, delay]);

  const text = (Number.isInteger(value) ? Math.round(shown) : Math.round(shown * 10) / 10).toString().replace(".", ",");
  return (
    <div className={className} style={{ fontVariantNumeric: "tabular-nums" }}>
      {text}
      {suffix}
    </div>
  );
}
