/**
 * Чат с помощником (SPEC 1.1, 6: /api/chat) — основной инструмент. Понимает: «что на сегодня», правила словами
 * («вендоров в архив», «пиши короче»), «ответь <кому>, что …», поручения, режим обучения, рутины и вопросы о приложении.
 * Внешних эффектов у чата нет: ответ на письмо возвращается как ПРЕДЛОЖЕНИЕ с кнопкой, которая
 * идёт обычным путём решения карточки; правила проходят те же проверки, что и страница «Как я работаю».
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { clock } from "./clock";
import { buildDecisionCards, getToday, plural } from "./dashboard";
import { detectPlatform, extractMeetingUrl } from "./meetings/platform";
import { CATEGORY_HELP, EMAIL_ACTIONS, EMAIL_CATEGORIES } from "./email-triage/classify";
import { publishEvent } from "./events";
import { ensureSignature } from "./learning/draft";
import { isSafeRule } from "./learning/extract";
import type { LlmClient } from "./llm";
import { getReadiness } from "./connectors/readiness";
import { SCOPE_LABEL, TRUST_SCOPES, canTrust, getLearningStatus, type LearningPatch } from "./learning/mode";
import { describeCron, validCron } from "./routines";
import { proposeProfileEdit } from "./profile/edit";
import type { ProfilePatch } from "./profile/patch";
import { createRule } from "./rules";
import { TASK_ASSIGN_SCOPE } from "./tasks/dispatch";
import { createTask } from "./tasks/registry";

export const ChatInputSchema = z.object({
  text: z.string().trim().min(1).max(1000),
  /** Последние реплики: помощник помнит, о чём шла речь. */
  history: z
    .array(z.object({ from: z.enum(["me", "bot"]), text: z.string().max(2000) }))
    .max(12)
    .optional(),
});

/**
 * Кнопка подтверждения под ответом. Чат сам ничего не меняет: изменение применяется только по нажатию,
 * тем же API, что и страницы (SPEC 1.1, «Управление через чат»).
 */
export type ChatAction =
  | {
      label: string;
      /** Тело POST /api/decisions/[id]/resolve. */
      resolve: { decisionId: string; body: { action: "EDITED_APPROVED"; editedText: string } };
    }
  | {
      label: string;
      /** PATCH на API настроек: режим обучения или рутина. */
      patch: { path: "/api/learning" | "/api/routines" | "/api/profile"; body: LearningPatch | ProfilePatch | { id: string; isActive?: boolean; cronExpression?: string } };
      /** Что показать после успешного применения. */
      done: string;
    }
  | {
      label: string;
      /** POST на API встреч: ИИ-помощник заходит по ссылке. */
      post: { path: "/api/meetings/join"; body: { url: string; meetingId?: string } };
      done: string;
    };
export interface ChatReply {
  text: string;
  /** Подготовленный текст письма: показывается отдельной цитатой. */
  draft?: string;
  actions?: ChatAction[];
}

