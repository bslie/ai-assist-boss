import path from "node:path";
import { NextResponse } from "next/server";
import { readyClock } from "@/core/clock";
import { LlmClient } from "@/core/llm";
import { FileCache } from "@/core/llm/file-cache";
import { createProviderOrReplay } from "@/core/llm/providers";
import { dbUsageSink } from "@/core/llm/usage-db";
import { CreateTaskSchema, createTask, listTasks } from "@/core/tasks/registry";
import { db } from "@/db/client";
import { jsonError, parseBody, requireLeaderId } from "@/lib/http";

export const maxDuration = 60;

const CACHE_FILE = path.resolve(process.cwd(), "data/cache/llm-chat.json");

/** `GET /api/tasks?leaderId=` — реестр поручений. */
export async function GET(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  await readyClock();
  return NextResponse.json({ tasks: await listTasks(db, auth.leaderId) });
}

/** `POST /api/tasks?leaderId=` — новое поручение; критерий готовности формулирует модель, если не задан. */
export async function POST(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  const body = await parseBody(req, CreateTaskSchema);
  if (!body.ok) return body.res;
  await readyClock();

  let llm: LlmClient | null = null;
  if (!body.data.acceptanceCriteria && process.env.LLM_BASE_URL) {
    try {
      llm = new LlmClient({ provider: createProviderOrReplay(), cache: new FileCache(CACHE_FILE), usage: dbUsageSink(db) });
    } catch {
      llm = null; // без модели критерий по умолчанию: поручение важнее
    }
  }
  const res = await createTask(db, llm, auth.leaderId, body.data);
  return res.ok ? NextResponse.json({ id: res.id }, { status: 201 }) : jsonError(res.code === "BAD_ASSIGNEE" ? 404 : 400, res.message);
}
