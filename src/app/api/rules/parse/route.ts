import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { readyClock } from "@/core/clock";
import { proposeRuleFromText, saveRuleProposal } from "@/core/learning/rule-words";
import { LlmClient } from "@/core/llm";
import { FileCache } from "@/core/llm/file-cache";
import { createProviderOrReplay } from "@/core/llm/providers";
import { dbUsageSink } from "@/core/llm/usage-db";
import { db } from "@/db/client";
import { jsonError, parseBody, requireLeaderId } from "@/lib/http";

export const maxDuration = 60;

const CACHE_FILE = path.resolve(process.cwd(), "data/cache/llm-chat.json");

const Body = z.union([
  z.object({ text: z.string().trim().min(3).max(500) }),
  // Подтверждение: черновик приходит обратно целиком и проверяется заново (клиенту не доверяем).
  z.object({ text: z.string().trim().min(3).max(500), confirm: z.enum(["save", "week"]) }),
]);

/**
 * `POST /api/rules/parse?leaderId=`
 *  - `{ text }` → черновик правила для подтверждения (запись не происходит);
 *  - `{ text, confirm: "save" | "week" }` → разбор повторяется и правило записывается.
 */
export async function POST(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  const body = await parseBody(req, Body);
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
    const res = await proposeRuleFromText(db, llm, auth.leaderId, body.data.text);
    if (!res.ok) return NextResponse.json({ ok: false, message: res.message, notARule: res.notARule ?? false }, { status: 200 });
    if (!("confirm" in body.data)) return NextResponse.json({ ok: true, proposal: res.proposal });
    const saved = await saveRuleProposal(db, auth.leaderId, res.proposal, { weekOnly: body.data.confirm === "week" });
    return saved.ok ? NextResponse.json({ ok: true, saved: true, id: saved.value.id }, { status: 201 }) : jsonError(403, saved.message);
  } catch (e) {
    return jsonError(502, `Не смогла разобрать: ${(e as Error).message}`);
  }
}
