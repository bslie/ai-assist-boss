import { NextResponse } from "next/server";
import { z } from "zod";
import { probeMcp } from "@/core/connectors/mcp";
import { jsonError, parseBody, requireLeaderId } from "@/lib/http";

export const maxDuration = 30;

const Body = z.object({ url: z.string().min(1).max(500), token: z.string().max(2000).optional() });

/** `POST /api/connectors/probe?leaderId=` — какие инструменты у MCP-сервера. Ничего не вызывает и не сохраняет. */
export async function POST(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  const body = await parseBody(req, Body);
  if (!body.ok) return body.res;
  const res = await probeMcp(body.data.url, { token: body.data.token });
  return res.ok ? NextResponse.json({ tools: res.tools }) : jsonError(422, res.message);
}
