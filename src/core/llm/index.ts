/**
 * Единственная точка вызова LLM (CLAUDE.md, SPEC инвариант 6 и 8).
 * - структурный вывод проверяется zod;
 * - кэш по ключу (в тестах — файл `tests/fixtures/llm-cache.json`);
 * - каждый вызов пишется в UsageLog через `UsageSink`;
 * - провайдер меняется env-переменными (любой OpenAI-совместимый эндпоинт).
 */
import { createHash } from "node:crypto";
import { z } from "zod";

export type Pipeline =
  | "EMAIL_TRIAGE"
  | "PROTOCOL_GEN"
  | "TASK_REVIEW"
  | "PROFILE_IMPORT"
  | "CHAT";

export interface ProviderResult {
  object: unknown;
  promptTokens: number;
  completionTokens: number;
}

/** Низкоуровневый провайдер: вернуть JSON-объект по схеме. Подменяется в тестах. */
export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  generate(args: {
    system: string;
    prompt: string;
    schema: z.ZodType;
    temperature: number;
  }): Promise<ProviderResult>;
}

export interface LlmCache {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export interface UsageRecord {
  leaderId: string;
  pipeline: Pipeline;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cached: boolean;
  costRub: number;
}

export interface UsageSink {
  record(entry: UsageRecord): Promise<void>;
}

export class MemoryCache implements LlmCache {
  private readonly map = new Map<string, unknown>();
  async get(key: string) {
    return this.map.get(key);
  }
  async set(key: string, value: unknown) {
    this.map.set(key, value);
  }
}

/** Цены ₽ за 1M токенов; настраиваются env, по умолчанию 0 (стоимость считается позже по шаблону). */
export interface Pricing {
  inputPerMillionRub: number;
  outputPerMillionRub: number;
}

export interface LlmClientOptions {
  provider: LlmProvider;
  cache?: LlmCache;
  usage?: UsageSink;
  pricing?: Pricing;
}

export interface StructuredRequest<S extends z.ZodType> {
  leaderId: string;
  pipeline: Pipeline;
  schema: S;
  system: string;
  prompt: string;
  /** Ключ кэша (например threadKey). Без ключа кэш не используется. */
  cacheKey?: string;
  /** Для классификации всегда 0. */
  temperature?: number;
}

export class LlmClient {
  constructor(private readonly opts: LlmClientOptions) {}

  async generateStructured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<z.infer<S>> {
    const { provider, cache, usage, pricing } = this.opts;
    const temperature = req.temperature ?? 0;
    const key = req.cacheKey
      ? createHash("sha256")
          .update([provider.name, provider.model, req.pipeline, req.cacheKey, req.system].join("\u0000"))
          .digest("hex")
      : null;

    if (key && cache) {
      const hit = await cache.get(key);
      if (hit !== undefined) {
        const parsed = req.schema.safeParse(hit);
        if (parsed.success) {
          await usage?.record(this.usageRecord(req, 0, 0, true, pricing));
          return parsed.data;
        }
        // повреждённая запись кэша — игнорируем и идём в сеть
      }
    }

    const res = await provider.generate({
      system: req.system,
      prompt: req.prompt,
      schema: req.schema,
      temperature,
    });
    // Zod на любой структурный вывод LLM; невалидный ответ — ошибка, не «лучшее предположение».
    const parsed = req.schema.parse(res.object);
    if (key && cache) await cache.set(key, parsed);
    await usage?.record(this.usageRecord(req, res.promptTokens, res.completionTokens, false, pricing));
    return parsed;
  }

  private usageRecord(
    req: { leaderId: string; pipeline: Pipeline },
    promptTokens: number,
    completionTokens: number,
    cached: boolean,
    pricing?: Pricing,
  ): UsageRecord {
    const costRub = pricing
      ? (promptTokens * pricing.inputPerMillionRub + completionTokens * pricing.outputPerMillionRub) / 1_000_000
      : 0;
    return {
      leaderId: req.leaderId,
      pipeline: req.pipeline,
      provider: this.opts.provider.name,
      model: this.opts.provider.model,
      promptTokens,
      completionTokens,
      cached,
      costRub,
    };
  }
}
