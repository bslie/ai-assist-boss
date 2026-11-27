import { NextResponse } from "next/server";
import { ConnectSchema, connectModule, listCatalog } from "@/core/connectors/service";
import { db } from "@/db/client";
import { jsonError, parseBody, requireLeaderId } from "@/lib/http";
import { requestOrigin } from "@/lib/origin";

export const maxDuration = 30;

const STATUS = { NOT_FOUND: 404, INVALID: 422, CONFLICT: 409, UNAVAILABLE: 503 } as const;

/** `GET /api/connectors?leaderId=` — каталог модулей с состоянием подключений. Секретов в ответе нет. */
export async function GET(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  return NextResponse.json({ items: await listCatalog(db, auth.leaderId) });
}

/** `POST /api/connectors?leaderId=` — подключить модуль (доступы шифруются). OAuth идёт через /oauth/start. */
export async function POST(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  const body = await parseBody(req, ConnectSchema);
  if (!body.ok) return body.res;
  const res = await connectModule(db, auth.leaderId, body.data, { origin: requestOrigin(req) });
  return res.ok ? NextResponse.json(res.value, { status: 201 }) : jsonError(STATUS[res.code], res.message);
}
