import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteOAuthApp, oauthAppStatuses, saveOAuthApp, SaveOAuthAppSchema } from "@/core/connectors/oauth-app";
import { db } from "@/db/client";
import { jsonError, parseBody } from "@/lib/http";
import { oauthRedirectUri } from "@/lib/origin";
import { requireAdmin } from "@/lib/require-admin";

/** `GET /api/control/oauth-apps` — настроены ли OAuth-приложения Google и Microsoft. Секрет в ответе не появляется никогда. */
export async function GET(req: Request) {
  const admin = await requireAdmin();
  if (!admin.ok) return admin.res;
  return NextResponse.json({ apps: await oauthAppStatuses(db), redirectUri: oauthRedirectUri(req) }, { headers: { "cache-control": "no-store" } });
}

/** `PUT /api/control/oauth-apps` — записать Client ID и Client secret (шифруются). Только ADMIN. */
export async function PUT(req: Request) {
  const admin = await requireAdmin();
  if (!admin.ok) return admin.res;
  const body = await parseBody(req, SaveOAuthAppSchema);
  if (!body.ok) return body.res;
  const res = await saveOAuthApp(db, body.data);
  if (!res.ok) return jsonError(422, res.message);
  return NextResponse.json({ apps: await oauthAppStatuses(db), redirectUri: oauthRedirectUri(req) }, { headers: { "cache-control": "no-store" } });
}

const DeleteBody = z.object({ key: z.enum(["google", "microsoft"]) });

/** `DELETE /api/control/oauth-apps` — стереть ключи приложения. Уже выданные доступы пользователей перестанут обновляться. */
export async function DELETE(req: Request) {
  const admin = await requireAdmin();
  if (!admin.ok) return admin.res;
  const body = await parseBody(req, DeleteBody);
  if (!body.ok) return body.res;
  await deleteOAuthApp(db, body.data.key);
  return NextResponse.json({ apps: await oauthAppStatuses(db), redirectUri: oauthRedirectUri(req) }, { headers: { "cache-control": "no-store" } });
}