const ActionSchema = z.object({
  kind: z.enum(["RULE", "STYLE", "REPLY", "TASK", "LEARNING", "ROUTINE", "PROFILE"]),
  /** RULE: что делать с письмами категории. */
  rule: z.object({ name: z.string().min(1).max(120), category: z.enum(EMAIL_CATEGORIES), action: z.enum(EMAIL_ACTIONS) }).nullable(),
  /** STYLE: правило о манере письма одним предложением. */
  style: z.string().max(240).nullable(),
  /** REPLY: кому (как назвал руководитель) и что ответить по смыслу. */
  reply: z.object({ to: z.string().min(1), gist: z.string().min(1).max(500) }).nullable(),
  /** TASK: кому (как назвал руководитель), что сделать и срок (ISO 8601 +03:00, null — срок не назван). */
  task: z.object({ assignee: z.string().min(1), title: z.string().min(3).max(200), dueAt: z.string().nullable() }).nullable(),
  /** LEARNING: включить/выключить режим обучения (mode) или отпустить/вернуть область (scope + trusted). */
  learning: z.object({ mode: z.enum(["ON", "OFF"]).nullable(), scope: z.enum(TRUST_SCOPES).nullable(), trusted: z.boolean().nullable() }).nullable(),
  /** ROUTINE: код рутины из контекста, новое время «ЧЧ:ММ» и/или включить-выключить. */
  routine: z.object({ code: z.string().min(1).max(40), time: z.string().nullable(), active: z.boolean().nullable() }).nullable(),
  /** PROFILE: правка профиля словами: цели квартала, порог по деньгам, манера писем, каналы. */
  profile: z.object({ instruction: z.string().min(3).max(500) }).nullish(),
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
  "LEARNING — «выключи режим обучения» (mode OFF), «снова учись» (mode ON), «приглашения решай сама» / «поручения отправляй без меня» (scope + trusted true), «верни отчёты мне» (scope + trusted false). Поручения сотрудникам — scope TASK_ASSIGN.",
  "ROUTINE — «утренний план присылай в 9:00», «выключи итог недели»: code из списка рутин в контексте, time «ЧЧ:ММ» или null, active true/false или null.",
  "PROFILE — «добавь цель квартала …», «убери вторую цель», «порог по деньгам 50 тысяч», «пиши мне проще»: что изменить в профиле — в instruction, одной понятной просьбой, как сказал руководитель, с числами из его слов. Правила писем — это RULE, время рутин — ROUTINE.",
  "Если есть действие, answer оставь пустой строкой: результат действия сообщит система. Не утверждай, что что-то запомнила или отправила.",
  "На вопросы о самом приложении («что ты умеешь», «где настроить», «что подключить, чтобы ты была на встречах», «почему ты спрашиваешь») отвечай по разделу «О ПРИЛОЖЕНИИ» и по состоянию подключений в контексте, называя раздел, куда идти.",
].join(" ");

/** Справка о продукте для ответов «что ты умеешь» и «где это настроить» (SPEC 1.1). */
export const APP_GUIDE = [
  "О ПРИЛОЖЕНИИ.",
  "Разделы: «Разговор» — главная: сводка дня, карточки решений, этот чат и статус режима обучения. «Поручения» — задачи сотрудникам, сроки, приёмка результата.",
  "«Как я работаю» — правила разбора писем (защищённые правила ослабить нельзя). «Рутины» — утренний план, итог недели, контроль сроков: время и включение.",
  "«Метрики» — сэкономленные часы, доля писем без руководителя, стоимость. «Профиль» — цели, стиль, порог бюджета: страница только для чтения, профиль меняется здесь, в чате («добавь цель…», «порог по деньгам 50 тысяч»).",
  "«Подключения» — почта (Gmail, Яндекс, Microsoft 365), Google Календарь, Telegram (карточки руководителю и поручения сотрудникам), Recall (встречи), свои MCP-серверы; у каждого инструмента права: сама / с подтверждением / запрещено.",
  "Минимум для старта — почта и календарь. Без них я работаю на демо-данных.",
  "Чтобы я была на встречах: в «Подключения» подключить Recall и календарь со ссылками Zoom/Meet/Teams. Тогда во встрече можно выбрать участие аватаром: бот заходит, задаёт вопросы по прошлому протоколу, а протокол приходит вам на утверждение. Без Recall протокол можно сделать из транскрипта.",
  "Режим обучения: пока он включён, ответы, поручения и действия в почте и календаре идут только после «да» руководителя. После серии решений без правок я предлагаю отпустить область. Кадры, руководство, обещания клиентам и деньги выше порога — всегда с руководителем.",
  "В чате я умею: рассказать о дне и встречах, посоветовать, что пропустить, запомнить правило или стиль, подготовить ответ на письмо, поставить поручение сотруднику, менять режим обучения, рутины и профиль, зайти на встречу по ссылке Zoom/Meet/Teams/Webex («зайди на встречу <ссылка>», каждое изменение — после кнопки подтверждения). В Телемост и Dion бот не заходит: там протокол делается из транскрипта, который вставляют у встречи в «Вашем дне».",
  "Пока не умею: сама переносить встречи в календаре, голосовой ввод.",
].join(" ");

const STATUS_RE = /^\s*(что\s+(у\s+нас\s+)?на\s+сегодня|план\s+(на\s+)?(день|сегодня)|что\s+нового|что\s+горит)\W*$/i;

export const HELP_TEXT = "Не уверена, что поняла. Спросите про день, встречи или задачи, попросите запомнить правило или подготовить ответ на письмо.";

/** Снимок данных руководителя для модели: только его, только нужное для разговора. */
export async function buildChatContext(db: PrismaClient, leaderId: string): Promise<string> {
  const [t, leader, rules, memories, learning, readiness, routines] = await Promise.all([
    getToday(db, leaderId),
    db.leader.findFirstOrThrow({ where: { id: leaderId }, select: { name: true, role: true, protectedBlocks: true, profileMarkdown: true, budgetAutoLimit: true } }),
    db.rule.findMany({ where: { leaderId }, select: { name: true, action: true }, take: 30 }),
    db.memory.findMany({ where: { leaderId, isActive: true }, select: { ruleText: true }, take: 20 }),
    getLearningStatus(db, leaderId),
    getReadiness(db, leaderId),
    db.routine.findMany({ where: { leaderId }, orderBy: { code: "asc" }, select: { code: true, title: true, cronExpression: true, isActive: true } }),
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
    `Подключения: ${readiness.summary}`,
    `Режим обучения: ${learning.learningMode ? "включён" : "выключен"}. Решений без правок: ${learning.clean} из ${learning.resolved}. Решаю сама: ${learning.trusted.map((x) => x.label).join(", ") || "ничего"}.` +
      (learning.suggestions.length ? ` Можно предложить отпустить: ${learning.suggestions.map((s) => `${s.label} (${s.streak} подряд без правок)`).join(", ")}.` : ""),
    `Рутины: ${routines.map((r) => `${r.code} «${r.title}» ${describeCron(r.cronExpression)}${r.isActive ? "" : " (выключена)"}`).join("; ") || "нет"}.`,
    "",
    APP_GUIDE,
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
  const join = await proposeJoin(db, leaderId, text);
  if (join) return join;

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
    else if (a.kind === "LEARNING" && a.learning) replies.push(await proposeLearning(db, leaderId, a.learning));
    else if (a.kind === "ROUTINE" && a.routine) replies.push(await proposeRoutine(db, leaderId, a.routine));
    else if (a.kind === "PROFILE" && a.profile) replies.push(await proposeProfile(db, llm, leaderId, a.profile.instruction));
  }
  if (replies.length === 0) return { text: res.answer.trim() || HELP_TEXT };
  const lead = replies.length > 1 || !res.answer.trim() ? [] : [res.answer.trim()];
  const actions = replies.flatMap((r) => r.actions ?? []);
  return {
    text: [...lead, ...replies.map((r) => r.text)].join("\n\n"),
    draft: replies.find((r) => r.draft)?.draft,
    actions: actions.length ? actions : undefined,
  };
}

const JOIN_RE = /(зайд|подключ|присоедин|подойд|будь\s+на|иди\s+на|приди)/i;
const JOIN_WINDOW_MS = 3 * 3_600_000;

/**
 * «Зайди на встречу <ссылка>»: разбор без LLM, ссылка не уходит в модель. Бот не запускается сам:
 * чат только предлагает кнопку (SPEC 1.1). К какой встрече относится ссылка — решает ближайшая; неясно — спрашиваем.
 */
async function proposeJoin(db: PrismaClient, leaderId: string, text: string): Promise<ChatReply | null> {
  if (!JOIN_RE.test(text)) return null;
  const url = extractMeetingUrl(text);
  if (!url) return null;
  const platform = detectPlatform(url);
  if (!platform.botSupported) {
    return {
      text: `${platform.label}: бот Recall туда не заходит, поэтому присоединиться я не смогу. После встречи пришлите транскрипт или запись текстом: в «Вашем дне» у встречи есть поле «Транскрипт», и я соберу протокол.`,
    };
  }
  const now = clock.now();
  const near = await db.meeting.findMany({
    where: { leaderId, recallBotId: null, endAt: { gt: now }, startAt: { lte: new Date(now.getTime() + JOIN_WINDOW_MS) } },
    orderBy: { startAt: "asc" },
    select: { id: true, title: true },
  });
  if (near.length > 1) {
    return { text: `Сейчас подходят несколько встреч: ${near.map((m) => `«${m.title}»`).join(", ")}. Скажите, на какую зайти, или откройте нужную в «Вашем дне» и вставьте ссылку там.` };
  }
  const target = near[0];
  return {
    text: target
      ? `Предлагаю отправить ИИ-помощника на «${target.title}» (${platform.label}). Он назовётся ИИ-помощником, зададит вопросы по прошлому протоколу и запишет ход встречи; протокол придёт вам на утверждение.`
      : `Ближайших встреч в календаре нет. Предлагаю зайти по ссылке (${platform.label}) на разовую встречу: ИИ-помощник назовётся, запишет ход встречи, протокол придёт вам на утверждение.`,
    actions: [
      {
        label: "Отправить помощника",
        post: { path: "/api/meetings/join", body: { url, ...(target ? { meetingId: target.id } : {}) } },
        done: "Помощник отправлен на встречу",
      },
    ],
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
  const keys = task.assignee.split(/\s+/).filter(Boolean).map(stem);
  const people = await db.employee.findMany({ where: { leaderId, relationType: "SUBORDINATE" }, select: { id: true, name: true } });
  const hits = people.filter((p) => keys.some((k) => norm(p.name).includes(k)));
  if (hits.length === 0) return { text: `Не нашла среди ваших сотрудников «${task.assignee}». Назовите, кому поставить задачу.` };
  if (hits.length > 1) return { text: `Под «${task.assignee}» подходят несколько человек: ${hits.map((h) => h.name).join(", ")}. Уточните, кому.` };
  if (!task.dueAt) return { text: `Какой срок поставить ${hits[0].name} по задаче «${task.title}»? Без срока я задачу не ставлю.` };
  const due = new Date(task.dueAt);
  if (Number.isNaN(due.getTime())) return { text: "Не поняла срок. Скажите, например: «до пятницы 18:00»." };

  const res = await createTask(db, llm, leaderId, { title: task.title, description: "", assigneeId: hits[0].id, dueAt: due, isClientCommitment: false, isTypical: false });
  if (!res.ok) return { text: `Не поставила задачу: ${res.message}.` };
  const gate = await db.leader.findFirstOrThrow({ where: { id: leaderId }, select: { learningMode: true, trustedScopes: true } });
  const delivery =
    gate.learningMode && !gate.trustedScopes.includes(TASK_ASSIGN_SCOPE)
      ? "Пока я учусь, сама его не отправляю: поручение придёт вам карточкой «Отправить поручение»."
      : "Исполнитель получит его в Telegram, а если бот не подключён — письмом со ссылкой для ответа.";
  return { text: `Поставила задачу «${task.title}» для ${hits[0].name}. Критерий готовности сформулировала. ${delivery}` };
}

/** Режим обучения из чата: только предложение с кнопкой; защищённое не отпускается (SPEC 1.1). */
async function proposeLearning(
  db: PrismaClient,
  leaderId: string,
  l: NonNullable<z.infer<typeof ActionSchema>["learning"]>,
): Promise<ChatReply> {
  const status = await getLearningStatus(db, leaderId);
  if (l.mode) {
    const enabled = l.mode === "ON";
    if (status.learningMode === enabled) return { text: enabled ? "Режим обучения уже включён: без вашего «да» я ничего не отправляю." : "Режим обучения уже выключен." };
    return {
      text: enabled
        ? "Предлагаю снова включить режим обучения.\nБыло: действую по правилам и правам подключений.\nСтанет: любое внешнее действие — только после вашего «да»."
        : `Предлагаю выключить режим обучения (без правок вы приняли ${status.clean} из ${status.resolved}).\nБыло: всё внешнее — только после вашего «да».\nСтанет: действую по правилам и правам подключений. Кадры, руководство, обещания клиентам и деньги выше порога по-прежнему только с вами.`,
      actions: [{ label: enabled ? "Включить режим обучения" : "Выключить режим обучения", patch: { path: "/api/learning", body: { kind: "mode", enabled } }, done: enabled ? "Режим обучения включён" : "Режим обучения выключен" }],
    };
  }
  if (!l.scope) return { text: "Какую область отпустить: например, приглашения, отчёты или поручения сотрудникам?" };
  const trusted = l.trusted ?? true;
  const label = SCOPE_LABEL[l.scope];
  if (trusted && !canTrust(l.scope)) return { text: `${label} я всегда согласую с вами: эту защиту не снимают ни правилом, ни словами.` };
  const has = status.trusted.some((x) => x.scope === l.scope);
  if (has === trusted) return { text: trusted ? `${label} я уже решаю сама.` : `${label} и так идут через вас.` };
  return {
    text: trusted
      ? `Предлагаю отпустить: ${label}.\nБыло: каждое такое действие — после вашего «да».\nСтанет: решаю сама по вашим правилам; сомнительные случаи и защищённые категории всё равно принесу вам.`
      : `Предлагаю вернуть вам: ${label}.\nБыло: решаю сама.\nСтанет: каждое такое действие — после вашего «да».`,
    actions: [{ label: trusted ? "Отпустить" : "Вернуть мне", patch: { path: "/api/learning", body: { kind: "trust", scope: l.scope, trusted } }, done: trusted ? `${label}: решаю сама` : `${label}: снова через вас` }],
  };
}

/** Время или включение рутины из чата: diff и кнопка, применяет тот же PATCH /api/routines. */
async function proposeRoutine(
  db: PrismaClient,
  leaderId: string,
  r: NonNullable<z.infer<typeof ActionSchema>["routine"]>,
): Promise<ChatReply> {
  const routine = await db.routine.findFirst({ where: { leaderId, code: r.code } });
  if (!routine) return { text: `Не нашла такую рутину. Есть: ${(await db.routine.findMany({ where: { leaderId }, select: { title: true } })).map((x) => `«${x.title}»`).join(", ") || "никаких"}.` };

  let cron = routine.cronExpression;
  if (r.time) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(r.time.trim());
    const parts = cron.split(" ");
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || !/^\d+$/.test(parts[0] ?? "") || !/^\d+$/.test(parts[1] ?? "")) {
      return { text: `Не смогла поменять время у «${routine.title}» словами. Это можно сделать на странице «Рутины».` };
    }
    cron = [String(Number(m[2])), String(Number(m[1])), ...parts.slice(2)].join(" ");
    if (!validCron(cron)) return { text: "Не получилось разобрать новое время." };
  }
  const active = r.active ?? routine.isActive;
  if (cron === routine.cronExpression && active === routine.isActive) return { text: `«${routine.title}» уже ${active ? describeCron(cron) : "выключена"}.` };

  const show = (c: string, on: boolean) => (on ? describeCron(c) : "выключена");
  return {
    text: `Предлагаю изменить рутину «${routine.title}».\nБыло: ${show(routine.cronExpression, routine.isActive)}.\nСтанет: ${show(cron, active)}.`,
    actions: [
      {
        label: "Применить",
        patch: {
          path: "/api/routines",
          body: { id: routine.id, ...(active !== routine.isActive ? { isActive: active } : {}), ...(cron !== routine.cronExpression ? { cronExpression: cron } : {}) },
        },
        done: `«${routine.title}»: ${show(cron, active)}`,
      },
    ],
  };
}

const money = (n: number) => `${n.toLocaleString("ru-RU")} ₽`;

/** Правка профиля из чата: «было → станет» и кнопка; запись идёт PATCH /api/profile. */
async function proposeProfile(db: PrismaClient, llm: LlmClient, leaderId: string, instruction: string): Promise<ChatReply> {
  const res = await proposeProfileEdit(db, llm, leaderId, instruction);
  if (!res.ok) return { text: res.message };
  const lines = ["Предлагаю изменить профиль."];
  for (const g of res.goals?.removed ?? []) lines.push(`Уберу цель: ${g}`);
  for (const g of res.goals?.added ?? []) lines.push(`Добавлю цель: ${g}`);
  if (res.goals && !res.goals.added.length && !res.goals.removed.length) lines.push("Поменяю порядок целей.");
  if (res.budget) lines.push(`Порог по деньгам: ${money(res.budget.from)} → ${money(res.budget.to)}`);
  if (res.style) lines.push(`Манера писем: ${res.style}`);
  return {
    text: lines.join("\n"),
    actions: [{ label: "Применить", patch: { path: "/api/profile", body: res.patch }, done: "Профиль обновлён" }],
  };
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
