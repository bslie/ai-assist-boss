import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/core/auth/password";
import { createSessionToken, readSessionToken, SESSION_TTL_SEC } from "@/core/auth/session";
import { type TelegramLoginPayload, verifyTelegramLogin } from "@/core/auth/telegram-login";

const SECRET = "test-secret-0123456789abcdef0123456789";
const BOT = "123456:TEST_TOKEN";

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

describe("telegram login", () => {
  const base = {
    id: 424242,
    first_name: "Иван",
    username: "ivan",
    auth_date: 1_800_000_000,
  };

  // Подпись по правилам Telegram: ключ = SHA256(token), строка = поля через \n, отсортированные по ключу.
  function signed(fields: Record<string, string | number>, nowSec: number): TelegramLoginPayload {
    const check = Object.entries(fields)
      .map(([k, v]) => [k, String(v)] as const)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    const hash = createHmac("sha256", createHash("sha256").update(BOT).digest()).update(check).digest("hex");
    return { ...(fields as unknown as TelegramLoginPayload), hash, auth_date: Number(fields.auth_date ?? nowSec) };
  }

  it("принимает корректную подпись и возвращает telegramId", () => {
    const now = base.auth_date * 1000 + 60_000;
    const payload = signed(base, base.auth_date);
    expect(verifyTelegramLogin(payload, BOT, now)).toEqual({ ok: true, telegramId: "424242" });
  });

  it("отвергает изменённые данные", () => {
    const payload = signed(base, base.auth_date);
    const tampered = { ...payload, id: 999 };
    expect(verifyTelegramLogin(tampered, BOT, base.auth_date * 1000)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("отвергает подпись, сделанную другим ботом", () => {
    const payload = signed(base, base.auth_date);
    expect(verifyTelegramLogin(payload, "999:OTHER", base.auth_date * 1000)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("отвергает устаревший auth_date", () => {
    const payload = signed(base, base.auth_date);
    const now = (base.auth_date + 2 * 24 * 60 * 60) * 1000;
    expect(verifyTelegramLogin(payload, BOT, now)).toEqual({ ok: false, reason: "expired" });
  });

  it("без токена бота вход отключён", () => {
    const payload = signed(base, base.auth_date);
    expect(verifyTelegramLogin(payload, undefined, base.auth_date * 1000)).toEqual({ ok: false, reason: "no_token" });
  });
});
