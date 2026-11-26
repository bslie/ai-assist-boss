/**
 * Отправка писем датасета в реальный тестовый ящик руководителя (SPEC 8):
 *   npm run mail:send -- [--all] [--speed N] [--to адрес] [--dry-run]
 *
 * По умолчанию уходят 17 уникальных тредов (первое письмо каждого); `--all` — все 80 строк.
 * `--speed N` сжимает паузу между письмами в N раз (базовая пауза 30 с), `--speed 0` — без пауз.
 * Письма уходят из одного тестового SMTP-аккаунта, а настоящий отправитель из датасета передаётся
 * заголовком X-Dataset-From. Воркер принимает его только от адреса MAIL_DATASET_SENDER
 * (`src/core/mail/types.ts`), поэтому в окружении воркера эта переменная должна совпадать с DATASET_SMTP_USER.
 *
 * Окружение: DATASET_SMTP_HOST, DATASET_SMTP_PORT (465), DATASET_SMTP_USER, DATASET_SMTP_PASS,
 * DATASET_TARGET_EMAIL (ящик руководителя; можно `--to`). Пароль приложения, не основной.
 */
import "dotenv/config";
import nodemailer from "nodemailer";
import { z } from "zod";
import { loadInbox, type InboxMail } from "@/core/dataset";
import { threadKey } from "@/core/email-triage/threads";
import { DATASET_FROM_HEADER } from "@/core/mail/types";

const BASE_PAUSE_MS = 30_000;

export interface Plan {
  mails: InboxMail[];
  /** Пауза между письмами, мс. */
  pauseMs: number;
}

export function parseArgs(argv: readonly string[]): { all: boolean; speed: number; to: string | null; dryRun: boolean } {
  const val = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const speedRaw = val("--speed");
  const speed = speedRaw === undefined ? 1 : Number(speedRaw);
  if (!Number.isFinite(speed) || speed < 0) throw new Error(`--speed: ожидалось число ≥ 0, получено «${speedRaw}»`);
  return { all: argv.includes("--all"), speed, to: val("--to") ?? null, dryRun: argv.includes("--dry-run") };
}

/** Что отправлять и с какой паузой. Чистая функция: проверяется без сети. */
export function buildPlan(inbox: readonly InboxMail[], opts: { all: boolean; speed: number }): Plan {
  const sorted = [...inbox].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  const seen = new Set<string>();
  const mails = opts.all
    ? sorted
    : sorted.filter((m) => {
        const key = threadKey(m.senderEmail, m.subject, m.body);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  return { mails, pauseMs: opts.speed === 0 ? 0 : Math.round(BASE_PAUSE_MS / opts.speed) };
}

const Env = z.object({
  DATASET_SMTP_HOST: z.string().min(1),
  DATASET_SMTP_PORT: z.coerce.number().int().default(465),
  DATASET_SMTP_USER: z.string().min(3),
  DATASET_SMTP_PASS: z.string().min(1),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = buildPlan(loadInbox(), args);
  const target = args.to ?? process.env.DATASET_TARGET_EMAIL;
  console.log(`К отправке: ${plan.mails.length} писем${args.all ? " (все строки)" : " (уникальные треды)"}, пауза ${plan.pauseMs / 1000} с.`);

  if (args.dryRun) {
    for (const m of plan.mails) console.log(`${m.externalId}  ${m.senderName} <${m.senderEmail}>  «${m.subject}»`);
    return;
  }
  if (!target) throw new Error("Не задан ящик руководителя: DATASET_TARGET_EMAIL или --to");
  const env = Env.safeParse(process.env);
  if (!env.success) throw new Error(`Не заданы доступы SMTP: ${env.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  const cfg = env.data;
  const transport = nodemailer.createTransport({
    host: cfg.DATASET_SMTP_HOST,
    port: cfg.DATASET_SMTP_PORT,
    secure: cfg.DATASET_SMTP_PORT === 465,
    auth: { user: cfg.DATASET_SMTP_USER, pass: cfg.DATASET_SMTP_PASS },
  });
  if (process.env.MAIL_DATASET_SENDER?.toLowerCase() !== cfg.DATASET_SMTP_USER.toLowerCase()) {
    console.warn("Внимание: MAIL_DATASET_SENDER не равен DATASET_SMTP_USER. Воркер не примет настоящих отправителей из датасета, и сигналы риска по ролям не сработают.");
  }

  let sent = 0;
  for (const [i, m] of plan.mails.entries()) {
    await transport.sendMail({
      from: cfg.DATASET_SMTP_USER,
      to: target,
      subject: m.subject,
      text: m.body,
      headers: { [DATASET_FROM_HEADER]: `"${m.senderName.replaceAll('"', "")}" <${m.senderEmail}>` },
    });
    sent++;
    console.log(`[${i + 1}/${plan.mails.length}] ${m.externalId} «${m.subject}» отправлено`);
    if (plan.pauseMs > 0 && i < plan.mails.length - 1) await sleep(plan.pauseMs);
  }
  console.log(`Готово: отправлено ${sent}.`);
}

// Запускаем только как скрипт: тест импортирует buildPlan/parseArgs без побочных эффектов.
if (process.argv[1] && /send-dataset-emails\.[cm]?[jt]s$/.test(process.argv[1].replaceAll("\\", "/"))) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
