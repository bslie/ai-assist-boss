/**
 * Чат с помощником (SPEC 6: /api/chat). Понимает три вещи: «что на сегодня», правила словами
 * («вендоров в архив», «пиши короче») и «ответь <кому>, что …» по ожидающей карточке.
 * Внешних эффектов у чата нет: ответ на письмо возвращается как ПРЕДЛОЖЕНИЕ с кнопкой, которая
 * идёт обычным путём решения карточки; правила проходят те же проверки, что и страница «Как я работаю».
 */
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { buildDecisionCards, getToday, plural } from "./dashboard";
import { CATEGORY_HELP, EMAIL_ACTIONS, EMAIL_CATEGORIES } from "./email-triage/classify";
import { publishEvent } from "./events";
import { ensureSignature } from "./learning/draft";
import { isSafeRule } from "./learning/extract";
import type { LlmClient } from "./llm";
import { createRule } from "./rules";

export const ChatInputSchema = z.object({ text: z.string().trim().min(1).max(1000) });

export interface ChatAction {
  label: string;
  /** Тело POST /api/decisions/[id]/resolve. */
  resolve: { decisionId: string; body: { action: "EDITED_APPROVED"; editedText: string } };
}
export interface ChatReply {
  text: string;
  /** Подготовленный текст письма: показывается отдельной цитатой. */
  draft?: string;
  actions?: ChatAction[];
}

const IntentSchema = z.object({
  intent: z.enum(["RULE", "STYLE", "REPLY", "UNKNOWN"]),
  /** RULE: что делать с письмами категории. */
  rule: z
    .object({
      name: z.string().min(1).max(120),
      category: z.enum(EMAIL_CATEGORIES),
      action: z.enum(EMAIL_ACTIONS),
    })
    .nullable(),
  /** STYLE: правило о манере письма одним предложением. */
  style: z.string().max(240).nullable(),
  /** REPLY: кому (имя или фамилия как сказал руководитель) и что ответить по смыслу. */
  reply: z.object({ to: z.string().min(1), gist: z.string().min(1).max(500) }).nullable(),
});

const SYSTEM = [
  "Ты разбираешь короткую реплику руководителя к ИИ-помощнику. Верни одно намерение.",
  "RULE: руководитель объясняет, как поступать с входящими письмами определённого вида («вендоров в архив», «отчёты в сводку»).",
  "Заполни rule: category и action (ASK_LEADER — спросить меня, DIGEST — в сводку, DELEGATE — передать, IGNORE — в архив, AUTO — решить самой).",
  "Категории: " + EMAIL_CATEGORIES.map((c) => `${c} (${CATEGORY_HELP[c]})`).join("; ") + ".",
  "STYLE: правило о манере письма и ответов («пиши короче», «обращайся на вы»). Заполни style: одно предложение в повелительном наклонении.",
  "REPLY: «ответь <кому>, что …». Заполни reply: to — как назван адресат, gist — что нужно ответить, своими словами, без выдумывания деталей.",
  "UNKNOWN: всё остальное, в том числе вопросы и болтовня. Лишние поля ставь в null.",
].join(" ");

const STATUS_RE = /^\s*(что\s+(у\s+нас\s+)?на\s+сегодня|план\s+(на\s+)?(день|сегодня)|что\s+нового|что\s+горит)\W*$/i;

export const HELP_TEXT =
  "Я умею три вещи: рассказать план дня («Что на сегодня?»), запомнить правило («Запомни: рассылки вендоров в архив», «Пиши короче») " +
  "и подготовить ответ на письмо («Ответь Павловой, что в четверг»). Решения по карточкам принимаете вы.";

const norm = (s: string) => s.toLowerCase().replaceAll("ё", "е");
/** Ищем по основе слова: «Павловой» ↔ «Павлова». */
const stem = (w: string) => norm(w).slice(0, Math.max(3, norm(w).length - 2));

export async function handleChat(db: PrismaClient, llm: LlmClient, leaderId: string, text: string): Promise<ChatReply> {
  if (STATUS_RE.test(text)) return { text: await statusText(db, leaderId) };

  const parsed = await llm.generateStructured({
    leaderId,
    pipeline: "CHAT",
    schema: IntentSchema,
    system: SYSTEM,
    prompt: text,
    cacheKey: `chat\u0000${norm(text)}`,
    temperature: 0,
  });

  if (parsed.intent === "RULE" && parsed.rule) return addRule(db, leaderId, text, parsed.rule);
  if (parsed.intent === "STYLE" && parsed.style) return addStyle(db, leaderId, parsed.style);
  if (parsed.intent === "REPLY" && parsed.reply) return proposeReply(db, llm, leaderId, parsed.reply);
  return { text: HELP_TEXT };
}

