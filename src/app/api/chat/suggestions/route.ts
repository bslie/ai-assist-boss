import path from "node:path";
import { NextResponse } from "next/server";
import { FALLBACK_SUGGESTIONS, generateSuggestions } from "@/core/chat-suggestions";
import { readyClock } from "@/core/clock";
import { LlmClient } from "@/core/llm";
import { FileCache } from "@/core/llm/file-cache";
import { createProviderOrReplay } from "@/core/llm/providers";
import { dbUsageSink } from "@/core/llm/usage-db";
import { db } from "@/db/client";
import { requireLeaderId } from "@/lib/http";

const CACHE_FILE = path.resolve(process.cwd(), "data/cache/llm-chat.json");

/**
 * `GET /api/chat/suggestions?leaderId=` — подсказки под полем чата по контексту руководителя.
 * Любой сбой модели не ошибка для страницы: отдаём общий набор с `generated: false`.
 */
export async function GET(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  await readyClock();
  try {
    const llm = new LlmClient({ provider: createProviderOrReplay(), cache: new FileCache(CACHE_FILE), usage: dbUsageSink(db) });
    return NextResponse.json({ suggestions: await generateSuggestions(db, llm, auth.leaderId), generated: true });
  } catch {
    return NextResponse.json({ suggestions: FALLBACK_SUGGESTIONS, generated: false });
  }
}
