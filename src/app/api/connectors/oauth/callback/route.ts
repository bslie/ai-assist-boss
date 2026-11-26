import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyState } from "@/core/connectors/crypto";
import { getModule } from "@/core/connectors/modules";
import { saveOAuthTokens } from "@/core/connectors/service";
import { db } from "@/db/client";

const TokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
});

/** `GET /api/connectors/oauth/callback` — сервис вернул код: меняем на токены, шифруем, сохраняем. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (q: string) => NextResponse.redirect(new URL(`/connectors?${q}`, url.origin));
  if (url.searchParams.get("error")) return back(`error=${encodeURIComponent("Вход отменён или сервис отказал в доступе")}`);

  const payload = verifyState(url.searchParams.get("state") ?? "");
  const [leaderId, moduleId] = payload?.split("|") ?? [];
  const m = getModule(moduleId ?? "");
  const code = url.searchParams.get("code");
  if (!payload || !leaderId || !m || m.auth.kind !== "oauth" || !code) return back(`error=${encodeURIComponent("Не удалось проверить возврат из сервиса, попробуйте ещё раз")}`);
  if (!(await db.leader.findUnique({ where: { id: leaderId }, select: { id: true } }))) return back("error=1");

  try {
    const res = await fetch(m.auth.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env[m.auth.clientIdEnv] ?? "",
        client_secret: process.env[m.auth.clientSecretEnv] ?? "",
        grant_type: "authorization_code",
        code,
        redirect_uri: `${url.origin}/api/connectors/oauth/callback`,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const tokens = TokenSchema.parse(await res.json());
    // Адрес аккаунта нужен, чтобы не разбирать собственные письма и показывать, чей ящик подключён.
    let account: string | undefined;
    if (m.auth.userinfoUrl) {
      const ui = await fetch(m.auth.userinfoUrl, { headers: { authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const v = (ui?.email ?? ui?.mail ?? ui?.userPrincipalName) as unknown;
      if (typeof v === "string") account = v.toLowerCase();
    }
    await saveOAuthTokens(
      db,
      leaderId,
      m.id,
      { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined },
      account,
    );
    return back(`connected=${encodeURIComponent(m.id)}`);
  } catch {
    return back(`error=${encodeURIComponent("Сервис не выдал доступ. Проверьте настройки приложения и повторите.")}`);
  }
}
