/**
 * Минимальный разбор markdown из ответов модели в чате: абзацы, нумерованные и маркированные списки, заголовки (как жирная строка),
 * **жирный** и `код`. Без HTML: результат — данные, а отрисовывает их React-компонент (нет места для вставки разметки).
 */
export type Inline = { kind: "text" | "bold" | "code"; text: string };
export type ChatBlock =
  | { kind: "p"; lines: Inline[][] }
  | { kind: "ol" | "ul"; items: Inline[][] };

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  for (const part of src.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/)) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) out.push({ kind: "bold", text: part.slice(2, -2) });
    else if (part.startsWith("`") && part.endsWith("`") && part.length > 2) out.push({ kind: "code", text: part.slice(1, -1) });
    else out.push({ kind: "text", text: part });
  }
  return out;
}

export function parseChat(src: string): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  let list: { kind: "ol" | "ul"; items: Inline[][] } | null = null;
  let para: Inline[][] | null = null;
  const flush = () => {
    if (list) blocks.push(list);
    if (para) blocks.push({ kind: "p", lines: para });
    list = null;
    para = null;
  };

  for (const raw of src.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    const ul = /^[-*•]\s+(.*)$/.exec(line);
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (ol || ul) {
      const kind = ol ? "ol" : "ul";
      if (para || (list && list.kind !== kind)) flush();
      list ??= { kind, items: [] };
      list.items.push(parseInline((ol ?? ul)![1]!));
      continue;
    }
    // Строка после пункта списка без маркера — продолжение пункта (модель переносит длинные пункты).
    if (list && !heading) {
      const items = list.items;
      items[items.length - 1] = [...items[items.length - 1]!, { kind: "text", text: ` ${line}` }];
      continue;
    }
    if (list) flush();
    para ??= [];
    para.push(heading ? [{ kind: "bold", text: heading[1]! }] : parseInline(line));
  }
  flush();
  return blocks;
}
