import { createHash, createPublicKey, randomBytes, verify as cryptoVerify, type JsonWebKey } from "node:crypto";
import { z } from "zod";

/**
 * Вход через Telegram по OpenID Connect (Authorization Code + PKCE S256):
 * https://core.telegram.org/bots/telegram-login
 * Секрет клиента и ID берутся у @BotFather → Login Widget. Redirect URI там же надо внести дословно.
 */
export const TELEGRAM_ISSUER = "https://oauth.telegram.org";
export const TELEGRAM_AUTH_URL = `${TELEGRAM_ISSUER}/auth`;
export const TELEGRAM_TOKEN_URL = `${TELEGRAM_ISSUER}/token`;
export const TELEGRAM_JWKS_URL = `${TELEGRAM_ISSUER}/.well-known/jwks.json`;

export const FLOW_COOKIE = "assist_tg_flow";
export const CALLBACK_PATH = "/api/auth/telegram/callback";
/** Живость cookie с state/verifier: пользователь должен успеть подтвердить вход в Telegram. */
export const OIDC_FLOW_TTL_SEC = 10 * 60;
const CLOCK_SKEW_SEC = 60;

export type OidcConfig = { clientId: string; clientSecret: string };

/** Без клиента или секрета вход отключён (fail closed). */
export function readOidcConfig(env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
  const clientId = env.TELEGRAM_LOGIN_CLIENT_ID?.trim();
  const clientSecret = env.TELEGRAM_LOGIN_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Публичный адрес приложения: APP_URL, иначе origin запроса. Должен совпадать с Redirect URI в BotFather. */
export function redirectUri(req: Request, env: NodeJS.ProcessEnv = process.env): string {
  const base = env.APP_URL?.trim() ? env.APP_URL.trim().replace(/\/+$/, "") : new URL(req.url).origin;
  return `${base}${CALLBACK_PATH}`;
}

export type PkcePair = { verifier: string; challenge: string };

export function createPkce(): PkcePair {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export const newState = (): string => randomBytes(24).toString("base64url");

export function buildAuthUrl(cfg: OidcConfig, redirect: string, state: string, challenge: string): string {
  const url = new URL(TELEGRAM_AUTH_URL);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** Состояние входа, пока пользователь на стороне Telegram. Лежит в httpOnly cookie. */
export const FlowStateSchema = z.object({
  state: z.string().min(16),
  verifier: z.string().min(43),
  next: z.string().max(500),
});
export type FlowState = z.infer<typeof FlowStateSchema>;

// ---- ID token ----

const JwkSchema = z.object({ kty: z.string(), kid: z.string().optional() }).passthrough();
export const JwksSchema = z.object({ keys: z.array(JwkSchema) });
export type Jwks = z.infer<typeof JwksSchema>;

const HeaderSchema = z.object({ alg: z.enum(["RS256", "ES256"]), kid: z.string().optional() });
const ClaimsSchema = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  iat: z.number().optional(),
  sub: z.string().optional(),
  id: z.union([z.number(), z.string()]),
  name: z.string().optional(),
  preferred_username: z.string().optional(),
});

export type IdTokenVerdict =
  | { ok: true; telegramId: string; name?: string; username?: string }
  | { ok: false; reason: "malformed" | "bad_alg" | "no_key" | "bad_signature" | "bad_claims" | "expired" };

const decode = (part: string): unknown => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

/**
 * Проверка подписи (RS256/ES256 по JWKS Telegram), iss, aud = client_id и exp.
 * Любое сомнение — отказ. `nowMs` передаётся снаружи для тестов; в рантайме это реальное время.
 */
export function verifyIdToken(idToken: string, jwks: Jwks, clientId: string, nowMs: number = Date.now()): IdTokenVerdict {
  const parts = idToken.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, p, s] = parts as [string, string, string];

  let header: z.infer<typeof HeaderSchema>;
  let claimsRaw: unknown;
  try {
    const parsed = HeaderSchema.safeParse(decode(h));
    if (!parsed.success) return { ok: false, reason: "bad_alg" };
    header = parsed.data;
    claimsRaw = decode(p);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const candidates = jwks.keys.filter((k) => (header.kid ? k.kid === header.kid : true) && k.kty === (header.alg === "RS256" ? "RSA" : "EC"));
  if (candidates.length === 0) return { ok: false, reason: "no_key" };

  const data = Buffer.from(`${h}.${p}`);
  const sig = Buffer.from(s, "base64url");
  let valid = false;
  for (const jwk of candidates) {
    try {
      const key = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
      valid =
        header.alg === "RS256"
          ? cryptoVerify("sha256", data, key, sig)
          : cryptoVerify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, sig);
    } catch {
      valid = false;
    }
    if (valid) break;
  }
  if (!valid) return { ok: false, reason: "bad_signature" };

  const claims = ClaimsSchema.safeParse(claimsRaw);
  if (!claims.success) return { ok: false, reason: "bad_claims" };
  const c = claims.data;
  const audiences = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (c.iss !== TELEGRAM_ISSUER || !audiences.includes(clientId)) return { ok: false, reason: "bad_claims" };
  if (c.exp * 1000 + CLOCK_SKEW_SEC * 1000 <= nowMs) return { ok: false, reason: "expired" };

  const telegramId = String(c.id);
  if (!/^\d+$/.test(telegramId)) return { ok: false, reason: "bad_claims" };
  return { ok: true, telegramId, name: c.name, username: c.preferred_username };
}

export const TokenResponseSchema = z.object({ id_token: z.string().min(1) });

/** Обмен code на токены. Клиент аутентифицируется Basic-заголовком (client_id:client_secret). */
export async function exchangeCode(
  cfg: OidcConfig,
  code: string,
  redirect: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; idToken: string } | { ok: false }> {
  const res = await fetchImpl(TELEGRAM_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id: cfg.clientId,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return { ok: false };
  const parsed = TokenResponseSchema.safeParse(await res.json().catch(() => null));
  return parsed.success ? { ok: true, idToken: parsed.data.id_token } : { ok: false };
}

export async function fetchJwks(fetchImpl: typeof fetch = fetch): Promise<Jwks | null> {
  const res = await fetchImpl(TELEGRAM_JWKS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  const parsed = JwksSchema.safeParse(await res.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}
