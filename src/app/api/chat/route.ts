import path from "node:path";
import { NextResponse } from "next/server";
import { ChatInputSchema, handleChat, type ChatReply } from "@/core/chat";
import { readyClock } from "@/core/clock";
import { LlmClient } from "@/core/llm";
import { FileCache } from "@/core/llm/file-cache";
import { createProviderOrReplay } from "@/core/llm/providers";
import { dbUsageSink } from "@/core/llm/usage-db";
import { rememberOrigin } from "@/core/meetings/recall";
import { db } from "@/db/client";
import { jsonError, parseBody, requireLeaderId } from "@/lib/http";
import { friendlyLlmError } from "@/lib/llm-error";
import { requestOrigin } from "@/lib/origin";

export const maxDuration = 300; // «проверь почту» разбирает письма живой моделью

const CACHE_FILE = path.resolve(process.cwd(), "data/cache/llm-chat.json");

/** Строка потока ответа: прогресс агента, итоговый ответ или ошибка. Одна JSON-строка на событие. */
export type ChatStreamEvent = { type: "progress"; text: string } | { type: "reply"; reply: ChatReply } | { type: "error"; error: string };

/**
 * `POST /api/chat?leaderId=` — реплика руководителя помощнику.
 * Заголовок `Accept: application/x-ndjson` включает поток: пока агенту нужно ещё одно обращение к модели,
 * приходят строки `progress`, в конце — `reply`. Без заголовка ответ одним JSON, как раньше.
 */
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
  // Встреча по ссылке из чата запускается на сервере: адрес приложения нужен для страницы аватара.
  await rememberOrigin(db, auth.leaderId, requestOrigin(req)).catch(() => {});

  if (!req.headers.get("accept")?.includes("application/x-ndjson")) {
    try {
      return NextResponse.json(await handleChat(db, llm, auth.leaderId, body.data.text, body.data.history));
    } catch (e) {
      return jsonError(502, friendlyLlmError(e));
    }
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: ChatStreamEvent) => controller.enqueue(enc.encode(`${JSON.stringify(e)}\n`));
      try {
        const reply = await handleChat(db, llm, auth.leaderId, body.data.text, body.data.history, (p) => send({ type: "progress", text: p.text }));
        send({ type: "reply", reply });
      } catch (e) {
        send({ type: "error", error: friendlyLlmError(e) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
