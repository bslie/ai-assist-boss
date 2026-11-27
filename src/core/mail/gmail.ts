/** Gmail API: чтение входящих, ответы в ту же ветку, архив. Токены обновляются сами. */
import MailComposer from "nodemailer/lib/mail-composer";
import { z } from "zod";
import type { IncomingEmail } from "../email-triage/ingest";
import { FIRST_POLL_DAYS, htmlToText, type MailConnector, type MailFetch, type OutgoingReply } from "./types";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const DAY = 86_400_000;
/** Сколько идентификаторов просматриваем за опрос: хватает, чтобы не потерять письма при редком опросе. */
const MAX_IDS = 200;

export interface GmailTokens {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
}

export interface GmailOptions {
  tokens: GmailTokens;
  ownEmail?: string;
  saveTokens: (t: GmailTokens) => Promise<void>;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Ключи приложения читаются в момент обновления токена: админ мог поменять их в панели управления. Приоритетнее clientId/clientSecret. */
  getCredentials?: () => Promise<{ clientId: string; clientSecret: string } | null>;
  fetch?: typeof fetch;
}

interface Part {
  mimeType?: string;
  body?: { data?: string };
  parts?: Part[];
}
const PartSchema: z.ZodType<Part> = z.lazy(() =>
  z.object({ mimeType: z.string().optional(), body: z.object({ data: z.string().optional() }).optional(), parts: z.array(PartSchema).optional() }),
);
const MessageSchema = z.object({
  id: z.string(),
  threadId: z.string().optional(),
  internalDate: z.string(),
  payload: z.object({ headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]), mimeType: z.string().optional(), body: z.object({ data: z.string().optional() }).optional(), parts: z.array(PartSchema).optional() }),
});
const ListSchema = z.object({ messages: z.array(z.object({ id: z.string() })).optional(), nextPageToken: z.string().optional() });
const TokenSchema = z.object({ access_token: z.string(), refresh_token: z.string().optional(), expires_in: z.number().optional() });

const b64 = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

/** Текстовая часть письма: plain, иначе html без тегов. */
function bodyOf(p: Part): string {
  const find = (x: Part, type: string): string | null => {
    if (x.mimeType === type && x.body?.data) return b64(x.body.data);
    for (const c of x.parts ?? []) {
      const r = find(c, type);
      if (r) return r;
    }
    return null;
  };
  const plain = find(p, "text/plain");
  if (plain) return plain.trim();
  const html = find(p, "text/html");
  return html ? htmlToText(html) : "";
}

/** «Имя <адрес>» или просто адрес. */
function parseAddress(v: string): { name: string; address: string } | null {
  const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/) ?? v.match(/^\s*()([^\s<>@]+@[^\s<>]+)\s*$/);
  return m ? { name: m[1].trim(), address: m[2].trim().toLowerCase() } : null;
}

export class GmailMailConnector implements MailConnector {
  private tokens: GmailTokens;
  private readonly f: typeof fetch;

  constructor(private readonly o: GmailOptions) {
    this.tokens = { ...o.tokens };
    this.f = o.fetch ?? fetch;
  }

  private async token(): Promise<string> {
    const t = this.tokens;
    if (t.access_token && (!t.expires_at || t.expires_at - Date.now() > 60_000)) return t.access_token;
    if (!t.refresh_token) throw new Error("Доступ к Gmail истёк: войдите заново.");
    const cred = (await this.o.getCredentials?.()) ?? { clientId: this.o.clientId, clientSecret: this.o.clientSecret };
    const res = await this.f(this.o.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: cred.clientId, client_secret: cred.clientSecret, grant_type: "refresh_token", refresh_token: t.refresh_token }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error("Доступ к Gmail истёк: войдите заново.");
    const n = TokenSchema.parse(await res.json());
    // Google не присылает refresh_token при обновлении: прежний остаётся действующим.
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
    if (res.status === 401) throw new Error("Gmail не принял доступ: войдите заново.");
    if (res.status === 403) throw new Error("У Gmail нет нужных прав: войдите заново и разрешите доступ к почте.");
    if (!res.ok) throw new Error(`Gmail ответил ${res.status}`);
    return res;
  }

  async verify(): Promise<void> {
    await this.g("/profile");
  }

  async listNew(cursor: string | null, limit: number): Promise<MailFetch> {
    // after: принимает секунды; берём с запасом в секунду, дубли отсекает externalId.
    const afterSec = cursor ? Math.max(0, Number(cursor) - 1) : Math.floor((Date.now() - FIRST_POLL_DAYS * DAY) / 1000);
    const ids: string[] = [];
    let page: string | undefined;
    do {
      const q = new URLSearchParams({ q: `in:inbox after:${afterSec}`, maxResults: "100", ...(page ? { pageToken: page } : {}) });
      const list = ListSchema.parse(await (await this.g(`/messages?${q}`)).json());
      ids.push(...(list.messages ?? []).map((m) => m.id));
      page = list.nextPageToken;
    } while (page && ids.length < MAX_IDS);

    // Gmail отдаёт новые первыми; разбираем от старых к новым, чтобы курсор не перескочил через непрочитанное.
    const batch = ids.reverse().slice(0, limit);
    const own = this.o.ownEmail?.toLowerCase();
    const emails: IncomingEmail[] = [];
    let latest = cursor ? Number(cursor) : afterSec;
    for (const id of batch) {
      const m = MessageSchema.parse(await (await this.g(`/messages/${encodeURIComponent(id)}?format=full`)).json());
      const ms = Number(m.internalDate);
      latest = Math.max(latest, Math.floor(ms / 1000));
      const h = (n: string) => m.payload.headers.find((x) => x.name.toLowerCase() === n)?.value ?? "";
      const from = parseAddress(h("from"));
      if (!from || from.address === own) continue;
      emails.push({
        externalId: m.id,
        messageId: h("message-id") || undefined,
        senderEmail: from.address,
        senderName: from.name || from.address,
        subject: h("subject").trim() || "(без темы)",
        body: bodyOf(m.payload),
        receivedAt: new Date(ms),
        recipients: [h("to"), h("cc")].flatMap((v) => v.split(",")).map((v) => parseAddress(v)?.address).filter((x): x is string => Boolean(x)),
      });
    }
    return { emails, cursor: String(latest) };
  }

  async send(r: OutgoingReply): Promise<void> {
    let threadId: string | undefined;
    if (r.externalId) {
      const meta = z.object({ threadId: z.string().optional() }).parse(await (await this.g(`/messages/${encodeURIComponent(r.externalId)}?format=minimal`)).json());
      threadId = meta.threadId;
    }
    const raw = await new MailComposer({
      to: r.to,
      subject: /^re:/i.test(r.subject) ? r.subject : `Re: ${r.subject}`,
      text: r.text,
      ...(r.inReplyTo ? { inReplyTo: r.inReplyTo, references: r.inReplyTo } : {}),
    })
      .compile()
      .build();
    await this.g("/messages/send", { method: "POST", body: JSON.stringify({ raw: raw.toString("base64url"), ...(threadId ? { threadId } : {}) }) });
  }

  async archive(externalId: string): Promise<void> {
    await this.g(`/messages/${encodeURIComponent(externalId)}/modify`, { method: "POST", body: JSON.stringify({ removeLabelIds: ["INBOX"] }) });
  }
}
