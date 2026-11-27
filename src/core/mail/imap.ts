/** IMAP (чтение, архив) + SMTP (ответы) для любого почтового сервиса. */
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import type { IncomingEmail } from "../email-triage/ingest";
import { DATASET_FROM_HEADER, FIRST_POLL_DAYS, claimedSender, htmlToText, type MailConnector, type MailFetch, type OutgoingReply } from "./types";

export interface ImapConfig {
  email: string;
  password: string;
  imapHost: string;
  smtpHost: string;
}

const DAY = 86_400_000;

/** Курсор: «uidValidity:последний обработанный UID». Сменился uidValidity — прежние UID недействительны. */
const parseCursor = (c: string | null) => {
  const m = c?.match(/^(\d+):(\d+)$/);
  return m ? { validity: m[1], uid: Number(m[2]) } : null;
};

const friendly = (e: unknown): Error => {
  const err = e as { responseText?: string; authenticationFailed?: boolean; code?: string; message?: string };
  if (err.authenticationFailed) return new Error("Почта не приняла логин или пароль приложения.");
  if (err.code === "ENOTFOUND" || err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT") return new Error("Не удалось связаться с почтовым сервером: проверьте адрес IMAP и интернет.");
  return new Error(err.responseText ?? err.message ?? "Ошибка почтового сервера");
};

export class ImapMailConnector implements MailConnector {
  constructor(private readonly cfg: ImapConfig) {}

  private client() {
    return new ImapFlow({
      host: this.cfg.imapHost,
      port: 993,
      secure: true,
      auth: { user: this.cfg.email, pass: this.cfg.password },
      logger: false,
    });
  }

  async verify(): Promise<void> {
    const c = this.client();
    c.on("error", () => undefined);
    try {
      await c.connect();
      await c.logout();
    } catch (e) {
      throw friendly(e);
    }
  }

  async listNew(cursor: string | null, limit: number): Promise<MailFetch> {
    const c = this.client();
    c.on("error", () => undefined);
    try {
      await c.connect();
      const lock = await c.getMailboxLock("INBOX");
      try {
        const box = c.mailbox as { uidValidity: bigint | number; uidNext: number };
        const validity = String(box.uidValidity);
        const cur = parseCursor(cursor);
        const last = cur && cur.validity === validity ? cur.uid : 0;

        const found = (await c.search(last ? { uid: `${last + 1}:*` } : { since: new Date(Date.now() - FIRST_POLL_DAYS * DAY) }, { uid: true })) || [];
        const uids = found.filter((u) => u > last).sort((a, b) => a - b).slice(0, limit);
        if (uids.length === 0) return { emails: [], cursor: last ? `${validity}:${last}` : `${validity}:${Math.max(0, box.uidNext - 1)}` };

        const emails: IncomingEmail[] = [];
        for await (const msg of c.fetch(uids.join(","), { uid: true, source: true, internalDate: true }, { uid: true })) {
          if (!msg.source) continue;
          const p = await simpleParser(msg.source);
          const from = p.from?.value[0];
          const address = from?.address?.toLowerCase();
          if (!address || address === this.cfg.email.toLowerCase()) continue; // свои письма не разбираем
          const recipients = [...(Array.isArray(p.to) ? p.to : p.to ? [p.to] : []), ...(Array.isArray(p.cc) ? p.cc : p.cc ? [p.cc] : [])]
            .flatMap((a) => a.value.map((v) => v.address?.toLowerCase()))
            .filter((x): x is string => Boolean(x));
          const claimed = claimedSender(address, p.headers.get(DATASET_FROM_HEADER));
          emails.push({
            externalId: `imap:${validity}:${msg.uid}`,
            messageId: p.messageId,
            senderEmail: claimed?.address ?? address,
            senderName: claimed?.name ?? (from?.name || address),
            subject: p.subject?.trim() || "(без темы)",
            body: (p.text ?? (typeof p.html === "string" ? htmlToText(p.html) : "")).trim(),
            receivedAt: p.date ?? (msg.internalDate instanceof Date ? msg.internalDate : new Date()),
            recipients,
          });
        }
        return { emails, cursor: `${validity}:${uids[uids.length - 1]}` };
      } finally {
        lock.release();
      }
    } catch (e) {
      throw friendly(e);
    } finally {
      await c.logout().catch(() => undefined);
    }
  }

  async send(r: OutgoingReply): Promise<void> {
    const t = nodemailer.createTransport({ host: this.cfg.smtpHost, port: 465, secure: true, auth: { user: this.cfg.email, pass: this.cfg.password } });
    try {
      await t.sendMail({
        from: this.cfg.email,
        to: r.to,
        subject: /^re:/i.test(r.subject) ? r.subject : `Re: ${r.subject}`,
        text: r.text,
        ...(r.inReplyTo ? { inReplyTo: r.inReplyTo, references: r.inReplyTo } : {}),
      });
    } catch (e) {
      throw friendly(e);
    }
  }

  async archive(externalId: string): Promise<void> {
    const uid = Number(externalId.split(":")[2]);
    if (!Number.isInteger(uid)) throw new Error("Неизвестный формат письма");
    const c = this.client();
    c.on("error", () => undefined);
    try {
      await c.connect();
      const boxes = await c.list();
      const archive = boxes.find((b) => b.specialUse === "\\Archive")?.path ?? boxes.find((b) => /^(archive|архив)$/i.test(b.name))?.path;
      if (!archive) throw new Error("В ящике нет папки «Архив»");
      const lock = await c.getMailboxLock("INBOX");
      try {
        await c.messageMove(String(uid), archive, { uid: true });
      } finally {
        lock.release();
      }
    } catch (e) {
      throw friendly(e);
    } finally {
      await c.logout().catch(() => undefined);
    }
  }
}
