/**
 * Реальный провайдер на Vercel AI SDK через OpenAI-совместимый эндпоинт.
 * Смена модели (GigaChat, YandexGPT, vLLM, Ollama) — только env:
 *   LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, LLM_PROVIDER_NAME
 */
import { generateObject } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { LlmClient, type LlmClientOptions, type LlmProvider } from "./index";

export function createProviderFromEnv(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const baseURL = env.LLM_BASE_URL;
  const model = env.LLM_MODEL;
  if (!baseURL || !model) throw new Error("LLM_BASE_URL and LLM_MODEL must be set");
  const name = env.LLM_PROVIDER_NAME ?? "openai-compatible";
  const client = createOpenAICompatible({ name, baseURL, apiKey: env.LLM_API_KEY });

  return {
    name,
    model,
    async generate({ system, prompt, schema, temperature }) {
      const result = await generateObject({ model: client(model), schema, system, prompt, temperature });
      return {
        object: result.object,
        promptTokens: result.usage?.inputTokens ?? 0,
        completionTokens: result.usage?.outputTokens ?? 0,
      };
    },
  };
}

export function createLlmClientFromEnv(
  extra: Omit<LlmClientOptions, "provider"> = {},
  env: NodeJS.ProcessEnv = process.env,
): LlmClient {
  return new LlmClient({ provider: createProviderFromEnv(env), ...extra });
}
