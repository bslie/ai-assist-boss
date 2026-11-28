import { Fragment, type ReactNode } from "react";
import { parseChat, type Inline } from "@/lib/chat-markdown";

const inline = (parts: Inline[]): ReactNode =>
  parts.map((p, i) =>
    p.kind === "bold" ? (
      <strong key={i} className="font-semibold">{p.text}</strong>
    ) : p.kind === "code" ? (
      <code key={i} className="rounded bg-ink px-1.5 py-0.5 font-mono text-[13px]">{p.text}</code>
    ) : (
      <Fragment key={i}>{p.text}</Fragment>
    ),
  );

/** Ответ помощника в чате: markdown модели показываем как текст со списками и выделением, а не со звёздочками. */
export function ChatText({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2.5 break-words leading-relaxed">
      {parseChat(text).map((b, i) =>
        b.kind === "p" ? (
          <p key={i}>
            {b.lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l)}
              </Fragment>
            ))}
          </p>
        ) : b.kind === "ol" ? (
          <ol key={i} className="flex list-decimal flex-col gap-1.5 pl-6 marker:text-dim">
            {b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}
          </ol>
        ) : (
          <ul key={i} className="flex list-disc flex-col gap-1.5 pl-6 marker:text-dim">
            {b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}
          </ul>
        ),
      )}
    </div>
  );
}
