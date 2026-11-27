/** Microsoft Graph (Outlook): чтение входящих, ответы, архив. Токены обновляются сами. */
import { z } from "zod";
import type { IncomingEmail } from "../email-triage/ingest";
import { FIRST_POLL_DAYS, htmlToText, type MailConnector, type MailFetch, type OutgoingReply } from "./types";

const API = "https://graph.microsoft.com/v1.0";
const DAY = 86_400_000;

export interface GraphTokens {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
}

export interface GraphOptions {
  tokens: GraphTokens;
  ownEmail?: string;
  /** Токены обновились: сохранить (в зашифрованном виде). */
  saveTokens: (t: GraphTokens) => Promise<void>;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Ключи приложения читаются в момент обновления токена: админ мог поменять их в панели управления. Приоритетнее clientId/clientSecret. */
  getCredentials?: () => Promise<{ clientId: string; clientSecret: string } | null>;
  fetch?: typeof fetch;
}

const MessageSchema = z.object({
  id: z.string(),
  internetMessageId: z.string().optional(),
  subject: z.string().nullable().optional(),
  receivedDateTime: z.string(),
  from: z.object({ emailAddress: z.object({ address: z.string(), name: z.string().optional() }) }).optional(),
  toRecipients: z.array(z.object({ emailAddress: z.object({ address: z.string() }) })).optional(),
  ccRecipients: z.array(z.object({ emailAddress: z.object({ address: z.string() }) })).optional(),
  body: z.object({ content: z.string().optional(), contentType: z.string().optional() }).optional(),
});
const ListSchema = z.object({ value: z.array(MessageSchema) });
const TokenSchema = z.object({ access_token: z.string(), refresh_token: z.string().optional(), expires_in: z.number().optional() });

export class GraphMailConnector implements MailConnector {
  private tokens: GraphTokens;
  private readonly f: typeof fetch;

  constructor(private readonly o: GraphOptions) {
    this.tokens = { ...o.tokens };
    this.f = o.fetch ?? fetch;
  }

  private async token(): Promise<string> {
    const t = this.tokens;
    if (t.access_token && (!t.expires_at || t.expires_at - Date.now() > 60_000)) return t.access_token;
    if (!t.refresh_token) throw new Error("Доступ к Outlook истёк: войдите заново.");
    const cred = (await this.o.getCredentials?.()) ?? { clientId: this.o.clientId, clientSecret: this.o.clientSecret };
    const res = await this.f(this.o.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: cred.clientId, client_secret: cred.clientSecret, grant_type: "refresh_token", refresh_token: t.refresh_token }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error("Доступ к Outlook истёк: войдите заново.");
    const n = TokenSchema.parse(await res.json());
    this.tokens = { access_token: n.access_token, refresh_token: n.refresh_token ?? t.refresh_token, expires_at: n.expires_in ? Date.now() + n.expires_in * 1000 : undefined };
    await this.o.saveTokens(this.tokens);
    return this.tokens.access_token!;
  }

  private async g(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.f(`${API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${await this.token()}`, "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401) throw new Error("Outlook не принял доступ: войдите заново.");
    if (!res.ok) throw new Error(`Outlook ответил ${res.status}`);
    return res;
  }

  async verify(): Promise<void> {
    await this.g("/me?$select=mail");
  }

  async listNew(cursor: string | null, limit: number): Promise<MailFetch> {
    const since = cursor ?? new Date(Date.now() - FIRST_POLL_DAYS * DAY).toISOString();
    const q = new URLSearchParams({
      $filter: `receivedDateTime gt ${since}`,
      $orderby: "receivedDateTime asc",
      $top: String(limit),
      $select: "id,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,body",
    });
    const res = await this.g(`/me/mailFolders/inbox/messages?${q}`, { headers: { prefer: 'outlook.body-content-type="text"' } });
    const list = ListSchema.parse(await res.json()).value;
    const own = this.o.ownEmail?.toLowerCase();
    const emails: IncomingEmail[] = [];
    for (const m of list) {
      const address = m.from?.emailAddress.address.toLowerCase();
      if (!address || address === own) continue;
      const body = m.body?.content ?? "";
      emails.push({
        externalId: m.id,
        messageId: m.internetMessageId,
        senderEmail: address,
        senderName: m.from?.emailAddress.name || address,
        subject: m.subject?.trim() || "(без темы)",
        body: (m.body?.contentType === "html" ? htmlToText(body) : body).trim(),
        receivedAt: new Date(m.receivedDateTime),
        recipients: [...(m.toRecipients ?? []), ...(m.ccRecipients ?? [])].map((r) => r.emailAddress.address.toLowerCase()),
      });
    }
    return { emails, cursor: list.at(-1)?.receivedDateTime ?? since };
  }

  async send(r: OutgoingReply): Promise<void> {
    if (r.externalId) {
      await this.g(`/me/messages/${encodeURIComponent(r.externalId)}/reply`, { method: "POST", body: JSON.stringify({ comment: r.text }) });
      return;
    }
    await this.g("/me/sendMail", {
      method: "POST",
      body: JSON.stringify({ message: { subject: r.subject, body: { contentType: "Text", content: r.text }, toRecipients: [{ emailAddress: { address: r.to } }] } }),
    });
  }

  async archive(externalId: string): Promise<void> {
    await this.g(`/me/messages/${encodeURIComponent(externalId)}/move`, { method: "POST", body: JSON.stringify({ destinationId: "archive" }) });
  }
}
