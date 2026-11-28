import { describe, expect, it, vi } from "vitest";
import { llmTimeoutMs, reasoningOptionsFromEnv } from "@/core/llm/providers";

describe("лимит вызова модели", () => {
  it("по умолчанию 90 с, из env — если число не меньше секунды", () => {
    expect(llmTimeoutMs({} as NodeJS.ProcessEnv)).toBe(90_000);
    expect(llmTimeoutMs({ LLM_TIMEOUT_MS: "30000" } as unknown as NodeJS.ProcessEnv)).toBe(30_000);
    expect(llmTimeoutMs({ LLM_TIMEOUT_MS: "5" } as unknown as NodeJS.ProcessEnv)).toBe(90_000);
    expect(llmTimeoutMs({ LLM_TIMEOUT_MS: "abc" } as unknown as NodeJS.ProcessEnv)).toBe(90_000);
  });
});

describe("рассуждение модели (LLM_REASONING)", () => {
  const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;

  it("для OpenRouter по умолчанию выключено, для других эндпоинтов параметр не передаётся", () => {
    expect(reasoningOptionsFromEnv(env({ LLM_BASE_URL: "https://openrouter.ai/api/v1" }))).toEqual({ reasoning: { enabled: false } });
    expect(reasoningOptionsFromEnv(env({ LLM_BASE_URL: "http://localhost:11434/v1" }))).toBeUndefined();
    expect(reasoningOptionsFromEnv(env({}))).toBeUndefined();
  });

  it("явное значение сильнее умолчания", () => {
    const or = "https://openrouter.ai/api/v1";
    expect(reasoningOptionsFromEnv(env({ LLM_BASE_URL: or, LLM_REASONING: "default" }))).toBeUndefined();
    expect(reasoningOptionsFromEnv(env({ LLM_BASE_URL: or, LLM_REASONING: "low" }))).toEqual({ reasoning: { effort: "low" } });
    expect(reasoningOptionsFromEnv(env({ LLM_BASE_URL: "http://vllm/v1", LLM_REASONING: "off" }))).toEqual({ reasoning: { enabled: false } });
    expect(reasoningOptionsFromEnv(env({ LLM_BASE_URL: or, LLM_REASONING: "что-то" }))).toBeUndefined();
  });
});

describe("ошибка модели для руководителя", () => {
  it("сырой текст провайдера превращается в понятную фразу", async () => {
    const { friendlyLlmError } = await import("@/lib/llm-error");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(friendlyLlmError(new Error("The operation was aborted due to timeout"))).toContain("слишком долго");
    expect(friendlyLlmError(new Error("429 Rate limit exceeded"))).toContain("перегружена");
    expect(friendlyLlmError(new Error("401 Unauthorized: invalid api key"))).toContain("Нет доступа");
    expect(friendlyLlmError(new Error("fetch failed"))).toContain("Нет связи");
    const other = friendlyLlmError(new Error("zod: invalid_type at answer"));
    expect(other).not.toMatch(/zod|invalid_type/);
    quiet.mockRestore();
  });
});
