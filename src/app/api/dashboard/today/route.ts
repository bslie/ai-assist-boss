import { NextResponse } from "next/server";
import { getToday } from "@/core/dashboard";
import { db } from "@/db/client";
import { requireLeaderId } from "@/lib/http";

/** `GET /api/dashboard/today?leaderId=` → приоритеты, решения, метрики (SPEC 6, 7.4). */
export async function GET(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  return NextResponse.json(await getToday(db, auth.leaderId));
}
