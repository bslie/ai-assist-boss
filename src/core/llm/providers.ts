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
  // Без supportsStructuredOutputs схема не уходит в запрос (json_object), и модель выдумывает имена полей.
  // LLM_STRUCTURED_OUTPUTS=0 отключает для эндпоинтов без json_schema.
  const client = createOpenAICompatible({
    name,
    baseURL,
    apiKey: env.LLM_API_KEY,
    supportsStructuredOutputs: env.LLM_STRUCTURED_OUTPUTS !== "0",
  });

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

/**
 * Живая модель (LLM_BASE_URL + LLM_MODEL) или повтор из кэша без сети (только LLM_MODEL).
 * В режиме повтора промах кэша — явная ошибка. Ключ кэша включает провайдера и модель.
 */
export function createProviderOrReplay(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  if (env.LLM_BASE_URL && env.LLM_MODEL) return createProviderFromEnv(env);
  if (!env.LLM_MODEL) throw new Error("LLM_MODEL is not set");
  return {
    name: env.LLM_PROVIDER_NAME ?? "openai-compatible",
    model: env.LLM_MODEL,
    async generate(): Promise<never> {
      throw new Error("Нет ответа в кэше LLM, а LLM_BASE_URL не задан");
    },
  };
}
