/**
 * Единый интерфейс почтового подключения. Реализации (IMAP, Microsoft Graph) прячут протокол;
 * всё, что меняет внешнее состояние (send, archive), вызывается только через Policy Gate.
 */
import type { IncomingEmail } from "../email-triage/ingest";

export interface MailFetch {
  emails: IncomingEmail[];
  /** Курсор для следующего опроса: непрозрачная строка, у каждой реализации своя. */
  cursor: string;
}

export interface OutgoingReply {
  to: string;
  subject: string;
  text: string;
  /** Письмо, на которое отвечаем (externalId из IncomingEmail). */
  externalId?: string | null;
  /** Message-ID исходного письма, для заголовка In-Reply-To. */
  inReplyTo?: string | null;
}

export interface MailConnector {
  /** Проверка доступов: вход в ящик без чтения писем. Бросает понятную ошибку. */
  verify(): Promise<void>;
  /** Новые письма после курсора (null — первый опрос: только последние дни). Не более `limit` за раз. */
  listNew(cursor: string | null, limit: number): Promise<MailFetch>;
  send(reply: OutgoingReply): Promise<void>;
  archive(externalId: string): Promise<void>;
}

/** Сколько назад смотрим при первом опросе, чтобы не затопить руководителя старой перепиской. */
export const FIRST_POLL_DAYS = 3;

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
