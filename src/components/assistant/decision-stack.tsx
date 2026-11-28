"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { findPlaceholders } from "@/core/draft-placeholders";
import { cn } from "@/lib/utils";
import { DraftText } from "./draft-text";
import type { DecisionCard, Tone } from "@/core/dashboard";

const TAG: Record<Tone, string> = {
  coral: "bg-coral text-[#2a0c08]",
  amber: "bg-amber text-[#1b1305]",
  sage: "bg-sage text-[#0b1e10]",
  dim: "bg-dim text-[#12110f]",
};

export interface Delegate {
  id: string;
  name: string;
  position: string;
}

type Mode = "idle" | "edit" | "delegate";
/** Как карточка уходит: решение утверждено (вправо, зелёный отсвет), передано (влево, янтарный) или отложено (вниз). */
type Exit = "approve" | "delegate" | "snooze";

const EXIT_MS = 360; // длительность card-out-* в globals.css
/** Что сказать после действия: без обещаний, чего мы не знаем (ушло ли письмо, решает политика и подключения). */
const doneText = (action: unknown, type: string): string =>
  action === "APPROVE" ? (type === "MEETING_PROTOCOL" ? "Протокол утверждён" : "Утверждено") : action === "EDITED_APPROVED" ? "Принят ваш вариант" : action === "DELEGATE" ? "Передано" : "Верну в утреннем плане";
const exitFor = (action: unknown): Exit => (action === "APPROVE" || action === "EDITED_APPROVED" ? "approve" : action === "DELEGATE" ? "delegate" : "snooze");

