import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DATASET_DIR } from "./index";

export const MEETING_CATEGORIES = ["OPERATIONAL", "MONEY", "CLIENT", "PARTNER", "MANAGEMENT", "ONE_ON_ONE"] as const;
export type MeetingCategory = (typeof MEETING_CATEGORIES)[number];

const CATEGORY_MAP: Record<string, MeetingCategory> = {
  операционная: "OPERATIONAL",
  деньги: "MONEY",
  клиент: "CLIENT",
  партнёр: "PARTNER",
  руководство: "MANAGEMENT",
  один_на_один: "ONE_ON_ONE",
};

const EventSchema = z.object({
  uid: z.string().min(1),
  summary: z.string().min(1),
  start: z.date(),
  end: z.date(),
  category: z.enum(MEETING_CATEGORIES),
  attendees: z.array(z.string()),
});
export type CalendarEvent = z.infer<typeof EventSchema>;

/** `20261207T100000` (без зоны) → московское время, как и письма датасета. */
function parseIcsDate(v: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(v.trim());
  if (!m) throw new Error(`Bad ICS date: ${v}`);
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+03:00`);
}

/** Минимальный парсер VEVENT (без RRULE): достаточно для календаря датасета. */
export function parseIcs(text: string): CalendarEvent[] {
  const lines = text.replace(/\r\n[ \t]/g, "").split(/\r?\n/); // unfolding
  const events: CalendarEvent[] = [];
  let cur: Record<string, string> & { attendees?: string } | null = null;
  const attendees: string[] = [];
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      cur = {};
      attendees.length = 0;
      continue;
    }
    if (line === "END:VEVENT" && cur) {
      const category = CATEGORY_MAP[cur.CATEGORIES ?? ""];
      if (!category) throw new Error(`Unknown calendar category: ${cur.CATEGORIES}`);
      events.push(
        EventSchema.parse({
          uid: cur.UID,
          summary: cur.SUMMARY,
          start: parseIcsDate(cur.DTSTART),
          end: parseIcsDate(cur.DTEND),
          category,
          attendees: [...attendees],
        }),
      );
      cur = null;
      continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const name = line.slice(0, idx).split(";")[0];
    const value = line.slice(idx + 1);
    if (name === "ATTENDEE") attendees.push(value.replace(/^mailto:/, ""));
    else cur[name] = value;
  }
  return events;
}

export function loadCalendar(dir = DATASET_DIR): CalendarEvent[] {
  return parseIcs(readFileSync(path.join(dir, "calendar.ics"), "utf8"));
}