async function statusText(db: PrismaClient, leaderId: string): Promise<string> {
  const t = await getToday(db, leaderId);
  const n = t.decisions.length;
  const lines = [
    n > 0 ? `Без вас не решить: ${n} ${plural(n, "вопрос", "вопроса", "вопросов")}, они выше в карточках.` : "Решений, которые ждут вас, нет.",
  ];
  const meetings = t.day.filter((d) => d.time !== "срок прошёл");
  if (meetings.length) {
    lines.push(`Сегодня ${meetings.length} ${plural(meetings.length, "встреча", "встречи", "встреч")}:`);
    lines.push(...meetings.slice(0, 4).map((m) => `• ${m.time} ${m.title}`));
    if (meetings.length > 4) lines.push(`…и ещё ${meetings.length - 4}`);
  }
  const overdue = t.day.length - meetings.length;
  if (overdue) lines.push(`Просрочено задач: ${overdue}.`);
  if (t.priorities.length) lines.push("Главное:", ...t.priorities.map((p) => `• ${p}`));
  return lines.join("\n");
}

async function addRule(db: PrismaClient, leaderId: string, original: string, rule: NonNullable<z.infer<typeof IntentSchema>["rule"]>): Promise<ChatReply> {
  const res = await createRule(db, leaderId, {
    name: rule.name,
    description: original.slice(0, 500),
    category: rule.category,
    action: rule.action,
  });
  if (!res.ok) return { text: `Не могу так сделать. ${res.message}` };
  await publishEvent(leaderId, { type: "metrics.updated", data: {} });
  return { text: `Запомнила: «${rule.name}». Правило видно на странице «Как я работаю», там его можно изменить или убрать.` };
}

async function addStyle(db: PrismaClient, leaderId: string, style: string): Promise<ChatReply> {
  if (!isSafeRule(style)) return { text: "Такое правило я не запомню: оно снимает подтверждения или меняет мою подпись. Это решаете не вы и не я, а защита системы." };
  const dup = await db.memory.findFirst({ where: { leaderId, ruleText: style, isActive: true } });
  if (!dup) await db.memory.create({ data: { leaderId, sourceType: "EXPLICIT", ruleText: style, scope: "GLOBAL", isActive: true } });
  await publishEvent(leaderId, { type: "metrics.updated", data: {} });
  return { text: dup ? `Это правило у меня уже есть: «${style}».` : `Запомнила: «${style}». Буду учитывать в новых черновиках.` };
}

const DraftSchema = z.object({ text: z.string().min(1).max(2000) });

async function proposeReply(db: PrismaClient, llm: LlmClient, leaderId: string, reply: { to: string; gist: string }): Promise<ChatReply> {
  const pending = await db.decision.findMany({ where: { leaderId, status: "PENDING" }, orderBy: { createdAt: "asc" } });
  const cards = await buildDecisionCards(db, leaderId, pending);
  const keys = reply.to.split(/\s+/).map(stem);
  const hits = cards.filter((c) => {
    const from = norm(c.from);
    return keys.some((k) => from.includes(k));
  });
  if (hits.length === 0) return { text: `Не нашла среди ожидающих карточек письма от «${reply.to}». Возможно, оно уже решено.` };
  if (hits.length > 1) return { text: `Ожидающих писем от «${reply.to}» несколько: ${hits.map((h) => `«${h.title}»`).join(", ")}. Уточните, по какому отвечать.` };

  const card = hits[0];
  const leader = await db.leader.findFirstOrThrow({ where: { id: leaderId }, select: { name: true } });
  const out = await llm.generateStructured({
    leaderId,
    pipeline: "CHAT",
    schema: DraftSchema,
    system: [
      `Ты ИИ-помощник руководителя ${leader.name}. Напиши короткий ответ на письмо по указанию руководителя.`,
      "Опирайся только на указание и письмо; не придумывай даты, суммы и обещания, которых руководитель не называл. Коротко, по-русски.",
    ].join(" "),
    prompt: `Письмо от ${card.from}: ${card.title}\nСуть: ${card.summary}\n\nУказание руководителя: ${reply.gist}`,
    cacheKey: `reply\u0000${card.id}\u0000${norm(reply.gist)}`,
    temperature: 0.2,
  });
  const body = ensureSignature(out.text, leader.name);
  return {
    text: `Подготовила ответ на письмо «${card.title}»${card.from ? ` от ${card.from}` : ""}. Проверьте и отправьте:`,
    draft: body,
    actions: [{ label: "Отправить этот ответ", resolve: { decisionId: card.id, body: { action: "EDITED_APPROVED", editedText: body } } }],
  };
}
