import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

// Параметры фиксированы и записываются в хэш: при смене параметров старые пароли остаются проверяемыми.
const PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEYLEN = 64;

/** Хэш вида `scrypt$N$r$p$salt$hash` (base64). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, PARAMS);
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

type ParsedHash = { params: { N: number; r: number; p: number }; salt: Buffer; hash: Buffer };

function parseHash(stored: string | null): ParsedHash | null {
  const parts = stored?.split("$");
  if (!parts || parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [, n, r, p, saltB64, hashB64] = parts;
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (!Object.values(params).every((v) => Number.isInteger(v) && v > 0)) return null;
  const hash = Buffer.from(hashB64, "base64");
  if (hash.length === 0) return null;
  return { params, salt: Buffer.from(saltB64, "base64"), hash };
}

// Соль для холостого расчёта: при отсутствующем или битом хэше scrypt всё равно считается,
// чтобы по времени ответа нельзя было узнать, есть ли такой логин и задан ли у него пароль.
const DUMMY_SALT = randomBytes(16);

/** Проверка пароля за постоянное время. Любой неразобранный хэш — отказ (fail closed). */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) {
    await scrypt(password, DUMMY_SALT, KEYLEN, PARAMS);
    return false;
  }
  try {
    const actual = await scrypt(password, parsed.salt, parsed.hash.length, parsed.params);
    return actual.length === parsed.hash.length && timingSafeEqual(actual, parsed.hash);
  } catch {
    return false; // параметры из хэша не приняты scrypt
  }
}
