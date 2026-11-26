"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import type { Permission } from "@/lib/demo-data";

const OPTS: { value: Permission; label: string; on: string }[] = [
  { value: "auto", label: "Сама", on: "bg-sage text-[#0b1e10]" },
  { value: "ask", label: "Спрашивать", on: "bg-amber text-[#1b1305]" },
  { value: "deny", label: "Нельзя", on: "bg-coral text-[#2a0c08]" },
];

/** Переключатель AUTO / APPROVE / DENY для инструмента коннектора (PATCH /api/connectors/[id]/permissions). */
export function PermissionToggle({ label, initial }: { label: string; initial: Permission }) {
  const [value, setValue] = useState<Permission>(initial);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2.5">
      <span className="min-w-[150px] flex-1">{label}</span>
      <div role="group" aria-label={label} className="flex gap-1 rounded-full border border-line bg-ink p-1">
        {OPTS.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => setValue(o.value)}
            className={cn("min-h-9 rounded-full px-3.5 text-[13px]", value === o.value ? cn(o.on, "font-semibold") : "text-dim")}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
