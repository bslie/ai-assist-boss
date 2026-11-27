import { NextResponse } from "next/server";
import { getActivity } from "@/core/worker-activity";
import { requireLeaderId } from "@/lib/http";

/** `GET /api/worker/status?leaderId=` — чем воркер занят сейчас (`label: null`, если свободен). Дальше — событие `worker.activity` в SSE. */
export async function GET(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  return NextResponse.json({ label: await getActivity(auth.leaderId) });
}
