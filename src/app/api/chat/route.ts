import path from "node:path";
import { NextResponse } from "next/server";
import { ChatInputSchema, handleChat } from "@/core/chat";
import { readyClock } from "@/core/clock";
import { LlmClient } from "@/core/llm";
import { FileCache } from "@/core/llm/file-cache";
import { createProviderOrReplay } from "@/core/llm/providers";
import { dbUsageSink } from "@/core/llm/usage-db";
import { db } from "@/db/client";
import { jsonError, parseBody, requireLeaderId } from "@/lib/http";

export const maxDuration = 60;

const CACHE_FILE = path.resolve(process.cwd(), "data/cache/llm-chat.json");

/** `POST /api/chat?leaderId=` — реплика руководителя помощнику, ответ одним сообщением. */
export async function POST(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  const body = await parseBody(req, ChatInputSchema);
  if (!body.ok) return body.res;

  await readyClock();
  let provider;
  try {
    provider = createProviderOrReplay();
  } catch (e) {
    return jsonError(503, `LLM не настроена: ${(e as Error).message}`);
  }
  const llm = new LlmClient({ provider, cache: new FileCache(CACHE_FILE), usage: dbUsageSink(db) });
  try {
    return NextResponse.json(await handleChat(db, llm, auth.leaderId, body.data.text));
  } catch (e) {
    return jsonError(502, `Не смогла разобрать: ${(e as Error).message}`);
  }
}
