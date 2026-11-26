import path from "node:path";
import { LlmClient } from "@/core/llm";
import { FileCache } from "@/core/llm/file-cache";
import { createProviderOrReplay } from "@/core/llm/providers";
import { dbUsageSink } from "@/core/llm/usage-db";
import { db } from "@/db/client";

const PROTOCOL_CACHE = path.resolve(process.cwd(), "data/cache/llm-protocols.json");

/** LLM для веб-маршрутов встреч: живая модель или повтор из кэша. Каждый вызов пишется в UsageLog. */
export function protocolLlm(): LlmClient {
  return new LlmClient({ provider: createProviderOrReplay(), cache: new FileCache(PROTOCOL_CACHE), usage: dbUsageSink(db) });
}
