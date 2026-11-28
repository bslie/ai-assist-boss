/**
 * Реальный провайдер на Vercel AI SDK через OpenAI-совместимый эндпоинт.
 * Смена модели (GigaChat, YandexGPT, vLLM, Ollama) — только env:
 *   LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, LLM_PROVIDER_NAME
 */
import { generateObject } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { LlmClient, type LlmClientOptions, type LlmProvider } from "./index";

/** Лимит одного вызова модели, мс: `LLM_TIMEOUT_MS`, по умолчанию 90 с. */
export function llmTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.LLM_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? n : 90_000;
}

/**
 * Рассуждение модели. Рассуждающие модели (qwen3.x и подобные) тратят тысячи токенов «размышлений» даже на короткий
 * структурный ответ: протокол встречи шёл 90 с и упирался в лимит, разбор почты и чат были в разы дольше и дороже.
 * `LLM_REASONING`: `off` — без рассуждения, `low|medium|high` — усилие, `default` — не передавать параметр.
 * Не задано: для OpenRouter — `off`, для остальных эндпоинтов параметр не передаётся (он у них может не поддерживаться).
 * Параметр уходит в тело запроса как `reasoning` (формат OpenRouter).
 */
export function reasoningOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | undefined {
  const raw = (env.LLM_REASONING ?? "").trim().toLowerCase();
  const onOpenRouter = /(^|\.)openrouter\.ai$/i.test(safeHost(env.LLM_BASE_URL));
  const mode = raw || (onOpenRouter ? "off" : "default");
  if (mode === "off" || mode === "none" || mode === "false" || mode === "0") return { reasoning: { enabled: false } };
  if (mode === "low" || mode === "medium" || mode === "high") return { reasoning: { effort: mode } };
  return undefined;
}

function safeHost(url: string | undefined): string {
  try {
    return url ? new URL(url).hostname : "";
  } catch {
    return "";
  }
}

export function createProviderFromEnv(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const baseURL = env.LLM_BASE_URL;
  const model = env.LLM_MODEL;
  if (!baseURL || !model) throw new Error("LLM_BASE_URL and LLM_MODEL must be set");
  const name = env.LLM_PROVIDER_NAME ?? "openai-compatible";
  const timeoutMs = llmTimeoutMs(env);
  const reasoning = reasoningOptionsFromEnv(env);
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
      // Зависший эндпоинт не должен вешать карточку или страницу навсегда: общий лимит на вызов вместе с повторами.
      const result = await generateObject({
        model: client(model),
        schema,
        system,
        prompt,
        temperature,
        abortSignal: AbortSignal.timeout(timeoutMs),
        ...(reasoning ? { providerOptions: { [name]: reasoning as never } } : {}),
      });
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
