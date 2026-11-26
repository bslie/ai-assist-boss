"use client";

import { cn } from "@/lib/utils";

/** Выключатель с анимацией. Область нажатия 44px, сама дорожка компактная. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className="group flex size-11 shrink-0 items-center justify-center disabled:opacity-50"
    >
      <span className={cn("relative h-[22px] w-10 rounded-full transition-colors duration-200", checked ? "bg-sage" : "bg-line-strong")}>
        <span className={cn("absolute top-[3px] size-4 rounded-full bg-ink shadow transition-all duration-200", checked ? "left-[21px]" : "left-[3px] bg-soft")} />
      </span>
    </button>
  );
}
