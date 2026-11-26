"use client";

import { Lock } from "lucide-react";
import { Switch } from "@/components/assistant/switch";
import type { CatalogItem, ConnectorState } from "@/core/connectors/service";
import { cn } from "@/lib/utils";

export function ConnectorIcon({ letter, color, size = 44 }: { letter: string; color: string; size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-2xl font-serif font-medium text-ink"
      style={{ width: size, height: size, background: color, fontSize: size * 0.48 }}
      aria-hidden="true"
    >
      {letter}
    </div>
  );
}

const PILL: Record<ConnectorState, { text: string; cls: string } | null> = {
  connected: { text: "Подключено", cls: "bg-sage/15 text-sage" },
  paused: { text: "Выключено", cls: "bg-line text-dim" },
  needs_auth: { text: "Нужен вход", cls: "bg-coral/15 text-coral" },
  needs_setup: { text: "Нужна настройка", cls: "bg-amber/15 text-amber" },
  soon: { text: "Скоро", cls: "bg-line text-dim" },
  available: null,
};

export function StatePill({ state }: { state: ConnectorState }) {
  const p = PILL[state];
  return p ? <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", p.cls)}>{p.text}</span> : null;
}

const ACTION: Record<ConnectorState, string> = {
  available: "Подключить",
  connected: "Настроить",
  paused: "Настроить",
  needs_auth: "Войти заново",
  needs_setup: "Подробнее",
  soon: "Скоро",
};

/** Карточка каталога: значок, название, описание, состояние и главное действие. Вся карточка открывает панель. */
export function ConnectorCard({ item, onOpen, onToggle, busy }: { item: CatalogItem; onOpen: () => void; onToggle: (v: boolean) => void; busy: boolean }) {
  const soon = item.state === "soon";
  const toggleable = item.state === "connected" || item.state === "paused";
  const writes = item.tools.filter((t) => t.kind === "write");
  const asks = writes.filter((t) => t.permission === "APPROVE").length;
  return (
    <article
      className={cn(
        "chat-in group relative flex flex-col gap-3.5 rounded-3xl border bg-sunken p-5 transition-all duration-200",
        soon ? "border-line opacity-60" : "border-line hover:-translate-y-0.5 hover:border-line-strong hover:bg-[#211f1b]",
        item.state === "connected" && "border-sage/25",
      )}
    >
      <div className="flex items-start gap-3.5">
        <ConnectorIcon letter={item.letter} color={item.color} />
        <div className="min-w-0 flex-1 pt-0.5">
          <h3 className="font-serif text-[20px] font-medium leading-tight">
            {/* Невидимая растянутая кнопка: вся карточка кликабельна, но выключатель остаётся отдельной целью */}
            <button type="button" onClick={onOpen} disabled={soon} className="text-left after:absolute after:inset-0 after:rounded-3xl focus-visible:outline-none focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-amber">
              {item.name}
            </button>
          </h3>
          <div className="text-[13px] text-dim">{item.vendor}</div>
        </div>
        {toggleable && (
          <div className="relative z-10 -mr-2 -mt-2">
            <Switch label={`${item.name}: включено`} checked={item.state === "connected"} disabled={busy} onChange={onToggle} />
          </div>
        )}
      </div>
      <p className="line-clamp-2 min-h-[2.8em] text-[14px] leading-snug text-soft">{item.description}</p>
      <div className="mt-auto flex flex-wrap items-center gap-2.5">
        <StatePill state={item.state} />
        {item.state === "connected" && item.account && <span className="min-w-0 truncate text-[13px] text-dim">{item.account}</span>}
        {item.state === "connected" && !item.account && writes.length > 0 && (
          <span className="flex items-center gap-1 text-[13px] text-dim">
            <Lock size={12} aria-hidden="true" />
            {asks === writes.length ? "всё на вашем подтверждении" : `${writes.length - asks} из ${writes.length} без вопроса`}
          </span>
        )}
        <span
          className={cn(
            "ml-auto rounded-full px-4 py-2 text-[13px] font-semibold transition-colors",
            item.state === "available" ? "bg-amber text-[#1b1305]" : "border border-line-strong text-soft group-hover:text-foreground",
            soon && "border-line text-dim",
          )}
          aria-hidden="true"
        >
          {ACTION[item.state]}
        </span>
      </div>
    </article>
  );
}
