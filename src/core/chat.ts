/**
 * Чат с помощником (SPEC 6: /api/chat). Понимает три вещи: «что на сегодня», правила словами
 * («вендоров в архив», «пиши короче») и «ответь <кому>, что …» по ожидающей карточке.
 * Внешних эффектов у чата нет: ответ на письмо возвращается как ПРЕДЛОЖЕНИЕ с кнопкой, которая
 * идёт обычным путём решения карточки; правила проходят те же проверки, что и страница «Как я работаю».
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { buildDecisionCards, getToday, plural } from "./dashboard";
import { CATEGORY_HELP, EMAIL_ACTIONS, EMAIL_CATEGORIES } from "./email-triage/classify";
import { publishEvent } from "./events";
import { ensureSignature } from "./learning/draft";
import { isSafeRule } from "./learning/extract";
import type { LlmClient } from "./llm";
import { createRule } from "./rules";
import { createTask } from "./tasks/registry";

export const ChatInputSchema = z.object({
  text: z.string().trim().min(1).max(1000),
  /** Последние реплики: помощник помнит, о чём шла речь. */
  history: z
    .array(z.object({ from: z.enum(["me", "bot"]), text: z.string().max(2000) }))
    .max(12)
    .optional(),
});

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

const ActionSchema = z.object({
  kind: z.enum(["RULE", "STYLE", "REPLY", "TASK"]),
  /** RULE: что делать с письмами категории. */
  rule: z.object({ name: z.string().min(1).max(120), category: z.enum(EMAIL_CATEGORIES), action: z.enum(EMAIL_ACTIONS) }).nullable(),
  /** STYLE: правило о манере письма одним предложением. */
  style: z.string().max(240).nullable(),
  /** REPLY: кому (как назвал руководитель) и что ответить по смыслу. */
  reply: z.object({ to: z.string().min(1), gist: z.string().min(1).max(500) }).nullable(),
  /** TASK: кому (как назвал руководитель), что сделать и срок (ISO 8601 +03:00, null — срок не назван). */
  task: z.object({ assignee: z.string().min(1), title: z.string().min(3).max(200), dueAt: z.string().nullable() }).nullable(),
});

const AgentSchema = z.object({
  /** Свободный ответ по делу. Пустой, если сделано действие: его итог сообщит система. */
  answer: z.string().max(1500),
  actions: z.array(ActionSchema).max(2),
});

const SYSTEM = [
  "Ты ИИ-помощник руководителя и разговариваешь с ним как толковый ассистент: свободно, по-человечески, коротко, по-русски, на «вы».",
  "Отвечай на любые вопросы о его дне, встречах, задачах, письмах и правилах, опираясь ТОЛЬКО на контекст ниже.",
  "Если в контексте нет данных для ответа, скажи об этом прямо, ничего не выдумывай. Если вопрос про выбор (что пропустить, что перенести), дай конкретную рекомендацию и коротко объясни почему, учитывая профиль и защищённые блоки.",
  "Ты пока не можешь сама переносить встречи, писать в календарь или отправлять письма: говори «предлагаю», а не «сделала». Неясный вопрос уточни одним встречным вопросом.",
  "Действия (actions) добавляй только когда руководитель явно просит: RULE — как поступать с письмами вида («вендоров в архив»), STYLE — манера письма («пиши короче»), REPLY — «ответь <кому>, что …».",
  "Для RULE: category из списка и action (ASK_LEADER — спросить меня, DIGEST — в сводку, DELEGATE — передать, IGNORE — в архив, AUTO — решить самой). Категории: " +
    EMAIL_CATEGORIES.map((c) => `${c} (${CATEGORY_HELP[c]})`).join("; ") + ".",
  "TASK — «поставь <кому> задачу <что> до <когда>»: assignee как назвал руководитель, title коротко, dueAt в ISO 8601 с +03:00 или null, если срок не назван (не выдумывай срок).",
  "STYLE — одно предложение в повелительном наклонении. REPLY.gist — суть ответа без выдуманных деталей.",
  "Если есть действие, answer оставь пустой строкой: результат действия сообщит система. Не утверждай, что что-то запомнила или отправила.",
].join(" ");

const STATUS_RE = /^\s*(что\s+(у\s+нас\s+)?на\s+сегодня|план\s+(на\s+)?(день|сегодня)|что\s+нового|что\s+горит)\W*$/i;

export const HELP_TEXT = "Не уверена, что поняла. Спросите про день, встречи или задачи, попросите запомнить правило или подготовить ответ на письмо.";

