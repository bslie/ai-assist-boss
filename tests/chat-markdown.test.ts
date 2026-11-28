import { describe, expect, it } from "vitest";
import { parseChat, parseInline } from "@/lib/chat-markdown";

describe("разбор markdown в чате", () => {
  it("жирный и код выделяются, звёздочек в тексте не остаётся", () => {
    expect(parseInline("Это **важно** и `код`")).toEqual([
      { kind: "text", text: "Это " },
      { kind: "bold", text: "важно" },
      { kind: "text", text: " и " },
      { kind: "code", text: "код" },
    ]);
    expect(parseInline("2 * 3 = 6")).toEqual([{ kind: "text", text: "2 * 3 = 6" }]);
  });

  it("ответ из жизни: абзац, нумерованный список с жирным, вопрос в конце", () => {
    const src = "Сергей, три шага:\n\n1. **Маршрутизация.** Назначать за 15 минут.\n2. **Шаблоны.** Топ-10 вопросов.\n3. **Контроль.** Алерты.\n\nХотите, поставлю задачу?";
    const b = parseChat(src);
    expect(b.map((x) => x.kind)).toEqual(["p", "ol", "p"]);
    const ol = b[1]!;
    expect(ol.kind === "ol" && ol.items).toHaveLength(3);
    expect(JSON.stringify(b)).not.toContain("**");
  });

  it("маркированный список, продолжение пункта и заголовок", () => {
    const b = parseChat("## План\n- первое\nпродолжение\n- второе");
    expect(b.map((x) => x.kind)).toEqual(["p", "ul"]);
    const ul = b[1]!;
    expect(ul.kind === "ul" && ul.items[0]!.map((p) => p.text).join("")).toBe("первое продолжение");
  });

  it("HTML остаётся обычным текстом: разметка не вставляется", () => {
    const b = parseChat("<script>alert(1)</script> **x**");
    expect(b[0]!.kind).toBe("p");
    expect(JSON.stringify(b)).toContain("<script>");
  });
});
