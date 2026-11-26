"use client";

import { useCallback, useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";
import { ConnectorCard } from "@/components/assistant/connector-card";
import { ConnectorDrawer, type Api } from "@/components/assistant/connector-drawer";
import type { CatalogItem } from "@/core/connectors/service";
import { cn } from "@/lib/utils";

type Filter = "all" | "connected" | "attention" | string;

/** Каталог подключений: поиск, фильтры, карточки, панель настройки. Список строится из манифестов модулей. */
export function ConnectorsCatalog({ leaderId, initial, banner }: { leaderId: string; initial: CatalogItem[]; banner?: { ok: boolean; text: string } | null }) {
  const [items, setItems] = useState(initial);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(banner ?? null);

  const api: Api = useCallback(async (path, init) => {
    try {
      const res = await fetch(path, {
        method: init?.method ?? "GET",
        headers: init?.body ? { "content-type": "application/json" } : undefined,
        body: init?.body ? JSON.stringify(init.body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, data } as never;
    } catch {
      return { ok: false, data: { error: "Нет связи с сервером" } } as never;
    }
  }, []);

  const reload = useCallback(
    async (select?: string) => {
      const r = await api<{ items: CatalogItem[] }>(`/api/connectors?leaderId=${encodeURIComponent(leaderId)}`);
      if (r.ok) {
        setItems(r.data.items);
        if (select) setOpenKey(select);
      }
    },
    [api, leaderId],
  );

  const categories = useMemo(() => [...new Set(items.map((i) => i.category))], [items]);
  const connectedCount = items.filter((i) => i.state === "connected" || i.state === "paused").length;
  const attention = items.filter((i) => i.state === "needs_auth").length;

  const visible = items.filter((i) => {
    const q = query.trim().toLowerCase();
    if (q && !`${i.name} ${i.vendor} ${i.description}`.toLowerCase().includes(q)) return false;
    if (filter === "connected") return i.state === "connected" || i.state === "paused";
    if (filter === "attention") return i.state === "needs_auth";
    if (filter !== "all") return i.category === filter;
    return true;
  });
  const mine = visible.filter((i) => i.connectorId);
  const rest = visible.filter((i) => !i.connectorId);
  const open = items.find((i) => i.key === openKey) ?? null;
  const template = items.find((i) => i.moduleId === "REMOTE_MCP" && !i.connectorId);

  async function toggle(item: CatalogItem, v: boolean) {
    setBusyKey(item.key);
    const r = await api(`/api/connectors/${item.connectorId}?leaderId=${encodeURIComponent(leaderId)}`, { method: "PATCH", body: { isActive: v } });
    setBusyKey(null);
    setToast(r.ok ? { ok: true, text: `${item.name}: ${v ? "включено" : "выключено"}` } : { ok: false, text: r.data.error ?? "Не получилось" });
    if (r.ok) await reload();
    setTimeout(() => setToast(null), 3000);
  }

  const chip = (id: Filter, label: string, count?: number) => (
    <button
      key={id}
      type="button"
      aria-pressed={filter === id}
      onClick={() => setFilter(id)}
      className={cn(
        "min-h-10 shrink-0 whitespace-nowrap rounded-full border px-4 text-[14px] transition-colors",
        filter === id ? "border-transparent bg-foreground font-medium text-ink" : "border-line-strong text-soft hover:text-foreground",
      )}
    >
      {label}
      {count !== undefined && count > 0 && <span className={cn("ml-1.5 text-xs", filter === id ? "text-ink/60" : "text-dim")}>{count}</span>}
    </button>
  );

  const grid = (list: CatalogItem[]) => (
    <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
      {list.map((i) => (
        <ConnectorCard key={i.key} item={i} busy={busyKey === i.key} onOpen={() => setOpenKey(i.key)} onToggle={(v) => toggle(i, v)} />
      ))}
    </div>
  );

  return (
    <>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="relative min-w-0 flex-[1_1_260px]">
            <span className="sr-only">Поиск по подключениям</span>
            <Search size={17} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-dim" aria-hidden="true" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Найти сервис"
              className="min-h-12 w-full rounded-full border border-line-strong bg-raised pl-11 pr-4 outline-none transition-colors placeholder:text-dim focus:border-amber/70"
            />
          </label>
          {template && (
            <button type="button" onClick={() => setOpenKey(template.key)} className="flex min-h-12 items-center gap-2 rounded-full border border-line-strong px-5 text-[14px] font-medium text-soft transition-colors hover:border-amber/60 hover:text-foreground">
              <Plus size={16} aria-hidden="true" />
              Свой MCP-сервер
            </button>
          )}
        </div>
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0" role="group" aria-label="Фильтр">
          {chip("all", "Все")}
          {chip("connected", "Подключено", connectedCount)}
          {attention > 0 && chip("attention", "Нужен вход", attention)}
          {categories.map((c) => chip(c, c))}
        </div>
      </div>

      {toast && (
        <div role="status" className={cn("chat-in rounded-2xl px-4 py-3 text-[14px]", toast.ok ? "bg-sage/15 text-sage" : "bg-[#2a1a18] text-coral")}>
          {toast.text}
        </div>
      )}

      {visible.length === 0 && (
        <div className="rounded-3xl border border-dashed border-line-strong p-8 text-center text-dim">
          Ничего не нашлось. Нужного сервиса нет в списке? Подключите его как свой MCP-сервер.
        </div>
      )}

      {mine.length > 0 && (
        <section aria-labelledby="mine" className="flex flex-col gap-4">
          <h2 id="mine" className="font-serif text-[24px] font-medium">Мои подключения</h2>
          {grid(mine)}
        </section>
      )}
      {rest.length > 0 && (
        <section aria-labelledby="rest" className="flex flex-col gap-4">
          <h2 id="rest" className="font-serif text-[24px] font-medium">{mine.length ? "Можно добавить" : "Каталог"}</h2>
          {grid(rest)}
        </section>
      )}

      <ConnectorDrawer item={open} leaderId={leaderId} api={api} onClose={() => setOpenKey(null)} onChanged={reload} />
    </>
  );
}
