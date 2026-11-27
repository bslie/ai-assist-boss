import { NextResponse } from "next/server";
import {
  FLOW_COOKIE,
  OIDC_FLOW_TTL_SEC,
  buildAuthUrl,
  createPkce,
  newState,
  readOidcConfig,
  redirectUri,
} from "@/core/auth/telegram-oidc";
import { sessionCookieOptions } from "@/core/auth/session";

/** Только путь внутри приложения: `//host` и `/\host` — открытый редирект. */
const safeNext = (v: string | null) => (v && /^\/(?![/\\])/.test(v) ? v : "/");

/** `GET /api/auth/telegram/start` — кнопка «Войти через Telegram»: PKCE + state и редирект в Telegram. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const cfg = readOidcConfig();
  if (!cfg) return NextResponse.redirect(new URL("/login?error=not_configured", url));

  const { verifier, challenge } = createPkce();
  const state = newState();
  const res = NextResponse.redirect(buildAuthUrl(cfg, redirectUri(req), state, challenge));
  res.cookies.set(
    FLOW_COOKIE,
    JSON.stringify({ state, verifier, next: safeNext(url.searchParams.get("next")) }),
    // lax: cookie должна дойти на возврат из Telegram (кросс-сайтовый переход верхнего уровня)
    sessionCookieOptions(OIDC_FLOW_TTL_SEC),
  );
  return res;
}
