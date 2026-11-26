"use client";

import { useEffect } from "react";

const KEY = "intro-seen";

/**
 * Вступительные анимации главной играют один раз за сессию вкладки.
 * Скрипт в корневом layout ставит html[data-intro-done] до первой отрисовки, если вступление уже было;
 * CSS и компоненты по этому признаку показывают всё сразу. Здесь только запись флага.
 */
export function IntroGate() {
  useEffect(() => {
    const mark = () => {
      try {
        sessionStorage.setItem(KEY, "1");
      } catch {}
      document.documentElement.dataset.introDone = "1";
    };
    const started = performance.now();
    const t = setTimeout(mark, 3600);
    return () => {
      clearTimeout(t);
      // Ушли со страницы посреди анимации: вступление считается показанным.
      // Порог отсекает двойной монтаж React Strict Mode в dev.
      if (performance.now() - started > 500) mark();
    };
  }, []);

  return null;
}

export const introDone = () => typeof document !== "undefined" && document.documentElement.dataset.introDone === "1";
