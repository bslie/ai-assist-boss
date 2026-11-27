/** Сборка календарного подключения из записи Connector: расшифровка доступов и токены. */
import type { PrismaClient } from "@/generated/prisma/client";
import { decryptJson, encryptJson } from "../connectors/crypto";
import { getModule } from "../connectors/modules";
import { loadOAuthApp } from "../connectors/oauth-app";
import { GoogleCalendarClient } from "./google";

export const CALENDAR_TYPES = ["BUILTIN_GOOGLE_CALENDAR"] as const;
export const isCalendarType = (t: string) => (CALENDAR_TYPES as readonly string[]).includes(t);

interface Stored {
  tokens?: { access_token?: string; refresh_token?: string; expires_at?: number };
  account?: string;
}

export function createCalendarClient(db: PrismaClient, row: { id: string; leaderId: string; type: string; encryptedConfig: string }): GoogleCalendarClient | null {
  if (!isCalendarType(row.type)) return null;
  const stored = decryptJson<Stored>(row.encryptedConfig);
  const m = getModule(row.type);
  if (!stored?.tokens || m?.auth.kind !== "oauth") return null;
  return new GoogleCalendarClient({
    tokens: stored.tokens,
    ownEmail: stored.account,
    tokenUrl: m.auth.tokenUrl,
    clientId: "",
    clientSecret: "",
    getCredentials: () => loadOAuthApp(db, m),
    saveTokens: async (tokens) => {
      const fresh = await db.connector.findFirst({ where: { id: row.id, leaderId: row.leaderId }, select: { encryptedConfig: true } });
      const cur = (fresh && decryptJson<Stored>(fresh.encryptedConfig)) ?? stored;
      await db.connector.updateMany({ where: { id: row.id, leaderId: row.leaderId }, data: { encryptedConfig: encryptJson({ ...cur, tokens }) } });
    },
  });
}

/** Адрес аккаунта, под которым подключён календарь: по нему отличаем своих от внешних участников. */
export function calendarAccount(row: { encryptedConfig: string }): string | null {
  return decryptJson<Stored>(row.encryptedConfig)?.account?.toLowerCase() ?? null;
}
