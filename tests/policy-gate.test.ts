import { describe, expect, it } from "vitest";
import { evaluate, type GateContext } from "@/core/policy-gate";

const leader = { budgetAutoLimit: 0, protectedBlocks: ["Стратегия", "1:1"] };
const risk = {
  leaderEmail: "boss@corp.ru",
  org: [{ email: "hr@corp.ru", position: "HR-партнёр", relationType: "PEER" as const }],
};
const base = (over: Partial<GateContext> = {}): GateContext => ({
  leader,
  risk,
  category: "STATUS",
  confidence: 0.95,
  toolPermission: "AUTO",
  ...over,
});
const msg = (subject: string, body = "", senderEmail = "a@corp.ru") => ({ senderEmail, subject, body });

describe("policy gate", () => {
  it("разрешает безобидное действие с AUTO", () => {
    expect(evaluate("archive", base({ message: msg("Статус недели", "всё хорошо") })).verdict).toBe("ALLOW");
  });

  it("защищённые категории всегда APPROVE", () => {
    for (const category of ["HR", "MANAGEMENT", "CLIENT_COMMITMENT"]) {
      expect(evaluate("send", base({ category })).verdict).toBe("APPROVE");
    }
  });

  it("низкая уверенность → APPROVE", () => {
    expect(evaluate("send", base({ confidence: 0.5 })).verdict).toBe("APPROVE");
  });

  it("жёсткий сигнал перебивает категорию LLM", () => {
    const r = evaluate("send", base({ message: msg("Заявление", "прошу отпуск"), category: "STATUS" }));
    expect(r.verdict).toBe("APPROVE");
    expect(r.signals).toContain("HR_TERMS");
  });

  it("деньги при лимите 0 — всегда APPROVE", () => {
    expect(evaluate("send", base({ category: "MONEY", amount: 100 })).verdict).toBe("APPROVE");
  });

  it("деньги ниже лимита разрешены, выше — нет, без суммы — нет", () => {
    const l = { ...leader, budgetAutoLimit: 5000 };
    expect(evaluate("send", base({ leader: l, category: "MONEY", amount: 4000 })).verdict).toBe("ALLOW");
    expect(evaluate("send", base({ leader: l, category: "MONEY", amount: 9000 })).verdict).toBe("APPROVE");
    expect(evaluate("send", base({ leader: l, category: "MONEY", amount: null })).verdict).toBe("APPROVE");
  });

  it("защищённая категория не снимается лимитом", () => {
    const l = { ...leader, budgetAutoLimit: 1_000_000 };
    expect(evaluate("send", base({ leader: l, category: "HR", amount: 1 })).verdict).toBe("APPROVE");
  });

  it("защищённый блок календаря → APPROVE", () => {
    expect(evaluate("move", base({ calendarSlotTitle: "Стратегия Q1" })).verdict).toBe("APPROVE");
  });

  it("DENY инструмента сильнее всего; нет записи прав → APPROVE", () => {
    expect(evaluate("delete", base({ toolPermission: "DENY" })).verdict).toBe("DENY");
    expect(evaluate("new_tool", base({ toolPermission: null })).verdict).toBe("APPROVE");
  });

  it("режим тени превращает ALLOW в APPROVE", () => {
    expect(evaluate("archive", base({ leader: { ...leader, shadowMode: true } })).verdict).toBe("APPROVE");
  });

  it("письмо без категории — fail closed", () => {
    expect(evaluate("send", base({ message: msg("x"), category: null })).verdict).toBe("APPROVE");
  });
});
