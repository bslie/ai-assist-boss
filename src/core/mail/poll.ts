/**
 * Опрос почты (SPEC 4.2): новые письма из подключения → разбор → карточки.
 * Читаем только при включённом подключении и праве `mail.read`. Архив рассылок — через Policy Gate,
 * только при праве AUTO. Курсор и итог опроса лежат в зашифрованной конфигурации подключения.
 */
import Redis from "ioredis";
import type { PrismaClient } from "@/generated/prisma/client";
import { decryptJson } from "../connectors/crypto";
import { patchStored, type Stored } from "../connectors/service";
import { ingestEmails, type IngestOptions, type IngestStats } from "../email-triage/ingest";
import type { LlmClient } from "../llm";
import { evaluate, getConnectorToolPermission, loadGateLeader, logVerdict } from "../policy-gate";
import { clock } from "../clock";
import { createMailConnector, isMailType, MAIL_TYPES } from "./factory";
import { markHandledEmails } from "./mark-read";
import type { MailConnector } from "./types";

const BATCH = 30;

export type PollResult =
  | { ok: true; fetched: number; stats: IngestStats; archived: number }
  | { ok: false; skipped: boolean; message: string };

export interface PollDeps {
  llm: LlmClient;
  draft?: IngestOptions["draft"];
  criteria?: IngestOptions["criteria"];
  emit?: IngestOptions["emit"];
  /** Подмена в тестах: готовое подключение вместо сетевого. */
  connector?: MailConnector;
  /** Взять блокировку на время опроса; false — другой процесс уже опрашивает. */
  lock?: (key: string, ttlSec: number) => Promise<(() => Promise<void>) | null>;
}

let redis: Redis | null = null;
/** Блокировка в Redis: web и воркер — разные процессы, а дубль опроса создал бы двойные карточки. Нет Redis → не опрашиваем. */
export async function redisLock(key: string, ttlSec: number): Promise<(() => Promise<void>) | null> {
  try {
    redis ??= new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 1 });
    const ok = await redis.set(`lock:${key}`, "1", "EX", ttlSec, "NX");
    return ok ? async () => void (await redis!.del(`lock:${key}`)) : null;
  } catch {
    return null;
  }
}

export async function pollConnector(db: PrismaClient, leaderId: string, connectorId: string, deps: PollDeps): Promise<PollResult> {
  const row = await db.connector.findFirst({ where: { id: connectorId, leaderId } });
  if (!row || !isMailType(row.type)) return { ok: false, skipped: true, message: "Это не почтовое подключение" };
  if (!row.isActive) return { ok: false, skipped: true, message: "Подключение выключено" };
  const perm = await getConnectorToolPermission(db, leaderId, connectorId, "mail.read");
  if (perm === "DENY") return { ok: false, skipped: true, message: "Чтение почты вам запретили в правах" };

  const release = await (deps.lock ?? redisLock)(`poll:${connectorId}`, 120);
  if (!release) return { ok: false, skipped: true, message: "Почту уже проверяют" };
  const mail = deps.connector ?? createMailConnector(db, row);
  try {
    if (!mail) return { ok: false, skipped: false, message: "Нет доступа к почте: войдите заново в разделе «Подключения»" };
    const stored = decryptJson<Stored>(row.encryptedConfig);
    const fetched = await mail.listNew(stored?.cursor ?? null, BATCH);
    const cursor = fetched.cursor;
    // Письма приходят в реальном времени, а система живёт в демо-часах (SPEC 4.7): время получения переводим в демо.
    const emails = fetched.emails.map((e) => ({ ...e, receivedAt: clock.toDemo(e.receivedAt) }));

    const stats = await ingestEmails(db, deps.llm, leaderId, emails, { connectorId, draft: deps.draft, criteria: deps.criteria, emit: deps.emit });
    const archived = await archiveNewsletters(db, leaderId, connectorId, mail, emails.map((e) => e.externalId).filter((x): x is string => Boolean(x)));

    // Обработанные письма становятся прочитанными в ящике; проигнорированные (служебные, рассылки) остаются как есть.
    await markHandledEmails(db, leaderId).catch(() => undefined);

    await patchStored(db, row, { cursor, lastSync: { at: clock.now().toISOString(), fetched: emails.length } });
    return { ok: true, fetched: emails.length, stats, archived };
  } catch (e) {
    const message = (e as Error).message;
    // Курсор не двигаем: следующий опрос повторит те же письма, дубли отсечёт externalId.
    await patchStored(db, row, { lastSync: { at: clock.now().toISOString(), fetched: 0, error: message } }).catch(() => undefined);
    return { ok: false, skipped: false, message };
  } finally {
    await release();
  }
}

/** Рассылки, которые правила отправили в архив: убираем из ящика только если право `mail.archive` = AUTO и шлюз разрешил. */
async function archiveNewsletters(db: PrismaClient, leaderId: string, connectorId: string, mail: MailConnector, externalIds: string[]): Promise<number> {
  if (externalIds.length === 0) return 0;
  const perm = await getConnectorToolPermission(db, leaderId, connectorId, "mail.archive");
  if (perm !== "AUTO") return 0; // по умолчанию письмо остаётся во входящих, помощник лишь не показывает его
  const items = await db.emailItem.findMany({ where: { leaderId, externalId: { in: externalIds }, action: "IGNORE", NOT: { category: "SYSTEM_NOTICE" } } });
  const leader = await loadGateLeader(db, leaderId);
  let n = 0;
  for (const it of items) {
    const verdict = evaluate("mail.archive", { leader, category: it.category, confidence: it.confidence, toolPermission: perm });
    await logVerdict(db, leaderId, "mail.archive", verdict, { metadata: { emailId: it.externalId } });
    if (verdict.verdict !== "ALLOW" || !it.externalId) continue;
    try {
      await mail.archive(it.externalId);
      n++;
    } catch {
      // не получилось убрать из ящика: письмо уже разобрано, повторять нечего
    }
  }
  return n;
}

/** Все включённые почтовые подключения (для воркера). */
export async function activeMailConnectors(db: PrismaClient): Promise<{ id: string; leaderId: string }[]> {
  return db.connector.findMany({ where: { isActive: true, type: { in: [...MAIL_TYPES] } }, select: { id: true, leaderId: true } });
}
