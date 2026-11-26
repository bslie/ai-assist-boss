import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, readSessionToken } from "@/core/auth/session";

// Страницы под входом. API проверяет сессию сам (см. requireUser), публичные маршруты (avatar, webhooks) не трогаем.
const PROTECTED = ["/", "/rules", "/connectors", "/control"];

const isProtected = (p: string) => PROTECTED.some((base) => (base === "/" ? p === "/" : p === base || p.startsWith(base + "/")));

/** Оптимистичная проверка: подпись и срок cookie. Роль и доступ проверяются заново на сервере страницы/API. */
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const signedIn = readSessionToken(req.cookies.get(SESSION_COOKIE)?.value) !== null;

  if (pathname === "/login") {
    if (signedIn) return NextResponse.redirect(new URL("/", req.url));
    return NextResponse.next();
  }
  if (isProtected(pathname) && !signedIn) {
    const url = new URL("/login", req.url);
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/login", "/rules/:path*", "/connectors/:path*", "/control/:path*"],
};
