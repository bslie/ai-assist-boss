import { describe, expect, it } from "vitest";
import { isAcknowledgement } from "@/core/telegram/business";

describe("isAcknowledgement", () => {
  it.each(["ок", "Ок, спасибо!", "принял", "Понял, спасибо", "👍", "хорошо."])("«%s» — подтверждение", (t) => {
    expect(isAcknowledgement(t)).toBe(true);
  });
  it.each(["ок, но не успею", "принял, когда срок?", "спасибо, а что с отчётом", "Подскажи, когда будет готов отчёт?", "да?", "согласуйте отпуск"])("«%s» — не подтверждение", (t) => {
    expect(isAcknowledgement(t)).toBe(false);
  });
});
