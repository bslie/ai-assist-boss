/**
 * Цена часа бота Recall в рублях: берётся с публичной страницы прайса recall.ai, пользователь её не вводит.
 * Час бота = запись встречи + встроенная транскрипция (бот создаётся с recallai_streaming), доллары по курсу ЦБ РФ.
 * Не удалось получить цену или курс — стоимость не выдумываем: учёт пишет 0, а не устаревшее число.
 */
import { z } from "zod";

export const RECALL_PRICING_URL = "https://www.recall.ai/pricing";
export const CBR_DAILY_URL = "https://www.cbr-xml-daily.ru/daily_json.js";
const TTL_MS = 12 * 3_600_000;

export interface RecallPricing {
  /** USD за час записи встречи. */
  botUsdPerHour: number;
  /** USD за час встроенной транскрипции. */
  transcriptUsdPerHour: number;
}

const Usd = z.number().gt(0).lt(20);

/** Цены из текста страницы: «$0.50/hr of recording» и «built-in transcription for $0.15/h». Иная вёрстка — null. */
export function parseRecallPricing(html: string): RecallPricing | null {
  const bot = /\$(\d+(?:\.\d+)?)\s*\/\s*hr\s+of\s+recording/i.exec(html)?.[1];
  const tr = /built-in\s+transcription\s+for\s+\$(\d+(?:\.\d+)?)\s*\/\s*h/i.exec(html)?.[1];
  const parsed = z.object({ botUsdPerHour: Usd, transcriptUsdPerHour: Usd }).safeParse({ botUsdPerHour: Number(bot), transcriptUsdPerHour: Number(tr) });
  return parsed.success ? parsed.data : null;
}

const CbrSchema = z.object({ Valute: z.object({ USD: z.object({ Value: z.number().gt(0), Nominal: z.number().gt(0) }) }) });

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; text(): Promise<string> }>;

let cache: { at: number; rub: number } | null = null;

/** Для тестов. */
export function resetRecallPriceCache(): void {
  cache = null;
}

/**
 * Рублей за час бота; 0 — цену получить не удалось (и кэша нет).
 * Кэш на 12 часов; при сбое сети отдаём прошлое значение, а не обнуляем учёт.
 */
export async function recallHourPriceRub(now: number = Date.now(), fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<number> {
  if (cache && now - cache.at < TTL_MS) return cache.rub;
  try {
    const [page, cbr] = await Promise.all([
      fetchImpl(RECALL_PRICING_URL, { signal: AbortSignal.timeout(10_000) }),
      fetchImpl(CBR_DAILY_URL, { signal: AbortSignal.timeout(10_000) }),
    ]);
    if (!page.ok || !cbr.ok) throw new Error("price source unavailable");
    const pricing = parseRecallPricing(await page.text());
    const usd = CbrSchema.parse(JSON.parse(await cbr.text())).Valute.USD;
    if (!pricing) throw new Error("pricing page layout changed");
    const rub = Math.round((pricing.botUsdPerHour + pricing.transcriptUsdPerHour) * (usd.Value / usd.Nominal) * 100) / 100;
    cache = { at: now, rub };
    return rub;
  } catch {
    return cache?.rub ?? 0;
  }
}
