import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/core/auth/password";
import { createSessionToken, readSessionToken, SESSION_TTL_SEC } from "@/core/auth/session";
import { type Jwks, createPkce, readOidcConfig, verifyIdToken } from "@/core/auth/telegram-oidc";

const SECRET = "test-secret-0123456789abcdef0123456789";

let savedSecret: string | undefined;
beforeEach(() => {
  savedSecret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = SECRET;
});
afterEach(() => {
  process.env.AUTH_SECRET = savedSecret;
});

describe("password", () => {
  it("проверяет верный пароль и отвергает неверный", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("без хэша (только Telegram) и с битым хэшем — отказ", async () => {
    expect(await verifyPassword("anything", null)).toBe(false);
    expect(await verifyPassword("anything", "scrypt$broken")).toBe(false);
    expect(await verifyPassword("anything", "bcrypt$10$xxx")).toBe(false);
  });

  it("хэш с негодными параметрами scrypt — отказ, а не исключение", async () => {
    const [, , r, p, salt, hash] = (await hashPassword("pw")).split("$");
    expect(await verifyPassword("pw", ["scrypt", "abc", r, p, salt, hash].join("$"))).toBe(false);
    expect(await verifyPassword("pw", ["scrypt", "3", r, p, salt, hash].join("$"))).toBe(false); // N не степень двойки
    expect(await verifyPassword("pw", ["scrypt", "16384", r, p, salt, ""].join("$"))).toBe(false);
  });

  it("одинаковый пароль даёт разные хэши (соль)", async () => {
    expect(await hashPassword("same-password")).not.toBe(await hashPassword("same-password"));
  });
});

describe("session token", () => {
  it("принимает свежий токен и возвращает uid и роль", () => {
    const now = 1_000_000_000_000;
    const token = createSessionToken("user-1", "ADMIN", now);
    expect(readSessionToken(token, now + 1000)).toMatchObject({ uid: "user-1", role: "ADMIN" });
  });

  it("отвергает истёкший токен", () => {
    const now = 1_000_000_000_000;
    const token = createSessionToken("user-1", "LEADER", now);
    expect(readSessionToken(token, now + (SESSION_TTL_SEC + 1) * 1000)).toBeNull();
  });

  it("отвергает подмену payload (повышение роли)", () => {
    const now = 1_000_000_000_000;
    const token = createSessionToken("user-1", "LEADER", now);
    const [, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ uid: "user-1", role: "ADMIN", exp: 9_999_999_999 })).toString("base64url");
    expect(readSessionToken(`${forged}.${sig}`, now)).toBeNull();
  });

  it("токен, подписанный другим секретом, не принимается", () => {
    const now = 1_000_000_000_000;
    const token = createSessionToken("user-1", "ADMIN", now);
    process.env.AUTH_SECRET = "another-secret-0123456789abcdef0123456789";
    expect(readSessionToken(token, now)).toBeNull();
  });

  it("без AUTH_SECRET сессия не создаётся (fail closed)", () => {
    delete process.env.AUTH_SECRET;
    expect(() => createSessionToken("user-1", "ADMIN")).toThrow(/AUTH_SECRET/);
    expect(readSessionToken("abc.def")).toBeNull();
  });
});

describe("telegram oidc", () => {
  const CLIENT = "9018213270";
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwks: Jwks = { keys: [{ ...(publicKey.export({ format: "jwk" }) as object), kid: "k1" } as Jwks["keys"][number]] };
  const now = 1_800_000_000_000;

  function token(claims: Record<string, unknown>, key = privateKey): string {
    const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1" })).toString("base64url");
    const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const sig = cryptoSign("sha256", Buffer.from(`${h}.${p}`), key).toString("base64url");
    return `${h}.${p}.${sig}`;
  }
  const ok = { iss: "https://oauth.telegram.org", aud: CLIENT, exp: now / 1000 + 3600, id: 424242, name: "Иван" };

  it("принимает корректный токен и отдаёт telegramId", () => {
    expect(verifyIdToken(token(ok), jwks, CLIENT, now)).toMatchObject({ ok: true, telegramId: "424242" });
  });

  it("отвергает чужую подпись", () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    expect(verifyIdToken(token(ok, other), jwks, CLIENT, now)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("отвергает подмену payload", () => {
    const [h, , s] = token(ok).split(".");
    const forged = Buffer.from(JSON.stringify({ ...ok, id: 1 })).toString("base64url");
    expect(verifyIdToken(`${h}.${forged}.${s}`, jwks, CLIENT, now)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("отвергает чужой aud, чужой iss и истёкший токен", () => {
    expect(verifyIdToken(token({ ...ok, aud: "1" }), jwks, CLIENT, now)).toEqual({ ok: false, reason: "bad_claims" });
    expect(verifyIdToken(token({ ...ok, iss: "https://evil.example" }), jwks, CLIENT, now)).toEqual({ ok: false, reason: "bad_claims" });
    expect(verifyIdToken(token({ ...ok, exp: now / 1000 - 3600 }), jwks, CLIENT, now)).toEqual({ ok: false, reason: "expired" });
  });

  it("отвергает alg=none и мусор", () => {
    const h = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const p = Buffer.from(JSON.stringify(ok)).toString("base64url");
    expect(verifyIdToken(`${h}.${p}.`, jwks, CLIENT, now)).toEqual({ ok: false, reason: "bad_alg" });
    expect(verifyIdToken("abc", jwks, CLIENT, now)).toEqual({ ok: false, reason: "malformed" });
  });

  it("PKCE: challenge = SHA256(verifier); без настроек вход выключен", () => {
    const { verifier, challenge } = createPkce();
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(readOidcConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(readOidcConfig({ TELEGRAM_LOGIN_CLIENT_ID: "1" } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
});
