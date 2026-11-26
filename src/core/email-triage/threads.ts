/**
 * Группировка повторных писем (SPEC 4.2, шаг 1).
 * threadKey = sha256(lower(senderEmail) | normalize(subject) | normalize(body)).
 * Повторы не выбрасываются: каждое письмо — отдельный EmailItem, occurrence растёт.
 */
import { createHash } from "node:crypto";

const REPLY_PREFIX = /^\s*((re|fwd?|fw|отв)\s*:\s*)+/i;

export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export function normalizeSubject(subject: string): string {
  return normalizeText(subject.replace(REPLY_PREFIX, ""));
}

export function threadKey(senderEmail: string, subject: string, body: string): string {
  const raw = [senderEmail.trim().toLowerCase(), normalizeSubject(subject), normalizeText(body)].join("|");
  return createHash("sha256").update(raw).digest("hex");
}

export interface RawEmail {
  externalId?: string;
  senderEmail: string;
  subject: string;
  body: string;
  receivedAt: Date;
}

export interface GroupedEmail<T extends RawEmail> {
  email: T;
  threadKey: string;
  /** 1 — первое письмо треда (его классифицируем), 2+ — повторы. */
  occurrence: number;
}

/** Порядок по receivedAt; occurrence считается внутри треда. */
export function groupThreads<T extends RawEmail>(emails: readonly T[]): GroupedEmail<T>[] {
  const counts = new Map<string, number>();
  return [...emails]
    .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
    .map((email) => {
      const key = threadKey(email.senderEmail, email.subject, email.body);
      const occurrence = (counts.get(key) ?? 0) + 1;
      counts.set(key, occurrence);
      return { email, threadKey: key, occurrence };
    });
}
