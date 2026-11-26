import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { signState, secretsConfigured } from "@/core/connectors/crypto";
import { getModule } from "@/core/connectors/modules";
import { oauthReady } from "@/core/connectors/service";
import { jsonError, requireLeaderId } from "@/lib/http";

/** `GET /api/connectors/oauth/start?leaderId=&module=` — отправляет руководителя на страницу входа сервиса. */
export async function GET(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  const url = new URL(req.url);
  const m = getModule(url.searchParams.get("module") ?? "");
  if (!m || m.auth.kind !== "oauth") return jsonError(404, "Такого модуля нет");
  if (!oauthReady(m) || !secretsConfigured()) return jsonError(503, "Вход через этот сервис ещё не настроен на сервере");

  const state = signState(`${auth.leaderId}|${m.id}|${randomBytes(8).toString("hex")}`);
  const to = new URL(m.auth.authorizeUrl);
  to.search = new URLSearchParams({
    client_id: process.env[m.auth.clientIdEnv]!,
    response_type: "code",
    redirect_uri: `${url.origin}/api/connectors/oauth/callback`,
    scope: m.auth.scopes.join(" "),
    state,
    prompt: "select_account",
  }).toString();
  return NextResponse.redirect(to);
}
