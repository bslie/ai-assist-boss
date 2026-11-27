import { NextResponse } from "next/server";
import { publishEvent } from "@/core/events";
import { ProfilePatchSchema, applyProfilePatch } from "@/core/profile/patch";
import { db } from "@/db/client";
import { parseBody, requireLeaderId } from "@/lib/http";

/** `PATCH /api/profile?leaderId=` — `{ goals?, stylePrompt?, budgetAutoLimit? }`: подтверждённая правка из чата. */
export async function PATCH(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  const body = await parseBody(req, ProfilePatchSchema);
  if (!body.ok) return body.res;
  const { profileVersion } = await applyProfilePatch(db, auth.leaderId, body.data);
  await publishEvent(auth.leaderId, { type: "metrics.updated", data: {} });
  return NextResponse.json({ ok: true, profileVersion });
}
