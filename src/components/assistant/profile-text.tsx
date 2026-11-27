import type { ReactNode } from "react";

/** **жирный** и `код` внутри строки. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i} className="font-medium text-foreground">{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <span key={i} className="text-foreground">{part.slice(1, -1)}</span>;
    return part;
  });
}

type Block = { kind: "h"; text: string } | { kind: "p"; text: string } | { kind: "ul" | "ol"; items: string[] };

function parse(markdown: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || /^# /.test(line)) continue; // заголовок страницы уже есть
    const h = /^#{2,6}\s+(.*)$/.exec(line);
    const ul = /^[-*]\s+(.*)$/.exec(line);
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    const last = blocks[blocks.length - 1];
    if (h) blocks.push({ kind: "h", text: h[1] });
    else if (ul || ol) {
      const kind = ul ? "ul" : "ol";
      const text = (ul ?? ol)![1];
      if (last && last.kind === kind) last.items.push(text);
      else blocks.push({ kind, items: [text] });
    } else blocks.push({ kind: "p", text: line });
  }
  return blocks;
}

/** Профиль только для чтения: markdown как аккуратный текст. Править его просят в чате. */
export function ProfileText({ markdown }: { markdown: string }) {
  const blocks = parse(markdown);
  if (blocks.length === 0) return <p className="text-dim">Профиль пока пуст.</p>;
  return (
    <div className="flex flex-col gap-3 text-[15px] leading-relaxed text-soft">
      {blocks.map((b, i) => {
        if (b.kind === "h") return <h3 key={i} className={`font-serif text-xl font-medium text-foreground ${i > 0 ? "mt-4" : ""}`}>{b.text}</h3>;
        if (b.kind === "p") return <p key={i}>{inline(b.text)}</p>;
        const Tag = b.kind;
        return (
          <Tag key={i} className={`flex flex-col gap-1.5 pl-5 ${b.kind === "ol" ? "list-decimal" : "list-disc"} marker:text-dim`}>
            {b.items.map((it, k) => <li key={k}>{inline(it)}</li>)}
          </Tag>
        );
      })}
    </div>
  );
}
