/**
 * Расписание рутины в человеческом виде ⇄ cron (в базе и планировщике остаётся cron).
 * Чистые функции без зависимостей: можно импортировать и в клиентских компонентах.
 */
export type Schedule =
  | { kind: "interval"; everyMinutes: number }
  /** days: 1 = Пн … 7 = Вс. */
  | { kind: "daily"; days: number[]; time: string };

export const INTERVAL_OPTIONS: { minutes: number; label: string }[] = [
  { minutes: 15, label: "каждые 15 минут" },
  { minutes: 30, label: "каждые 30 минут" },
  { minutes: 60, label: "каждый час" },
  { minutes: 120, label: "каждые 2 часа" },
  { minutes: 240, label: "каждые 4 часа" },
];

export const DAY_LABELS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"] as const;
const WEEKDAYS = [1, 2, 3, 4, 5];
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

const pad = (n: number | string) => String(n).padStart(2, "0");

function parseDays(dow: string): number[] | null {
  if (dow === "*") return ALL_DAYS;
  const out = new Set<number>();
  for (const part of dow.split(",")) {
    const m = /^(\d)(?:-(\d))?$/.exec(part);
    if (!m) return null;
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (from > 7 || to > 7 || from > to) return null;
    for (let d = from; d <= to; d++) out.add(d === 0 ? 7 : d);
  }
  return [...out].sort((a, b) => a - b);
}

/** cron → Schedule; `null`, если выражение сложнее, чем умеет редактор. */
export function parseSchedule(cron: string): Schedule | null {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, mon, dow] = f;
  if (dom !== "*" || mon !== "*") return null;
  if (dow === "*" && hour === "*") {
    const m = /^\*\/(\d+)$/.exec(min);
    return m ? { kind: "interval", everyMinutes: Number(m[1]) } : null;
  }
  if (dow === "*" && min === "0") {
    if (hour === "*") return { kind: "interval", everyMinutes: 60 };
    const h = /^\*\/(\d+)$/.exec(hour);
    if (h) return { kind: "interval", everyMinutes: Number(h[1]) * 60 };
  }
  if (/^\d{1,2}$/.test(min) && /^\d{1,2}$/.test(hour) && Number(min) < 60 && Number(hour) < 24) {
    const days = parseDays(dow);
    if (days && days.length > 0) return { kind: "daily", days, time: `${pad(hour)}:${pad(min)}` };
  }
  return null;
}

/** Schedule → cron. `null`, если расписание некорректно (нет дней, неверное время). */
export function buildCron(s: Schedule): string | null {
  if (s.kind === "interval") {
    const n = s.everyMinutes;
    if (n < 60) return `*/${n} * * * *`;
    if (n === 60) return "0 * * * *";
    return n % 60 === 0 && n < 1440 ? `0 */${n / 60} * * *` : null;
  }
  const m = /^(\d{2}):(\d{2})$/.exec(s.time);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || s.days.length === 0) return null;
  const days = [...new Set(s.days)].sort((a, b) => a - b);
  const dow = days.length === 7 ? "*" : days.join(",");
  return `${Number(m[2])} ${Number(m[1])} * * ${dow}`;
}

export function describeDays(days: number[]): string {
  const key = days.join(",");
  if (key === ALL_DAYS.join(",")) return "каждый день";
  if (key === WEEKDAYS.join(",")) return "по будням";
  if (key === "6,7") return "по выходным";
  if (days.length === 1) return `по ${["понедельникам", "вторникам", "средам", "четвергам", "пятницам", "субботам", "воскресеньям"][days[0] - 1]}`;
  return days.map((d) => DAY_LABELS[d - 1]).join(", ");
}

export function describeSchedule(s: Schedule): string {
  if (s.kind === "daily") return `${describeDays(s.days)} в ${s.time}`;
  if (s.everyMinutes === 60) return "каждый час";
  return s.everyMinutes % 60 === 0 ? `каждые ${s.everyMinutes / 60} ч` : `каждые ${s.everyMinutes} мин`;
}
