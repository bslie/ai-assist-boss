/**
 * Адрес, по которому пользователь открыл приложение: за прокси берём X-Forwarded-*, иначе из самого запроса.
 * Так интеграциям (OAuth, страница аватара для Recall) не нужно, чтобы пользователь вводил адрес.
 *
 * Прокси часто не передаёт X-Forwarded-Proto, и Next видит внутренний http. Для публичного имени хоста
 * без явного указания считаем https: иначе Redirect URI не совпадёт с зарегистрированным (redirect_uri_mismatch).
 */
const isLocalHost = (hostname: string) => hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "[::1]" || /^(127|10|192\.168)\./.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);

export function requestOrigin(req: Request): string | undefined {
  const url = new URL(req.url);
  const first = (v: string | null) => v?.split(",")[0]?.trim();
  const host = first(req.headers.get("x-forwarded-host")) || req.headers.get("host") || url.host;
  if (!URL.canParse(`http://${host}`)) return undefined;
  const hostname = new URL(`http://${host}`).hostname;
  const proto = first(req.headers.get("x-forwarded-proto")) || (isLocalHost(hostname) ? url.protocol.replace(":", "") : "https");
  if (proto !== "http" && proto !== "https") return undefined;
  return new URL(`${proto}://${host}`).origin;
}

/** Redirect URI, который сервер отправляет в Google/Microsoft и который нужно записать в кабинете сервиса. */
export const oauthRedirectUri = (req: Request): string | undefined => {
  const origin = requestOrigin(req);
  return origin ? `${origin}/api/connectors/oauth/callback` : undefined;
};
