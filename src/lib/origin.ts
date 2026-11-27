/**
 * Адрес, по которому пользователь открыл приложение: за прокси берём X-Forwarded-*, иначе из самого запроса.
 * Так интеграциям (например, Recall открывает страницу аватара) не нужно, чтобы пользователь вводил адрес.
 */
export function requestOrigin(req: Request): string | undefined {
  const url = new URL(req.url);
  const first = (v: string | null) => v?.split(",")[0]?.trim();
  const proto = first(req.headers.get("x-forwarded-proto")) || url.protocol.replace(":", "");
  const host = first(req.headers.get("x-forwarded-host")) || req.headers.get("host") || url.host;
  if (proto !== "http" && proto !== "https") return undefined;
  const candidate = `${proto}://${host}`;
  return URL.canParse(candidate) ? new URL(candidate).origin : undefined;
}
