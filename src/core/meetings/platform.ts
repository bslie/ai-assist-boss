/**
 * Платформа видеовстречи по ссылке. Recall.ai заводит бота на Zoom, Google Meet, Microsoft Teams, Webex и GoTo;
 * Телемост и Dion Recall не поддерживает — для них бот не запускается, остаётся ручной транскрипт (SPEC 4.5.3).
 * Только разбор строки: сети и БД здесь нет.
 */
import { z } from "zod";

export type MeetingPlatform = "ZOOM" | "GOOGLE_MEET" | "TEAMS" | "WEBEX" | "GOTO" | "TELEMOST" | "DION" | "UNKNOWN";

interface PlatformDef {
  platform: Exclude<MeetingPlatform, "UNKNOWN">;
  label: string;
  hosts: RegExp;
  botSupported: boolean;
}

const PLATFORMS: PlatformDef[] = [
  { platform: "ZOOM", label: "Zoom", hosts: /(^|\.)zoom\.(us|com)$/, botSupported: true },
  { platform: "GOOGLE_MEET", label: "Google Meet", hosts: /^meet\.google\.com$/, botSupported: true },
  { platform: "TEAMS", label: "Microsoft Teams", hosts: /^(teams\.microsoft\.com|teams\.live\.com)$/, botSupported: true },
  { platform: "WEBEX", label: "Webex", hosts: /(^|\.)webex\.com$/, botSupported: true },
  { platform: "GOTO", label: "GoTo Meeting", hosts: /(^|\.)(gotomeeting|goto)\.com$/, botSupported: true },
  { platform: "TELEMOST", label: "Яндекс Телемост", hosts: /^telemost\.yandex\.(ru|com)$/, botSupported: false },
  { platform: "DION", label: "Dion", hosts: /(^|\.)dion\.vc$/, botSupported: false },
];

export interface PlatformInfo {
  platform: MeetingPlatform;
  label: string;
  /** Может ли Recall заходить на такую встречу. UNKNOWN → false (fail closed). */
  botSupported: boolean;
}

/** Ссылка на встречу: только https, без логина в адресе. */
export const MeetingUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .url()
  .refine((s) => {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password;
  }, "Нужна ссылка https без логина и пароля");

export function detectPlatform(url: string): PlatformInfo {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { platform: "UNKNOWN", label: "Неизвестная платформа", botSupported: false };
  }
  const def = PLATFORMS.find((p) => p.hosts.test(host));
  return def ? { platform: def.platform, label: def.label, botSupported: def.botSupported } : { platform: "UNKNOWN", label: "Неизвестная платформа", botSupported: false };
}

/** Первая ссылка на известную платформу из свободного текста (описание события, письмо). */
export function extractMeetingUrl(text: string): string | null {
  for (const m of text.matchAll(/https:\/\/[^\s<>"')\]]+/g)) {
    const candidate = m[0].replace(/[.,;:!?]+$/, "");
    if (MeetingUrlSchema.safeParse(candidate).success && detectPlatform(candidate).platform !== "UNKNOWN") return candidate;
  }
  return null;
}
