"use client";

import { Lock } from "lucide-react";
import type { Perm } from "@/core/connectors/types";
import { cn } from "@/lib/utils";

const OPTS: { value: Perm; label: string; on: string }[] = [
  { value: "AUTO", label: "Сама", on: "bg-sage text-[#0b1e10]" },
  { value: "APPROVE", label: "Спрашивать", on: "bg-amber text-[#1b1305]" },
  { value: "DENY", label: "Нельзя", on: "bg-coral text-[#2a0c08]" },
];

/** Переключатель Сама / Спрашивать / Нельзя для инструмента подключения. Потолок прав показывается замком. */
export function PermissionToggle({
  label,
  description,
  value,
  max,
  maxReason,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  value: Perm;
  max?: Perm | null;
  maxReason?: string | null;
  disabled?: boolean;
  onChange: (p: Perm) => void;
}) {
  const capped = max === "APPROVE";
  return (
    <div className="flex flex-col gap-1.5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-[160px] flex-1">
          <div className="text-[15px]">{label}</div>
          {description && <div className="text-[13px] text-dim">{description}</div>}
        </div>
        <div role="group" aria-label={label} className="flex gap-0.5 rounded-full border border-line bg-ink p-1">
          {OPTS.map((o) => {
            const locked = capped && o.value === "AUTO";
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={value === o.value}
                disabled={disabled || locked}
                onClick={() => onChange(o.value)}
                className={cn(
                  "flex min-h-9 items-center gap-1 rounded-full px-3 text-[13px] transition-colors disabled:cursor-not-allowed",
                  value === o.value ? cn(o.on, "font-semibold") : "text-dim enabled:hover:text-foreground",
                  locked && "opacity-40",
                )}
              >
                {locked && <Lock size={11} aria-hidden="true" />}
                {o.label}
              </button>
            );
          })}
        </div>
      </div>
      {capped && maxReason && (
        <div className="flex items-start gap-1.5 text-xs text-coral">
          <Lock size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
          {maxReason}
        </div>
      )}
    </div>
  );
}