/** Стопка карточек решений. Действия уходят в POST /api/decisions/[id]/resolve. */
export function DecisionStack({ leaderId, decisions, delegates, firstRun = false }: { leaderId: string; decisions: DecisionCard[]; delegates: Delegate[]; /** Ничего не подключено и писем ещё не было: вместо «очередь пуста» зовём подключить почту и календарь (SPEC 1.1, п. 3). */ firstRun?: boolean }) {
  // Локально скрываем уже решённые, пока сервер не пришлёт обновлённый список (SSE → refresh).
  const [done, setDone] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<Mode>("idle");
  const [edited, setEdited] = useState("");
  const [delegateId, setDelegateId] = useState(delegates[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Короткое подтверждение сделанного: карточка исчезает, и без него непонятно, что нажатие сработало.
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (noticeTimer.current && clearTimeout(noticeTimer.current)), []);
  // Карточка, которая сейчас уезжает: после ответа сервера она проигрывает уход, и только потом показывается следующая.
  const [leaving, setLeaving] = useState<{ id: string; exit: Exit } | null>(null);
  // Карточка, с которой открыли страницу, не анимируем (её показывает общее вступление главной); все последующие въезжают.
  const [firstId] = useState(() => decisions[0]?.id);
  // Открыли правку: курсор в поле, первый пропуск «[срок]» уже выделен: достаточно набрать значение.
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = editor.current;
    if (mode !== "edit" || !el) return;
    el.focus();
    const gap = findPlaceholders(el.value)[0];
    const at = gap ? el.value.indexOf(gap) : -1;
    if (at >= 0) el.setSelectionRange(at, at + gap.length);
  }, [mode]);

  const queue = decisions.filter((d) => !done.has(d.id));
  const cur = queue[0];
  const total = decisions.length;
  const position = total - queue.length + 1;

  async function resolve(body: Record<string, unknown>) {
    if (!cur || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/decisions/${cur.id}/resolve?leaderId=${encodeURIComponent(leaderId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      // 409 — уже решено (другая вкладка/Telegram): тоже убираем карточку.
      if (!res.ok && res.status !== 409) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Ошибка ${res.status}`);
      }
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        setLeaving({ id: cur.id, exit: res.ok ? exitFor(body.action) : "snooze" });
        await new Promise((r) => setTimeout(r, EXIT_MS));
      }
      setDone((s) => new Set(s).add(cur.id));
      setLeaving(null);
      setMode("idle");
      setEdited("");
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      setNotice(res.ok ? doneText(body.action, cur.type) : "Это уже решено в другом месте");
      noticeTimer.current = setTimeout(() => setNotice(null), 4000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const noticeEl = notice ? (
    <div role="status" className="chat-in flex items-center gap-2 text-[14px] text-sage">
      <span aria-hidden className="size-1.5 rounded-full bg-sage" />
      {notice}
    </div>
  ) : null;

  if (!cur && firstRun) {
    return (
      <div className={cn("flex flex-col gap-4 rounded-[22px] border border-amber/40 bg-raised p-5 sm:p-7", firstId !== undefined && "card-in")}>
        <div className="font-serif text-[26px] font-medium leading-tight sm:text-[28px]">Подключите почту и календарь, и я начну работать.</div>
        <p className="text-soft">
          Пока мне нечего разбирать. Письма и встречи придут сюда карточками. Сначала я только читаю: ничего не отправляю и не меняю без вашего «да».
        </p>
        <Link href="/connectors" className={cn(buttonVariants(), "h-12 self-start rounded-full px-6 text-[15px] font-semibold")}>
          Подключить почту и календарь
          <ArrowRight aria-hidden className="size-4" />
        </Link>
      </div>
    );
  }

  if (!cur) {
    return (
      <div className="flex flex-col gap-3">
        {noticeEl}
        <div className={cn("flex flex-col gap-3 rounded-[22px] border border-dashed border-line-strong p-7", firstId !== undefined && "card-in")}>
          <div className="font-serif text-[28px] font-medium leading-tight">Очередь пуста. Спасибо, дальше я сама.</div>
          <div className="text-dim">Следующее письмо с защищённой темой я принесу сюда сразу.</div>
        </div>
      </div>
    );
  }

  const more = queue.length > 1;
  // «[срок]» в черновике: модель оставила его руководителю. Письмо с пропуском не отправляем, главная кнопка ведёт в правку.
  const isProtocol = cur.type === "MEETING_PROTOCOL";
  const gaps = isProtocol ? [] : findPlaceholders(cur.draft);
  const editedGaps = findPlaceholders(edited);
  const openEditor = () => {
    setEdited(cur.draft ?? "");
    setMode("edit");
  };
  return (
    <>
      {noticeEl && <div className="mb-3">{noticeEl}</div>}
    <div className="relative pb-5">
      {/* Подложки стопки: по одной на каждую ждущую карточку (до двух), плавно появляются и исчезают. */}
      <div aria-hidden className={cn("stack-layer absolute inset-x-5 bottom-0 h-10 rounded-b-[22px] border border-line bg-sunken", queue.length > 2 ? "stack-layer-on" : "stack-layer-off")} />
      <div aria-hidden className={cn("stack-layer absolute inset-x-2.5 bottom-2.5 h-10 rounded-b-[22px] border border-line bg-[#211f1b]", more ? "stack-layer-on" : "stack-layer-off")} />
      <article
        key={cur.id}
        data-avatar-anchor="decision-card"
        className={cn(
          "relative flex flex-col gap-4 rounded-[22px] border border-[#3d3931] bg-raised p-5 sm:gap-[18px] sm:p-7",
          leaving?.id === cur.id ? `card-out-${leaving.exit} pointer-events-none` : cur.id !== firstId && "card-in",
        )}
      >
        <div className="flex flex-wrap items-center gap-2.5">
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${TAG[cur.tone]}`}>{cur.tag}</span>
          {(cur.from || cur.when) && <span className="text-[13px] text-dim">{[cur.from, cur.when].filter(Boolean).join(" · ")}</span>}
          <span className="ml-auto text-[13px] text-dim">
            Решение {Math.min(position, total)} из {total}
          </span>
        </div>
        {cur.repeatNote && (
          <div className="rounded-[12px] border border-coral/40 bg-[#2a1a18] px-3.5 py-2.5 text-[13px] text-soft">{cur.repeatNote}</div>
        )}
        <h2 className="font-serif text-[23px] font-medium leading-tight tracking-tight sm:text-[28px]">{cur.title}</h2>
        <p className="whitespace-pre-line text-soft">{cur.summary}</p>

        {cur.draft && (
          <blockquote className="rounded-[14px] border border-line bg-ink px-[18px] py-4">
            <div className="mb-2 text-xs text-dim">{cur.declineDraft ? "Ответ, если согласны" : "Что я предлагаю"}</div>
            <DraftText text={cur.draft} />
          </blockquote>
        )}
        {cur.reasons.length > 0 && (
          <div className="flex flex-col gap-1 text-[13px] text-dim">
            <div>Почему я спрашиваю:</div>
            {cur.reasons.map((r) => (
              <div key={r} className="flex items-center gap-2">
                <span className="size-[7px] rounded-full bg-sage" />
                {r}
              </div>
            ))}
          </div>
        )}

        {mode === "edit" && (
          <div className="panel-in flex flex-col gap-2.5">
            <label htmlFor="edited" className="text-xs text-dim">Ваш вариант ответа</label>
            <textarea
              id="edited"
              ref={editor}
              value={edited}
              onChange={(e) => setEdited(e.target.value)}
              rows={Math.min(14, Math.max(4, edited.split("\n").length + 1))}
              className="rounded-[14px] border border-line-strong bg-ink p-3 font-serif text-[17px] outline-none focus-visible:border-amber/70"
            />
            {editedGaps.length > 0 && (
              <div className="text-[13px] text-amber">Впишите вместо {editedGaps.join(", ")}: с пропуском письмо не уйдёт.</div>
            )}
            <div className="flex gap-2.5">
              <Button className="h-11 rounded-full px-5 font-semibold" disabled={busy || !edited.trim() || editedGaps.length > 0} onClick={() => resolve({ action: "EDITED_APPROVED", editedText: edited.trim() })}>
                Отправить мой вариант
              </Button>
              <Button variant="ghost" className="h-11 rounded-full px-5 text-dim" onClick={() => setMode("idle")}>Отмена</Button>
            </div>
          </div>
        )}

        {mode === "delegate" && (
          <div className="panel-in flex flex-col gap-2.5">
            <label htmlFor="delegate" className="text-xs text-dim">Кому передать</label>
            <select id="delegate" value={delegateId} onChange={(e) => setDelegateId(e.target.value)} className="min-h-11 rounded-full border border-line-strong bg-ink px-4 outline-none">
              {delegates.map((d) => (
                <option key={d.id} value={d.id}>{d.name}, {d.position}</option>
              ))}
            </select>
            <div className="flex gap-2.5">
              <Button className="h-11 rounded-full px-5 font-semibold" disabled={busy || !delegateId} onClick={() => resolve({ action: "DELEGATE", delegateToId: delegateId })}>
                Передать
              </Button>
              <Button variant="ghost" className="h-11 rounded-full px-5 text-dim" onClick={() => setMode("idle")}>Отмена</Button>
            </div>
          </div>
        )}

        {error && <div role="alert" className="panel-in rounded-[14px] bg-[#2a1a18] px-3.5 py-2.5 text-[13px] text-coral">{error}</div>}

        {mode === "idle" && gaps.length > 0 && (
          <div className="panel-in rounded-[12px] border border-amber/40 bg-amber/10 px-3.5 py-2.5 text-[13px] text-soft">
            В черновике остался пропуск {gaps.join(", ")}: я не стала выдумывать значение. Впишите его, и письмо уйдёт.
          </div>
        )}

        {mode === "idle" && (
          <div className="panel-in grid grid-cols-3 gap-2 sm:flex sm:flex-wrap sm:gap-2.5">
            {isProtocol ? (
              <>
                <Button className="col-span-3 h-12 rounded-full px-6 font-semibold" disabled={busy} onClick={() => resolve({ action: "APPROVE", protocolRecipients: "ALL" })}>Утвердить и разослать всем</Button>
                <Button variant="outline" className="col-span-3 h-12 rounded-full px-5" disabled={busy} onClick={() => resolve({ action: "APPROVE", protocolRecipients: "IN_PROTOCOL" })}>Только исполнителям</Button>
              </>
            ) : cur.declineDraft ? (
              <>
                <Button className="col-span-3 h-12 rounded-full px-6 font-semibold sm:col-span-1" disabled={busy || gaps.length > 0} onClick={() => resolve({ action: "APPROVE" })}>Согласен</Button>
                <Button variant="outline" className="col-span-3 h-12 rounded-full px-6 sm:col-span-1" disabled={busy || findPlaceholders(cur.declineDraft).length > 0} onClick={() => resolve({ action: "EDITED_APPROVED", editedText: cur.declineDraft ?? "" })}>Отказать</Button>
                {gaps.length > 0 && (
                  <Button variant="ghost" className="col-span-3 h-12 rounded-full px-3 text-dim sm:col-span-1 sm:px-5" disabled={busy} onClick={openEditor}>Вписать {gaps[0]}</Button>
                )}
              </>
            ) : gaps.length > 0 ? (
              <Button className="col-span-3 h-12 rounded-full px-6 font-semibold" disabled={busy} onClick={openEditor}>Вписать {gaps[0]}</Button>
            ) : (
              <Button className="col-span-3 h-12 rounded-full px-6 font-semibold" disabled={busy} onClick={() => resolve({ action: "APPROVE" })}>Утвердить</Button>
            )}
            {gaps.length === 0 && (
              <Button variant="outline" className="h-12 rounded-full px-3 sm:px-5" disabled={busy} onClick={openEditor}>Поправить</Button>
            )}
            <Button variant="outline" className="h-12 rounded-full px-3 sm:px-5" disabled={busy || delegates.length === 0} onClick={() => setMode("delegate")}>Передать</Button>
            <Button variant="ghost" className="h-12 rounded-full px-3 text-dim sm:px-5" disabled={busy} onClick={() => resolve({ action: "SNOOZE" })}>Не сейчас</Button>
          </div>
        )}
      </article>
    </div>
    </>
  );
}
