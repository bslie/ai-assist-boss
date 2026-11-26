import { describe, expect, it } from "vitest";
import { groupThreads, threadKey } from "@/core/email-triage/threads";

const d = (m: number) => new Date(Date.UTC(2026, 11, 7, 8, m));

describe("threadKey / groupThreads", () => {
  it("игнорирует регистр, пробелы и Re:/Fwd:", () => {
    expect(threadKey("A@x.ru", "Re: Fwd:  Регламент", "Привет,   мир")).toBe(
      threadKey("a@x.ru", "регламент", "привет, мир"),
    );
  });

  it("разный отправитель или текст — разные треды", () => {
    expect(threadKey("a@x.ru", "s", "b")).not.toBe(threadKey("b@x.ru", "s", "b"));
    expect(threadKey("a@x.ru", "s", "b")).not.toBe(threadKey("a@x.ru", "s", "c"));
  });

  it("считает occurrence и сохраняет все письма", () => {
    const mk = (id: string, m: number, body = "напоминаю") => ({
      externalId: id, senderEmail: "pavlova@x.ru", subject: "Регламент", body, receivedAt: d(m),
    });
    const out = groupThreads([mk("m3", 3), mk("m1", 1), mk("m2", 2), mk("m4", 4, "другое")]);
    expect(out).toHaveLength(4);
    expect(out.map((o) => o.occurrence)).toEqual([1, 2, 3, 1]);
    expect(new Set(out.map((o) => o.threadKey)).size).toBe(2);
  });
});
