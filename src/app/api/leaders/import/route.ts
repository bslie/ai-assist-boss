import { NextResponse } from "next/server";
import { z } from "zod";
import { LlmClient } from "@/core/llm";
import { FileCache } from "@/core/llm/file-cache";
import { createProviderOrReplay } from "@/core/llm/providers";
import { applyProfile, diffProfile, importProfile } from "@/core/profile";
import { deleteDraft, saveDraft, takeDraft } from "@/core/profile/draft-store";
import { db } from "@/db/client";
import { jsonError, parseBody, requireLeaderId } from "@/lib/http";
import path from "node:path";

export const maxDuration = 120;

const Body = z.union([
  z.object({ markdown: z.string().min(20).max(50_000) }),
  z.object({ confirm: z.literal(true), draftId: z.string().min(1) }),
]);

const CACHE_FILE = path.resolve(process.cwd(), process.env.LLM_CACHE_FILE ?? "tests/fixtures/llm-cache.json");

/**
 * `POST /api/leaders/import?leaderId=`
 *  - `{ markdown }` → черновик профиля и diff (запись не происходит);
 *  - `{ confirm: true, draftId }` → запись, `profileVersion += 1`.
 */
export async function POST(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  const body = await parseBody(req, Body);
  if (!body.ok) return body.res;

  if ("confirm" in body.data) {
    const stored = await takeDraft(body.data.draftId);
    if (!stored || stored.leaderId !== auth.leaderId) return jsonError(404, "Черновик не найден или устарел");
    await applyProfile(db, auth.leaderId, stored.draft, stored.markdown);
    await deleteDraft(body.data.draftId);
    return NextResponse.json({ applied: true });
  }

  let provider;
  try {
    provider = createProviderOrReplay();
  } catch (e) {
    return jsonError(503, `LLM не настроена: ${(e as Error).message}`);
  }
  try {
    const llm = new LlmClient({ provider, cache: new FileCache(CACHE_FILE) });
    const { draft, warnings } = await importProfile(llm, auth.leaderId, body.data.markdown);
    const diff = await diffProfile(db, auth.leaderId, draft);
    const draftId = await saveDraft({ leaderId: auth.leaderId, markdown: body.data.markdown, draft });
    return NextResponse.json({ draftId, draft, warnings, diff });
  } catch (e) {
    return jsonError(502, `Импорт профиля не удался: ${(e as Error).message}`);
  }
}