/** Снимок данных руководителя для модели: только его, только нужное для разговора. */
export async function buildChatContext(db: PrismaClient, leaderId: string): Promise<string> {
  const [t, leader, rules, memories] = await Promise.all([
    getToday(db, leaderId),
    db.leader.findFirstOrThrow({ where: { id: leaderId }, select: { name: true, role: true, protectedBlocks: true, profileMarkdown: true, budgetAutoLimit: true } }),
    db.rule.findMany({ where: { leaderId }, select: { name: true, action: true }, take: 30 }),
    db.memory.findMany({ where: { leaderId, isActive: true }, select: { ruleText: true }, take: 20 }),
  ]);
  const lines = [
    `Сейчас: ${t.now} (Москва). Руководитель: ${leader.name}, ${leader.role}.`,
    `Защищённые блоки календаря: ${leader.protectedBlocks.join(", ") || "нет"}. Порог автосогласования денег: ${leader.budgetAutoLimit} ₽.`,
    "",
    "День (встречи и просроченные задачи):",
    ...t.day.map((d) => `- ${d.time} ${d.title}${d.note ? ` [${d.note}]` : ""}${d.details.length ? ` (${d.details.join("; ")})` : ""}`),
    "",
    `Ждут решения руководителя: ${t.decisions.length}.`,
    ...t.decisions.map((c) => `- ${c.tag}: «${c.title}» от ${c.from || "—"}: ${c.summary}`),
    "",
    `Главное на сегодня: ${t.priorities.join("; ") || "—"}.`,
    `Правила обработки писем: ${rules.map((r) => `${r.name} → ${r.action}`).join("; ") || "нет"}.`,
    `Выученные правила стиля: ${memories.map((m) => m.ruleText).join("; ") || "нет"}.`,
    "",
    "Профиль руководителя (выдержка):",
    leader.profileMarkdown.slice(0, 5000),
  ];
  return lines.join("\n");
}

const norm = (s: string) => s.toLowerCase().replaceAll("ё", "е");
/** Ищем по основе слова: «Павловой» ↔ «Павлова». */
const stem = (w: string) => norm(w).slice(0, Math.max(3, norm(w).length - 2));

export async function handleChat(
  db: PrismaClient,
  llm: LlmClient,
  leaderId: string,
  text: string,
  history: { from: "me" | "bot"; text: string }[] = [],
): Promise<ChatReply> {
  if (STATUS_RE.test(text)) return { text: await statusText(db, leaderId) };

  const context = await buildChatContext(db, leaderId);
  const dialog = history.slice(-8).map((m) => `${m.from === "me" ? "Руководитель" : "Помощник"}: ${m.text}`).join("\n");
  const res = await llm.generateStructured({
    leaderId,
    pipeline: "CHAT",
    schema: AgentSchema,
    system: `${SYSTEM}\n\nКОНТЕКСТ\n${context}`,
    prompt: `${dialog ? `Предыдущий разговор:\n${dialog}\n\n` : ""}Руководитель: ${text}`,
    cacheKey: `chat\u0000${createHash("sha256").update(`${context}\u0000${dialog}\u0000${text}`).digest("hex")}`,
    temperature: 0.2,
  });

  // Действия исполняет код, и его слово о результате — последнее: модель не вправе сказать «запомнила» за него.
  const replies: ChatReply[] = [];
  for (const a of res.actions) {
    if (a.kind === "RULE" && a.rule) replies.push(await addRule(db, leaderId, text, a.rule));
    else if (a.kind === "STYLE" && a.style) replies.push(await addStyle(db, leaderId, a.style));
    else if (a.kind === "REPLY" && a.reply) replies.push(await proposeReply(db, llm, leaderId, a.reply));
    else if (a.kind === "TASK" && a.task) replies.push(await addTask(db, llm, leaderId, a.task));
  }
  if (replies.length === 0) return { text: res.answer.trim() || HELP_TEXT };
  const lead = replies.length > 1 || !res.answer.trim() ? [] : [res.answer.trim()];
  return {
    text: [...lead, ...replies.map((r) => r.text)].join("\n\n"),
    draft: replies.find((r) => r.draft)?.draft,
    actions: replies.flatMap((r) => r.actions ?? []),
  };
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

async function addRule(db: PrismaClient, leaderId: string, original: string, rule: NonNullable<z.infer<typeof ActionSchema>["rule"]>): Promise<ChatReply> {
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

/** Поручение из чата: сам чат ничего не отправляет, исполнителю оно уйдёт через Policy Gate. */
async function addTask(db: PrismaClient, llm: LlmClient, leaderId: string, task: { assignee: string; title: string; dueAt: string | null }): Promise<ChatReply> {
  const keys = task.assignee.split(/s+/).map(stem);
  const people = await db.employee.findMany({ where: { leaderId, relationType: "SUBORDINATE" }, select: { id: true, name: true } });
  const hits = people.filter((p) => keys.some((k) => norm(p.name).includes(k)));
  if (hits.length === 0) return { text: `Не нашла среди ваших сотрудников «${task.assignee}». Назовите, кому поставить задачу.` };
  if (hits.length > 1) return { text: `Под «${task.assignee}» подходят несколько человек: ${hits.map((h) => h.name).join(", ")}. Уточните, кому.` };
  if (!task.dueAt) return { text: `Какой срок поставить ${hits[0].name} по задаче «${task.title}»? Без срока я задачу не ставлю.` };
  const due = new Date(task.dueAt);
  if (Number.isNaN(due.getTime())) return { text: "Не поняла срок. Скажите, например: «до пятницы 18:00»." };

  const res = await createTask(db, llm, leaderId, { title: task.title, description: "", assigneeId: hits[0].id, dueAt: due, isClientCommitment: false, isTypical: false });
  if (!res.ok) return { text: `Не поставила задачу: ${res.message}.` };
  return { text: `Поставила задачу «${task.title}» для ${hits[0].name}. Критерий готовности сформулировала, исполнитель получит её в Telegram.` };
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
