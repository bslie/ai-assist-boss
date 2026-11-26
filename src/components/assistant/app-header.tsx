"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Разговор" },
  { href: "/rules", label: "Как я работаю" },
  { href: "/connectors", label: "Подключения" },
];

export function AppHeader({ title }: { title: string }) {
  const pathname = usePathname();
  return (
    <header className="flex flex-wrap items-center gap-4 px-5 py-5 sm:px-10">
      <div className="flex items-center gap-3">
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <circle cx="16" cy="16" r="15" stroke="var(--amber)" strokeWidth="1.5" />
          <circle cx="16" cy="16" r="9" stroke="var(--amber)" strokeWidth="1.5" opacity="0.6" />
          <circle cx="16" cy="16" r="3.5" fill="var(--amber)" />
        </svg>
        <div className="font-serif text-lg font-medium">{title}</div>
      </div>
      <nav aria-label="Разделы" className="ml-auto flex flex-wrap gap-1">
        {NAV.map((n) => {
          const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
          return (
            <Link
              key={n.href}
              href={n.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-11 items-center rounded-full px-4 transition-colors",
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
