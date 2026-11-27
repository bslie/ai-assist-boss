"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Разговор" },
  { href: "/tasks", label: "Поручения" },
  { href: "/rules", label: "Как я работаю" },
  { href: "/routines", label: "Рутины" },
  { href: "/metrics", label: "Метрики" },
  { href: "/profile", label: "Профиль" },
  { href: "/connectors", label: "Подключения" },
];

const isActive = (href: string, pathname: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

/**
 * Шапка. На широком экране — строка разделов справа. На телефоне семь вкладок в строке прокручивались
 * вбок и половину не было видно, поэтому там показан текущий раздел и кнопка меню со списком всех разделов.
 */
export function AppHeader({ title }: { title: string }) {
  const pathname = usePathname();
  // Меню открыто для конкретного раздела: перешли в другой — оно закрывается без эффекта.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === pathname;
  const setOpen = (v: boolean) => setOpenAt(v ? pathname : null);
  const current = NAV.find((n) => isActive(n.href, pathname));

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpenAt(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="relative mx-auto flex w-full max-w-[1280px] items-center gap-x-4 px-4 py-3 sm:px-10 sm:py-5">
      <div className="flex min-w-0 items-center gap-3">
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true" className="shrink-0">
          <circle cx="16" cy="16" r="15" stroke="var(--amber)" strokeWidth="1.5" />
          <circle cx="16" cy="16" r="9" stroke="var(--amber)" strokeWidth="1.5" opacity="0.6" />
          <circle cx="16" cy="16" r="3.5" fill="var(--amber)" />
        </svg>
        {/* На телефоне вместо длинного названия — раздел, в котором вы сейчас. */}
        <div className="hidden font-serif text-lg font-medium sm:block">{title}</div>
        <div className="truncate font-serif text-lg font-medium sm:hidden" aria-hidden="true">
          {current?.label ?? title}
        </div>
      </div>

      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="mobile-nav"
        aria-label={open ? "Закрыть меню" : "Открыть меню разделов"}
        className="ml-auto flex size-11 items-center justify-center rounded-full border border-line-strong bg-raised text-foreground transition-colors hover:border-amber/50 sm:hidden"
      >
        {open ? <X className="size-5" aria-hidden="true" /> : <Menu className="size-5" aria-hidden="true" />}
      </button>

      <nav aria-label="Разделы" className="ml-auto hidden gap-1 sm:flex">
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            aria-current={isActive(n.href, pathname) ? "page" : undefined}
            className={cn(
              "flex min-h-11 items-center whitespace-nowrap rounded-full px-4 text-[15px] transition-colors",
              isActive(n.href, pathname) ? "bg-raised font-medium text-foreground" : "text-dim hover:text-foreground",
            )}
          >
            {n.label}
          </Link>
        ))}
      </nav>

      {open && (
        <>
          {/* Подложка: нажатие мимо меню закрывает его. */}
          <button type="button" aria-label="Закрыть меню" tabIndex={-1} onClick={() => setOpen(false)} className="fixed inset-0 z-30 bg-black/50 sm:hidden" />
          <nav
            id="mobile-nav"
            aria-label="Разделы"
            className="page-fade absolute inset-x-3 top-full z-40 flex flex-col gap-0.5 rounded-2xl border border-line-strong bg-raised p-2 shadow-2xl shadow-black/60 sm:hidden"
          >
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={isActive(n.href, pathname) ? "page" : undefined}
                className={cn(
                  "flex min-h-12 items-center rounded-xl px-4 text-[16px] transition-colors",
                  isActive(n.href, pathname) ? "bg-sunken font-medium text-amber" : "text-soft active:bg-sunken",
                )}
              >
                {n.label}
              </Link>
            ))}
          </nav>
        </>
      )}
    </header>
  );
}
