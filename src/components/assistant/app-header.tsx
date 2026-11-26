"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Разговор" },
  { href: "/rules", label: "Как я работаю" },
  { href: "/profile", label: "Профиль" },
  { href: "/connectors", label: "Подключения" },
];

export function AppHeader({ title }: { title: string }) {
  const pathname = usePathname();
  return (
    <header className="mx-auto flex w-full max-w-[1280px] flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 sm:px-10 sm:py-5">
      <div className="flex items-center gap-3">
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <circle cx="16" cy="16" r="15" stroke="var(--amber)" strokeWidth="1.5" />
          <circle cx="16" cy="16" r="9" stroke="var(--amber)" strokeWidth="1.5" opacity="0.6" />
          <circle cx="16" cy="16" r="3.5" fill="var(--amber)" />
        </svg>
        <div className="font-serif text-lg font-medium">{title}</div>
      </div>
      <nav aria-label="Разделы" className="-mx-1 flex w-full gap-0.5 overflow-x-auto sm:ml-auto sm:mx-0 sm:w-auto sm:gap-1">
        {NAV.map((n) => {
          const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
          return (
            <Link
              key={n.href}
              href={n.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-11 items-center whitespace-nowrap rounded-full px-3 text-[14px] transition-colors sm:px-4 sm:text-[15px]",
                active ? "bg-raised font-medium text-foreground" : "text-dim hover:text-foreground",
              )}
            >
              {n.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
