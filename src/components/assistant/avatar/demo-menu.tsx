"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

const INPUT = "min-h-9 w-full rounded-lg border border-line-strong bg-ink px-3 text-[13px] outline-none focus-visible:border-amber/70";
const ZOOM_DEFAULT = "https://us02web.zoom.us/j/84217650931?pwd=demo";

type Json = Record<string, unknown>;

async function post(url: string, body: Json): Promise<{ ok: true; data: Json } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) return { ok: false, error: typeof j.error === "string" ? j.error : `Ошибка ${res.status}` };
    return { ok: true, data: j };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Меню демо по клику на маскота. Только для администратора (API это проверяет): действия пишут в БД руководителя
 * и тратят бюджет модели. Всё, что уходит наружу, идёт обычными путями через Policy Gate и карточки.
 */
export function DemoMenu({ leaderId, onClose }: { leaderId: string; onClose: () => void }) {
  const router = useRouter();
  const q = `leaderId=${encodeURIComponent(leaderId)}`;
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; bad?: boolean } | null>(null);
  const [tgText, setTgText] = useState("Что на сегодня?");
  const [count, setCount] = useState("5");
  const [title, setTitle] = useState("Созвон по статусу проекта");
  const [zoom, setZoom] = useState(ZOOM_DEFAULT);
  const [startIn, setStartIn] = useState("10");
  const panel = useRef<HTMLDivElement>(null);

  // Закрываем по Escape и по клику вне панели (клик по самому маскоту обрабатывает он сам).
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const click = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (panel.current && t && !panel.current.contains(t) && !t.closest("[data-demo-trigger]")) onClose();
    };
    document.addEventListener("keydown", key);
    document.addEventListener("mousedown", click);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("mousedown", click);
    };
  }, [onClose]);

  async function run(id: string, label: string, url: string, body: Json, done: (d: Json) => string) {
    if (busy) return;
    setBusy(id);
    setStatus({ text: `${label}…` });
    const r = await post(url, body);
    setBusy(null);
    if (r.ok) {
      setStatus({ text: done(r.data) });
      router.refresh();
    } else setStatus({ text: `${label}: ${r.error}`, bad: true });
  }

  const stage = (id: string, label: string, body: Json, done: (d: Json) => string) => run(id, label, `/api/demo/stage?${q}`, body, done);
  const sim = (id: string, label: string, scenario: string, done: (d: Json) => string = () => `Готово: ${label}`) => run(id, label, `/api/demo/simulate?${q}`, { scenario }, done);
  const clock = (id: string, label: string, body: Json) => run(id, `Часы: ${label}`, "/api/demo/clock", body, () => `Часы: ${label}`);

  const n = Number(count);
  const mins = Number(startIn);

  return (
    <div
      ref={panel}
      role="dialog"
      aria-label="Управление демо"
      className="fixed bottom-44 right-6 z-40 flex max-h-[min(78vh,640px)] w-[340px] max-w-[calc(100vw-2rem)] flex-col gap-4 overflow-y-auto rounded-[20px] border border-line-strong bg-raised p-4 text-[13px] shadow-2xl"
    >
      <div className="flex items-center justify-between">
        <div className="font-serif text-[19px]">Управление демо</div>
        <button type="button" onClick={onClose} className="rounded-full px-2 py-1 text-dim hover:text-soft" aria-label="Закрыть">×</button>
      </div>

      <section className="flex flex-col gap-2">
        <div className="text-xs text-dim">1. Написали в Telegram, бот ответил</div>
        <input aria-label="Вопрос боту" className={INPUT} value={tgText} onChange={(e) => setTgText(e.target.value)} />
        <Button className="h-9 rounded-full" disabled={!!busy || !tgText.trim()} onClick={() => stage("tg", "Telegram", { action: "TELEGRAM", text: tgText.trim() }, () => "Вопрос ушёл боту, ответ придёт в Telegram")}>
          Спросить бота в Telegram
        </Button>
      </section>

      <section className="flex flex-col gap-2">
        <div className="text-xs text-dim">2. Написали на почту N писем</div>
        <div className="flex gap-2">
          <input aria-label="Сколько писем" type="number" min={1} max={20} className={`${INPUT} w-20`} value={count} onChange={(e) => setCount(e.target.value)} />
          <Button className="h-9 flex-1 rounded-full" disabled={!!busy || !(n >= 1 && n <= 20)} onClick={() => stage("mail", "Письма", { action: "EMAILS", count: Math.floor(n) }, (d) => `Разобрано писем: ${String(d.ingested)}, карточек: ${String(d.decisions)}, в запасе ещё ${String(d.left)}`)}>
            Прислать письма
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div className="text-xs text-dim">3. Поставили встречу в календарь с Zoom</div>
        <input aria-label="Название встречи" className={INPUT} value={title} onChange={(e) => setTitle(e.target.value)} />
        <input aria-label="Ссылка на Zoom" className={INPUT} value={zoom} onChange={(e) => setZoom(e.target.value)} />
        <div className="flex items-center gap-2">
          <span className="text-dim">Начало через</span>
          <input aria-label="Через сколько минут начало" type="number" min={1} max={1440} className={`${INPUT} w-20`} value={startIn} onChange={(e) => setStartIn(e.target.value)} />
          <span className="text-dim">мин</span>
        </div>
        <Button className="h-9 rounded-full" disabled={!!busy || !title.trim() || !zoom.trim() || !(mins >= 1)} onClick={() => stage("meet", "Встреча", { action: "MEETING", title: title.trim(), zoomUrl: zoom.trim(), startInMinutes: Math.floor(mins) }, (d) => `Встреча в плане дня (${String(d.platform)}). Календарь: ${String(d.calendar)}`)}>
          Поставить встречу
        </Button>
      </section>

      <section className="flex flex-col gap-2">
        <div className="text-xs text-dim">Ещё сценарии</div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="h-8 rounded-full px-3" disabled={!!busy} onClick={() => sim("morning", "Утренний план", "TRIGGER_MORNING")}>Утренний план</Button>
          <Button variant="outline" className="h-8 rounded-full px-3" disabled={!!busy} onClick={() => sim("proto", "Протокол встречи", "RUN_MEETING_TRANSCRIPT")}>Протокол встречи</Button>
          <Button variant="outline" className="h-8 rounded-full px-3" disabled={!!busy} onClick={() => sim("week", "Итог недели", "TRIGGER_WEEKLY")}>Итог недели</Button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div className="text-xs text-dim">Демо-часы</div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="h-8 rounded-full px-3" disabled={!!busy} onClick={() => clock("c30", "+30 мин", { advanceMinutes: 30 })}>+30 мин</Button>
          <Button variant="outline" className="h-8 rounded-full px-3" disabled={!!busy} onClick={() => clock("c1d", "+1 день", { advanceMinutes: 60 * 24 })}>+1 день</Button>
          <Button variant="outline" className="h-8 rounded-full px-3" disabled={!!busy} onClick={() => clock("c0", "сброс", { reset: true })}>Сбросить</Button>
        </div>
      </section>

      <div role="status" aria-live="polite" className={`min-h-5 text-[12.5px] ${status?.bad ? "text-coral" : "text-sage"}`}>{status?.text ?? ""}</div>
    </div>
  );
}
