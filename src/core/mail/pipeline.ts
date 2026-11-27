/** Зависимости опроса почты: модель (с учётом расходов), черновики и события для живого обновления экрана. */
import type { PrismaClient } from "@/generated/prisma/client";
import { publishEvent } from "../events";
import { createDraftGenerator } from "../learning/draft";
import { createCriteriaGenerator } from "../tasks/criteria";
import { LlmClient, MemoryCache } from "../llm";
import { createProviderOrReplay } from "../llm/providers";
import { dbUsageSink } from "../llm/usage-db";
import { pollConnector, type PollResult } from "./poll";

export async function pollWithPipeline(db: PrismaClient, leaderId: string, connectorId: string): Promise<PollResult> {
  let provider;
  try {
    provider = createProviderOrReplay();
  } catch (e) {
    return { ok: false, skipped: false, message: `Модель не настроена: ${(e as Error).message}` };
  }
  // Настоящая почта не лежит в записанных ответах: без живой модели разбирать её нечем.
  if (!process.env.LLM_BASE_URL) return { ok: false, skipped: false, message: "Для разбора настоящей почты нужна живая модель: задайте LLM_BASE_URL" };
  const llm = new LlmClient({ provider, cache: new MemoryCache(), usage: dbUsageSink(db) });
  const res = await pollConnector(db, leaderId, connectorId, {
    llm,
    draft: createDraftGenerator(db, llm),
    criteria: createCriteriaGenerator(llm),
    emit: (e) => publishEvent(leaderId, e),
  });
  if (res.ok && res.fetched > 0) await publishEvent(leaderId, { type: "metrics.updated", data: {} });
  return res;
}
