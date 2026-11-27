/**
 * Ключи OAuth-приложений (Google, Microsoft): Client ID и Client secret задаёт ADMIN в панели управления.
 * Хранятся в AppSetting в зашифрованном виде. Это единственные настройки интеграций, которые не пользовательские:
 * приложение в Google Cloud одно на весь сервис. Переменные GOOGLE_CLIENT_ID/SECRET и MS_CLIENT_ID/SECRET остаются запасным путём.
 * Секрет наружу не отдаётся никогда: интерфейсу доступен только факт настройки и хвост Client ID.
 */
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { decryptJson, encryptJson } from "./crypto";
import type { ConnectorManifest } from "./types";

export interface OAuthAppDef {
  key: "google" | "microsoft";
  label: string;
  /** Где в кабинете сервиса создаётся приложение. */
  consoleUrl: string;
  envId: string;
  envSecret: string;
}

export const OAUTH_APPS: OAuthAppDef[] = [
  { key: "google", label: "Google (Gmail, Календарь)", consoleUrl: "https://console.cloud.google.com/auth/clients", envId: "GOOGLE_CLIENT_ID", envSecret: "GOOGLE_CLIENT_SECRET" },
  { key: "microsoft", label: "Microsoft 365 (почта)", consoleUrl: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade", envId: "MS_CLIENT_ID", envSecret: "MS_CLIENT_SECRET" },
];

const defOf = (key: string) => OAUTH_APPS.find((a) => a.key === key);
const settingKey = (key: string) => `oauth:${key}`;

export interface OAuthApp {
  clientId: string;
  clientSecret: string;
  source: "db" | "env";
}

const StoredSchema = z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1) });

async function fromDb(db: PrismaClient, key: string): Promise<{ clientId: string; clientSecret: string } | null> {
  const row = await db.appSetting.findUnique({ where: { key: settingKey(key) } });
  const parsed = row ? StoredSchema.safeParse(decryptJson(row.encryptedValue)) : null;
  return parsed?.success ? parsed.data : null;
}

export async function loadOAuthAppByKey(db: PrismaClient, key: string): Promise<OAuthApp | null> {
  const def = defOf(key);
  if (!def) return null;
  const stored = await fromDb(db, key);
  if (stored) return { ...stored, source: "db" };
  const clientId = process.env[def.envId];
  const clientSecret = process.env[def.envSecret];
  return clientId && clientSecret ? { clientId, clientSecret, source: "env" } : null;
}

/** Ключи приложения для модуля подключения (oauth). */
export const loadOAuthApp = (db: PrismaClient, m: ConnectorManifest) => (m.auth.kind === "oauth" ? loadOAuthAppByKey(db, m.auth.appKey) : Promise.resolve(null));

/** Для каталога: какие приложения уже настроены. */
export async function configuredOAuthApps(db: PrismaClient): Promise<Set<string>> {
  const out = new Set<string>();
  for (const a of OAUTH_APPS) if (await loadOAuthAppByKey(db, a.key)) out.add(a.key);
  return out;
}

export interface OAuthAppStatus {
  key: string;
  label: string;
  consoleUrl: string;
  configured: boolean;
  source: "db" | "env" | null;
  /** Последние символы Client ID, чтобы узнать, какой именно ключ записан. */
  clientIdTail: string | null;
}

export async function oauthAppStatuses(db: PrismaClient): Promise<OAuthAppStatus[]> {
  const out: OAuthAppStatus[] = [];
  for (const a of OAUTH_APPS) {
    const app = await loadOAuthAppByKey(db, a.key);
    out.push({ key: a.key, label: a.label, consoleUrl: a.consoleUrl, configured: Boolean(app), source: app?.source ?? null, clientIdTail: app ? app.clientId.slice(-12) : null });
  }
  return out;
}

export const SaveOAuthAppSchema = z.object({
  key: z.enum(["google", "microsoft"]),
  clientId: z.string().trim().min(10, "Client ID выглядит слишком коротким").max(300),
  /** Пусто — оставить прежний секрет (при смене только Client ID). */
  clientSecret: z.string().trim().max(500).optional(),
});
export type SaveOAuthAppInput = z.infer<typeof SaveOAuthAppSchema>;

export type SaveResult = { ok: true } | { ok: false; message: string };

export async function saveOAuthApp(db: PrismaClient, input: SaveOAuthAppInput): Promise<SaveResult> {
  const prev = await fromDb(db, input.key);
  const clientSecret = input.clientSecret || prev?.clientSecret;
  if (!clientSecret) return { ok: false, message: "Укажите Client secret" };
  if (input.key === "google" && !input.clientId.endsWith(".apps.googleusercontent.com")) {
    return { ok: false, message: "Client ID Google заканчивается на .apps.googleusercontent.com: проверьте, что скопировали его целиком" };
  }
  let encryptedValue: string;
  try {
    encryptedValue = encryptJson({ clientId: input.clientId, clientSecret });
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  await db.appSetting.upsert({ where: { key: settingKey(input.key) }, create: { key: settingKey(input.key), encryptedValue }, update: { encryptedValue } });
  return { ok: true };
}

export async function deleteOAuthApp(db: PrismaClient, key: string): Promise<void> {
  await db.appSetting.deleteMany({ where: { key: settingKey(key) } });
}
