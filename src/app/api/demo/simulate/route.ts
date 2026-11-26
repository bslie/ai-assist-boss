import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { readyClock } from "@/core/clock";
import { loadInbox } from "@/core/dataset";
import { ingestEmails } from "@/core/email-triage/ingest";
import { publishEvent } from "@/core/events";
import { LlmClient } from "@/core/llm";
import { FileCache } from "@/core/llm/file-cache";
import { createProviderOrReplay } from "@/core/llm/providers";
import { db } from "@/db/client";
import { jsonError, parseBody, requireLeaderId } from "@/lib/http";

export const maxDuration = 300; // живая модель: ~17 последовательных вызовов

const Body = z.object({
  scenario: z.enum(["INGEST_DATASET", "TRIGGER_MORNING", "TRIGGER_EMAIL_BATCH", "RUN_MEETING_TRANSCRIPT", "TRIGGER_WEEKLY"]),
  transcriptName: z.string().optional(),
});

const CACHE_FILE = path.resolve(process.cwd(), process.env.LLM_CACHE_FILE ?? "tests/fixtures/llm-cache.json");

/** `POST /api/demo/simulate?leaderId=` — запуск демо-сценариев. Реализован INGEST_DATASET; остальные ждут воркер. */
export async function POST(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  const body = await parseBody(req, Body);
  if (!body.ok) return body.res;

  if (body.data.scenario !== "INGEST_DATASET") {
    return jsonError(501, `Сценарий ${body.data.scenario} ещё не реализован`);
  }

  await readyClock();
  let provider;
  try {
    provider = createProviderOrReplay();
  } catch (e) {
    return jsonError(503, `LLM не настроена: ${(e as Error).message}`);
  }
  const llm = new LlmClient({ provider, cache: new FileCache(CACHE_FILE) });

  try {
    const stats = await ingestEmails(db, llm, auth.leaderId, loadInbox(), {
      emit: (e) => publishEvent(auth.leaderId, e),
    });
    await publishEvent(auth.leaderId, { type: "metrics.updated", data: {} });
    return NextResponse.json({ scenario: body.data.scenario, stats });
  } catch (e) {
    return jsonError(502, `Разбор почты не удался: ${(e as Error).message}`);
  }
}
