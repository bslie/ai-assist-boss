"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

// Порядок совпадает с вкладками в шапке: от него зависит, с какой стороны въезжает страница.
const ORDER = ["/", "/rules", "/connectors"];
const indexOf = (p: string) => {
  const i = ORDER.findIndex((o, n) => (n === 0 ? p === "/" : p === o || p.startsWith(o + "/")));
  return i < 0 ? 0 : i;
};

let previous: number | null = null;

// Template пересоздаётся при каждом переходе между разделами: контент мягко въезжает, шапка остаётся на месте.
export default function AppTemplate({ children }: { children: React.ReactNode }) {
  const current = indexOf(usePathname());
  // На первой загрузке previous пуст: сервер и клиент рисуют одно и то же, без слайда.
  const dir = previous === null || previous === current ? "" : current > previous ? "page-slide-right" : "page-slide-left";

  useEffect(() => {
    previous = current;
  }, [current]);

  return <div className={`page-fade ${dir} flex flex-1 flex-col overflow-x-clip`}>{children}</div>;
}
