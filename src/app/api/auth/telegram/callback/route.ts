import { NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_TTL_SEC, createSessionToken, sessionCookieOptions } from "@/core/auth/session";
import {
  FLOW_COOKIE,
  FlowStateSchema,
  exchangeCode,
  fetchJwks,
  readOidcConfig,
  redirectUri,
  verifyIdToken,
} from "@/core/auth/telegram-oidc";
import { db } from "@/db/client";

/** `GET /api/auth/telegram/callback` — возврат из Telegram. Вход только при верном state, подписи ID-токена и привязанном аккаунте. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const fail = (error: string) => {
    const res = NextResponse.redirect(new URL(`/login?error=${error}`, url));
    res.cookies.set(FLOW_COOKIE, "", sessionCookieOptions(0));
    return res;
  };

  const cfg = readOidcConfig();
  if (!cfg) return fail("not_configured");
  if (url.searchParams.get("error")) return fail("denied");

  const cookie = req.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith(`${FLOW_COOKIE}=`));
  let flow;
  try {
    const raw = cookie ? decodeURIComponent(cookie.slice(FLOW_COOKIE.length + 1)) : "";
    flow = FlowStateSchema.safeParse(JSON.parse(raw));
  } catch {
    return fail("state");
  }
  const code = url.searchParams.get("code");
  if (!flow.success || !code || url.searchParams.get("state") !== flow.data.state) return fail("state");

  const tokens = await exchangeCode(cfg, code, redirectUri(req), flow.data.verifier).catch(() => null);
  if (!tokens?.ok) return fail("exchange");
  const jwks = await fetchJwks().catch(() => null);
  if (!jwks) return fail("exchange");

  const verdict = verifyIdToken(tokens.idToken, jwks, cfg.clientId);
  if (!verdict.ok) return fail(verdict.reason === "expired" ? "expired" : "signature");

  const user = await db.appUser.findUnique({ where: { telegramId: verdict.telegramId } });
  if (!user) return fail("not_linked");

  const next = /^\/(?![/\\])/.test(flow.data.next) ? flow.data.next : "/";
  const res = NextResponse.redirect(new URL(next, url));
  res.cookies.set(FLOW_COOKIE, "", sessionCookieOptions(0));
  res.cookies.set(SESSION_COOKIE, createSessionToken(user.id, user.role), sessionCookieOptions(SESSION_TTL_SEC));
  return res;
}
