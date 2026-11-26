/** Шифрование секретов подключений (AES-256-GCM). Ключа нет → секреты не сохраняем (fail closed). */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export class SecretsNotConfigured extends Error {
  constructor() {
    super("Не задан CONNECTOR_SECRET: без него я не могу безопасно хранить доступы.");
  }
}

const key = (): Buffer => {
  const s = process.env.CONNECTOR_SECRET;
  if (!s || s.length < 16) throw new SecretsNotConfigured();
  return createHash("sha256").update(s).digest();
};

export const secretsConfigured = () => (process.env.CONNECTOR_SECRET?.length ?? 0) >= 16;

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

export function decryptJson<T>(blob: string): T | null {
  if (!blob) return null;
  try {
    const [v, iv, tag, ct] = blob.split(":");
    if (v !== "v1") return null;
    const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8")) as T;
  } catch {
    return null; // повреждено или другой ключ: считаем, что доступа нет
  }
}

/** Подпись state для OAuth: защищает возврат от подмены руководителя. */
export function signState(payload: string): string {
  return `${payload}.${createHmac("sha256", key()).update(payload).digest("hex").slice(0, 32)}`;
}

export function verifyState(state: string): string | null {
  const i = state.lastIndexOf(".");
  if (i < 0) return null;
  const payload = state.slice(0, i);
  const expect = Buffer.from(signState(payload));
  const got = Buffer.from(state);
  return expect.length === got.length && timingSafeEqual(expect, got) ? payload : null;
}
