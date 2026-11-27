/**
 * Что подключено у руководителя (SPEC 1.1, п. 3 и 6): минимум для старта — почта и календарь,
 * для встреч — Recall. Нужно «Разговору» (полоса «Подключите…») и чату («что подключить?»).
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { listCatalog, type CatalogItem } from "./service";
import type { Category } from "./types";

export interface Readiness {
  mail: boolean;
  calendar: boolean;
  meetings: boolean;
  telegram: boolean;
  /** Модули почты и календаря, которые можно подключить, если ни одного такого ещё нет. */
  missing: { name: string; letter: string; color: string }[];
  /** Одной строкой для контекста чата. */
  summary: string;
}

const connectedIn = (items: CatalogItem[], c: Category) => items.some((i) => i.category === c && i.state === "connected");

export async function getReadiness(db: PrismaClient, leaderId: string): Promise<Readiness> {
  const items = await listCatalog(db, leaderId);
  const mail = connectedIn(items, "Почта");
  const calendar = connectedIn(items, "Календарь");
  const meetings = connectedIn(items, "Встречи");
  const telegram = connectedIn(items, "Мессенджеры");

  const offer = (c: Category) =>
    items.filter((i) => i.category === c && !i.connectorId && i.state !== "soon").map((i) => ({ name: i.name, letter: i.letter, color: i.color }));
  const missing = [...(mail ? [] : offer("Почта")), ...(calendar ? [] : offer("Календарь"))];

  const state = (ok: boolean) => (ok ? "подключено" : "не подключено");
  const connected = items.filter((i) => i.state === "connected").map((i) => i.name);
  const summary = [
    `Почта: ${state(mail)}. Календарь: ${state(calendar)}. Встречи (Recall, бот-аватар в Zoom/Meet/Teams): ${state(meetings)}. Telegram: ${state(telegram)}.`,
    `Подключено сейчас: ${connected.join(", ") || "ничего"}. Подключить можно: ${items.filter((i) => !i.connectorId && i.state !== "soon").map((i) => `${i.name} (${i.category})`).join(", ") || "—"}.`,
  ].join(" ");

  return { mail, calendar, meetings, telegram, missing, summary };
}
