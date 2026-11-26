"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { DayItem, Tone } from "@/core/dashboard";
import { cn } from "@/lib/utils";

const DOT: Record<Tone, string> = { amber: "bg-amber", sage: "bg-sage", coral: "bg-coral", dim: "bg-dim" };
const NOTE: Record<Tone, string> = { amber: "text-amber", sage: "text-sage", coral: "text-coral", dim: "text-dim" };

/** «Ваш день»: каждый пункт раскрывается и показывает, что за ним стоит. */
export function DayList({ items }: { items: DayItem[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <ol className="relative flex flex-col gap-1 pl-[22px] pt-3">
      <div className="absolute bottom-3 left-[5px] top-6 w-px bg-[#3d3931]" />
      {items.map((e, i) => {
        const isOpen = open === i;
        return (
          <li key={`${e.time}-${e.title}-${i}`} className="relative">
            <span className={`absolute -left-[22px] top-[18px] size-[11px] rounded-full border-2 border-ink ${DOT[e.tone]}`} />
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : i)}
              className="flex min-h-11 w-full items-start gap-2 rounded-xl px-2 py-1.5 text-left hover:bg-sunken"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[13px] text-dim">{e.time}</span>
                <span className="font-medium">{e.title}</span>
                {e.note && <span className={`text-[13px] ${NOTE[e.tone]}`}>{e.note}</span>}
              </span>
              <ChevronDown size={16} className={cn("mt-1.5 shrink-0 text-dim transition-transform", isOpen && "rotate-180")} aria-hidden="true" />
            </button>
            {isOpen && (
              <div className="flex flex-col gap-1 px-2 pb-2 pt-1 text-[13px] text-soft">
                {e.details.map((d) => (
                  <div key={d} className="break-words">{d}</div>
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
