"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, X } from "lucide-react";
import { ConnectorIcon } from "./connector-card";

export interface MissingConnector {
  name: string;
  letter: string;
  color: string;
}

/**
 * Полоса под полем ввода (SPEC 1.1, п. 3): пока не подключены почта и календарь, помощник работает
 * на демо-данных и говорит об этом прямо. Скрытие помнится в браузере, но не дольше суток.
 */
export function ConnectStrip({ leaderId, missing, label, short }: { leaderId: string; missing: MissingConnector[]; label: string; /** Для узкого экрана: одна строка. */ short: string }) {
  const key = `connect-strip:${leaderId}`;
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    let at = 0;
    try {
      at = Number(localStorage.getItem(key) ?? 0);
    } catch {
      // хранилище недоступно: просто показываем
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- читаем localStorage только на клиенте
    setHidden(Date.now() - at < 24 * 3600_000);
  }, [key]);

  if (hidden || missing.length === 0) return null;
  return (
    <div className="flex items-center gap-2.5 rounded-2xl border border-line bg-sunken/80 py-1.5 pl-3 pr-1.5 text-[13px] text-soft">
      <span className="flex shrink-0 -space-x-1.5" aria-hidden="true">
        {missing.slice(0, 4).map((m) => (
          <span key={m.name} className="rounded-md ring-2 ring-sunken">
            <ConnectorIcon letter={m.letter} color={m.color} size={20} />
          </span>
        ))}
      </span>
      <Link href="/connectors" className="flex min-h-9 min-w-0 flex-1 items-center gap-1.5 transition-colors hover:text-foreground">
        <span className="min-w-0 truncate sm:hidden">{short}</span>
        <span className="hidden min-w-0 sm:inline">{label}</span>
        <ArrowRight size={14} className="shrink-0 text-amber" />
      </Link>
      <button
        type="button"
        aria-label="Скрыть на сегодня"
        onClick={() => {
          try {
            localStorage.setItem(key, String(Date.now()));
          } catch {
            // не запомнили — скроем до перезагрузки
          }
          setHidden(true);
        }}
        className="flex size-9 shrink-0 items-center justify-center rounded-full text-dim transition-colors hover:bg-raised hover:text-foreground"
      >
        <X size={16} />
      </button>
    </div>
  );
}
