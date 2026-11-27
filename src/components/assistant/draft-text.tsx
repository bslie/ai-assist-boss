"use client";

import { useState, type ReactNode } from "react";
import { splitPlaceholders } from "@/core/draft-placeholders";
import { cn } from "@/lib/utils";

type Block =
  | { kind: "h1" | "h2" | "h3" | "p"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][] };

const isRow = (l: string) => l.length > 1 && l.startsWith("|") && l.endsWith("|");
const cells = (l: string) => l.slice(1, -1).split("|").map((c) => c.trim());
const isSeparator = (l: string) => isRow(l) && cells(l).every((c) => /^:?-{2,}:?$/.test(c));

/** Минимальный разбор markdown-черновика: заголовки #/##/###, списки «- », абзацы. Без HTML, только React-элементы. */
function parse(src: string): Block[] {
  const out: Block[] = [];
  for (const raw of src.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (isRow(line)) {
      if (isSeparator(line)) continue;
      const last = out[out.length - 1];
      if (last?.kind === "table") last.rows.push(cells(line));
      else out.push({ kind: "table", head: cells(line), rows: [] });
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ kind: (["h1", "h2", "h3"] as const)[h[1].length - 1], text: h[2] });
      continue;
    }
    const li = /^[-*•]\s+(.*)$/.exec(line);
    if (li) {
      const last = out[out.length - 1];
      if (last?.kind === "ul") last.items.push(li[1]);
      else out.push({ kind: "ul", items: [li[1]] });
      continue;
    }
    out.push({ kind: "p", text: line });
  }
  return out;
}

/** Пропуск «[срок]» подсвечен: его нужно вписать до отправки (см. `core/draft-placeholders`). */
function withGaps(text: string, key: number): ReactNode {
  const parts = splitPlaceholders(text);
  if (parts.length === 1 && !parts[0].gap) return text;
  return parts.map((p, k) =>
    p.gap ? (
      <mark key={`${key}-${k}`} className="rounded bg-amber/20 px-1 font-sans text-[0.9em] text-amber">
        {p.text}
      </mark>
    ) : (
      p.text
    ),
  );
}

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong> : withGaps(part, i),
  );
}

const COLLAPSE_AFTER = 900;

/** Черновик документа или письма: читаемая структура, длинные тексты свёрнуты с кнопкой «Показать целиком». */
export function DraftText({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  const blocks = parse(text);
  const long = text.length > COLLAPSE_AFTER;
  const clamped = long && !full;

  return (
    <div>
      <div className={cn("relative flex flex-col gap-2.5 font-serif text-[16px] leading-normal", clamped && "max-h-72 overflow-hidden")}>
        {blocks.map((b, i) => {
          switch (b.kind) {
            case "h1":
              return <div key={i} className="text-[20px] font-medium leading-tight">{inline(b.text)}</div>;
            case "h2":
              return <div key={i} className="mt-2 border-t border-line pt-3 font-sans text-xs font-medium uppercase tracking-[0.08em] text-dim">{inline(b.text)}</div>;
            case "h3":
              return <div key={i} className="mt-1 font-sans text-[14px] font-semibold text-foreground">{inline(b.text)}</div>;
            case "ul":
              return (
                <ul key={i} className="flex flex-col gap-1 pl-1 text-soft">
                  {b.items.map((it, k) => (
                    <li key={k} className="flex gap-2.5">
                      <span aria-hidden="true" className="mt-[0.6em] size-[5px] shrink-0 rounded-full bg-amber" />
                      <span className="min-w-0">{inline(it)}</span>
                    </li>
                  ))}
                </ul>
              );
            case "table":
              // Строка таблицы становится карточкой: первая колонка — заголовок, остальные — подписанные поля.
              return (
                <div key={i} className="flex flex-col gap-2">
                  {b.rows.map((r, k) => (
                    <div key={k} className="rounded-xl border border-line bg-sunken/60 px-3.5 py-3">
                      <div className="text-[16px] text-foreground">{inline(r[0] ?? "")}</div>
                      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-sans text-[13px]">
                        {r.slice(1).map((v, c) => (
                          <div key={c} className="contents">
                            <dt className="text-dim">{b.head[c + 1]}</dt>
                            <dd className="min-w-0 text-soft">{inline(v)}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  ))}
                </div>
              );
            default:
              return <p key={i} className="text-soft">{inline(b.text)}</p>;
          }
        })}
        {clamped && <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-ink to-transparent" />}
      </div>
      {long && (
        <button type="button" onClick={() => setFull(!full)} className="mt-2 min-h-9 font-sans text-[13px] text-amber transition-colors hover:text-foreground">
          {full ? "Свернуть" : "Показать целиком"}
        </button>
      )}
    </div>
  );
}
