/** Google Calendar API: чтение событий и запись (создать, перенести, отменить). Токены обновляются сами. */
import { z } from "zod";
import { meetingUrlFromFields } from "../dataset/ics";

const API = "https://www.googleapis.com/calendar/v3/calendars/primary";
const MAX_EVENTS = 500;

export interface GoogleTokens {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
}

export interface GoogleCalendarOptions {
  tokens: GoogleTokens;
  ownEmail?: string;
  saveTokens: (t: GoogleTokens) => Promise<void>;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Ключи приложения читаются в момент обновления токена: админ мог поменять их в панели управления. */
  getCredentials?: () => Promise<{ clientId: string; clientSecret: string } | null>;
  fetch?: typeof fetch;
}

/** Событие календаря в том виде, в каком его читает остальной код (время — реальное, не демо). */
export interface RemoteEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  attendees: string[];
  meetingUrl: string | null;
  /** Руководитель отклонил приглашение: встреча ему не нужна. */
  declined: boolean;
}

export interface NewEvent {
  title: string;
  start: Date;
  end: Date;
  attendees?: string[];
  /** Ссылка на видеовстречу (Zoom и др.): кладётся в место и описание, оттуда её читает синхронизация. */
  meetingUrl?: string;
  /** Рассылать ли приглашения участникам: письмо уйдёт от имени руководителя. */
  notify: boolean;
}

const EventSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  hangoutLink: z.string().optional(),
  start: z.object({ dateTime: z.string().optional(), date: z.string().optional() }),
  end: z.object({ dateTime: z.string().optional(), date: z.string().optional() }),
  attendees: z.array(z.object({ email: z.string().optional(), self: z.boolean().optional(), responseStatus: z.string().optional() })).optional(),
});
const ListSchema = z.object({ items: z.array(EventSchema).default([]), nextPageToken: z.string().optional() });
const TokenSchema = z.object({ access_token: z.string(), refresh_token: z.string().optional(), expires_in: z.number().optional() });

/** Весь день (без часов) и отменённые события не встречи: пропускаем. */
export function toRemoteEvent(raw: unknown): RemoteEvent | null {
  const e = EventSchema.parse(raw);
  if (e.status === "cancelled" || !e.start.dateTime || !e.end.dateTime) return null;
  const start = new Date(e.start.dateTime);
  const end = new Date(e.end.dateTime);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
  const attendees = (e.attendees ?? []).flatMap((a) => (a.email && !a.self ? [a.email.toLowerCase()] : []));
  return {
    id: e.id,
    title: e.summary?.trim() || "(без названия)",
    start,
    end,
    attendees,
    meetingUrl: e.hangoutLink ?? meetingUrlFromFields([e.location, e.description]),
    declined: (e.attendees ?? []).some((a) => a.self && a.responseStatus === "declined"),
  };
}

export class GoogleCalendarClient {
  private tokens: GoogleTokens;
  private readonly f: typeof fetch;

  constructor(private readonly o: GoogleCalendarOptions) {
    this.tokens = { ...o.tokens };
    this.f = o.fetch ?? fetch;
  }

  private async token(): Promise<string> {
    const t = this.tokens;
    if (t.access_token && (!t.expires_at || t.expires_at - Date.now() > 60_000)) return t.access_token;
    if (!t.refresh_token) throw new Error("Доступ к Google Календарю истёк: войдите заново.");
    const cred = (await this.o.getCredentials?.()) ?? { clientId: this.o.clientId, clientSecret: this.o.clientSecret };
    const res = await this.f(this.o.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: cred.clientId, client_secret: cred.clientSecret, grant_type: "refresh_token", refresh_token: t.refresh_token }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error("Доступ к Google Календарю истёк: войдите заново.");
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
    if (res.status === 401) throw new Error("Google Календарь не принял доступ: войдите заново.");
    if (res.status === 403) throw new Error("У Google Календаря нет нужных прав: войдите заново и разрешите доступ к календарю.");
    if (res.status === 404 || res.status === 410) throw new Error("Встречи уже нет в Google Календаре.");
    if (!res.ok) throw new Error(`Google Календарь ответил ${res.status}`);
    return res;
  }

  async verify(): Promise<void> {
    await this.g("/events?maxResults=1");
  }

  /** Встречи в окне [from, to): повторяющиеся раскрыты в отдельные события, события на весь день пропущены. */
  async listEvents(from: Date, to: Date): Promise<RemoteEvent[]> {
    const out: RemoteEvent[] = [];
    let page: string | undefined;
    do {
      const q = new URLSearchParams({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "250",
        ...(page ? { pageToken: page } : {}),
      });
      const list = ListSchema.parse(await (await this.g(`/events?${q}`)).json());
      for (const raw of list.items) {
        const e = toRemoteEvent(raw);
        if (e) out.push(e);
      }
      page = list.nextPageToken;
    } while (page && out.length < MAX_EVENTS);
    return out;
  }

  async createEvent(e: NewEvent): Promise<string> {
    const body = {
      summary: e.title,
      start: { dateTime: e.start.toISOString() },
      end: { dateTime: e.end.toISOString() },
      ...(e.attendees?.length ? { attendees: e.attendees.map((email) => ({ email })) } : {}),
      ...(e.meetingUrl ? { location: e.meetingUrl, description: e.meetingUrl } : {}),
    };
    const q = new URLSearchParams({ sendUpdates: e.notify ? "all" : "none" });
    const res = await this.g(`/events?${q}`, { method: "POST", body: JSON.stringify(body) });
    return z.object({ id: z.string() }).parse(await res.json()).id;
  }

  async moveEvent(id: string, start: Date, end: Date, notify: boolean): Promise<void> {
    const q = new URLSearchParams({ sendUpdates: notify ? "all" : "none" });
    await this.g(`/events/${encodeURIComponent(id)}?${q}`, {
      method: "PATCH",
      body: JSON.stringify({ start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } }),
    });
  }

  async cancelEvent(id: string, notify: boolean): Promise<void> {
    const q = new URLSearchParams({ sendUpdates: notify ? "all" : "none" });
    await this.g(`/events/${encodeURIComponent(id)}?${q}`, { method: "DELETE" });
  }
}
