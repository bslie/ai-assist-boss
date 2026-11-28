import { describe, expect, it } from "vitest";
import { defaultCriteria, sanitizeCriteria } from "@/core/tasks/criteria";

describe("критерий готовности: отговорка модели не доходит до сотрудника", () => {
  it("отговорка заменяется критерием по умолчанию", () => {
    const title = "Подготовить сводку по возвратам";
    for (const refusal of [
      "В тексте письма отсутствует описание формата. Невозможно сформулировать измеримый результат.",
      "Недостаточно данных для критерия.",
      "Не хватает информации о сроке и формате.",
      "",
    ]) {
      expect(sanitizeCriteria(refusal, title)).toBe(defaultCriteria(title));
    }
  });

  it("нормальный критерий остаётся как есть", () => {
    const ok = "Сводка по возвратам за ноябрь отправлена руководителю: таблица с причинами и суммами.";
    expect(sanitizeCriteria(`  ${ok} `, "Сводка")).toBe(ok);
    expect(sanitizeCriteria("Клиенту отправлено сообщение, где указан контакт поддержки.", "Ответ")).toContain("указан контакт");
  });
});
