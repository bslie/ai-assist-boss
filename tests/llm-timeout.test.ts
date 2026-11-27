import { describe, expect, it } from "vitest";
import { llmTimeoutMs } from "@/core/llm/providers";

describe("лимит вызова модели", () => {
  it("по умолчанию 90 с, из env — если число не меньше секунды", () => {
    expect(llmTimeoutMs({} as NodeJS.ProcessEnv)).toBe(90_000);
    expect(llmTimeoutMs({ LLM_TIMEOUT_MS: "30000" } as unknown as NodeJS.ProcessEnv)).toBe(30_000);
    expect(llmTimeoutMs({ LLM_TIMEOUT_MS: "5" } as unknown as NodeJS.ProcessEnv)).toBe(90_000);
    expect(llmTimeoutMs({ LLM_TIMEOUT_MS: "abc" } as unknown as NodeJS.ProcessEnv)).toBe(90_000);
  });
});
