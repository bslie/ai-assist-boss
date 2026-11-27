/** Сборка почтового подключения из записи Connector: расшифровка доступов и выбор реализации. */
import type { PrismaClient } from "@/generated/prisma/client";
import { decryptJson, encryptJson } from "../connectors/crypto";
import { getModule } from "../connectors/modules";
import { loadOAuthApp } from "../connectors/oauth-app";
import { GmailMailConnector } from "./gmail";
import { GraphMailConnector } from "./graph";
import { ImapMailConnector, type ImapConfig } from "./imap";
import type { MailConnector } from "./types";

export const MAIL_TYPES = ["BUILTIN_IMAP", "BUILTIN_GRAPH", "BUILTIN_GMAIL"] as const;
export const isMailType = (t: string) => (MAIL_TYPES as readonly string[]).includes(t);

interface Stored {
  values?: Record<string, string>;
  tokens?: { access_token?: string; refresh_token?: string; expires_at?: number };
  account?: string;
}

const imapFrom = (v: Record<string, string> | undefined): ImapConfig | null =>
  v?.email && v.password && v.imapHost && v.smtpHost ? { email: v.email, password: v.password, imapHost: v.imapHost, smtpHost: v.smtpHost } : null;

/** Вход в ящик при подключении: ошибка паролей видна сразу, а не при первом опросе. Для не-IMAP модулей ничего не делает. */
export async function verifyMailCredentials(moduleId: string, values: Record<string, string>): Promise<void> {
  if (moduleId !== "BUILTIN_IMAP") return;
  const cfg = imapFrom(values);
  if (cfg) await new ImapMailConnector(cfg).verify();
}

export function createMailConnector(db: PrismaClient, row: { id: string; leaderId: string; type: string; encryptedConfig: string }): MailConnector | null {
  const stored = decryptJson<Stored>(row.encryptedConfig);
  if (!stored) return null;
  if (row.type === "BUILTIN_IMAP") {
    const cfg = imapFrom(stored.values);
    return cfg ? new ImapMailConnector(cfg) : null;
  }
  if (row.type === "BUILTIN_GRAPH" || row.type === "BUILTIN_GMAIL") {
    const m = getModule(row.type);
    if (!stored.tokens || m?.auth.kind !== "oauth") return null;
    const Impl = row.type === "BUILTIN_GMAIL" ? GmailMailConnector : GraphMailConnector;
    return new Impl({
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
  return null;
}
