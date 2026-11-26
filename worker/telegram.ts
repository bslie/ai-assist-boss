/**
 * Тонкий адаптер grammY: Telegram ↔ транспорт-независимая логика из src/core/telegram.
 * Здесь нет бизнес-правил: только маршрутизация апдейтов и отправка.
 */
import { Bot, GrammyError, type Api } from "grammy";
import type { PrismaClient } from "@/generated/prisma/client";
import { createDraftGenerator } from "@/core/learning/draft";
import type { LlmClient } from "@/core/llm";
import { handleStart, listRoles } from "@/core/telegram/bindings";
import { handleBusinessConnection, handleBusinessMessage } from "@/core/telegram/business";
import { dispatchPendingForEmployee } from "@/core/tasks/dispatch";
import { handleCallback, handleText } from "@/core/telegram/handlers";
import type { Button, Messenger, StateStore } from "@/core/telegram/types";

const keyboard = (buttons?: Button[][]) =>
  buttons ? { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } : undefined;

export function createMessenger(api: Api): Messenger {
  return {
    async send(chatId, text, buttons) {
      const msg = await api.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: keyboard(buttons) });
      return { messageId: String(msg.message_id) };
    },
    async edit(chatId, messageId, text, buttons) {
      try {
        await api.editMessageText(chatId, Number(messageId), text, { parse_mode: "HTML", reply_markup: keyboard(buttons) });
      } catch (e) {
        // Повторное редактирование тем же текстом — не ошибка.
        if (e instanceof GrammyError && /message is not modified/i.test(e.description)) return;
        throw e;
      }
    },
    async sendBusiness(connectionId, chatId, text, replyToMessageId) {
      await api.sendMessage(chatId, text, {
        business_connection_id: connectionId,
        parse_mode: "HTML",
        ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}),
      });
    },
  };
}

/** Без токена воркер работает в «сухом» режиме: сообщения пишутся в лог (удобно для разработки). */
export function createConsoleMessenger(log: (s: string) => void = console.log): Messenger {
  let n = 0;
  return {
    async send(chatId, text) {
      log(`[telegram:dry-run] -> ${chatId}: ${text.replace(/\n/g, " | ").slice(0, 200)}`);
      return { messageId: String(++n) };
    },
    async edit(chatId, messageId, text) {
      log(`[telegram:dry-run] edit ${chatId}/${messageId}: ${text.replace(/\n/g, " | ").slice(0, 200)}`);
    },
    async sendBusiness(connectionId, chatId, text) {
      log(`[telegram:dry-run] business ${connectionId} -> ${chatId}: ${text.replace(/\n/g, " | ").slice(0, 200)}`);
    },
  };
}

export function createBot(token: string, db: PrismaClient, state: StateStore, opts: { learns?: boolean; llm?: LlmClient } = {}): Bot {
  const bot = new Bot(token);
  const messenger = createMessenger(bot.api);
  const deps = { db, messenger, state, learns: opts.learns };
  const html = { parse_mode: "HTML" as const };

  // Telegram Business. Идёт раньше фильтра личных чатов: у business_connection нет chat.
  // В лог: только итог, без текста и идентификаторов.
  bot.on("business_connection", async (ctx) => {
    const c = ctx.businessConnection;
    const r = await handleBusinessConnection(db, {
      connectionId: c.id,
      userId: String(c.user.id),
      userChatId: String(c.user_chat_id),
      canReply: Boolean(c.rights?.can_reply),
      isEnabled: c.is_enabled,
    });
    console.log(`[telegram] business_connection: ${r.status}${r.status === "skipped" ? ` (${r.reason})` : ""}`);
  });
  bot.on("business_message:text", async (ctx) => {
    const m = ctx.businessMessage;
    const connectionId = m.business_connection_id;
    if (!connectionId || !m.from) return;
    const draftLlm = opts.llm;
    const r = await handleBusinessMessage(
      { db, messenger, llm: opts.llm, draft: draftLlm ? createDraftGenerator(db, draftLlm) : undefined },
      { connectionId, chatId: String(m.chat.id), messageId: String(m.message_id), fromUserId: String(m.from.id), fromIsBot: m.from.is_bot, text: m.text },
    );
    console.log(`[telegram] business_message: ${r.status}${r.status === "skipped" ? ` (${r.reason})` : ""}`);
  });

  // Работаем только в личных чатах: в группах карточки руководителя показывать нельзя.
  // В лог идёт только тип апдейта и чата, без текста и идентификаторов.
  bot.use(async (ctx, next) => {
    const kind = Object.keys(ctx.update).find((k) => k !== "update_id");
    const chatType = ctx.chat?.type;
    console.log(`[telegram] апдейт ${kind}, чат ${chatType ?? "—"}${chatType === "private" ? "" : " (пропущен)"}`);
    if (chatType === "private") await next();
  });

  bot.command("start", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const reply = await handleStart(db, chatId, ctx.match);
    await ctx.reply(reply.text, html);
    // Сотрудник только что подключился: отправляем поручения, которые ждали (через Policy Gate).
    const bindings = await db.telegramBinding.findMany({ where: { chatId, role: "EMPLOYEE", isActive: true } });
    for (const b of bindings) {
      if (b.employeeId) await dispatchPendingForEmployee({ db, messenger }, b.leaderId, b.employeeId);
    }
  });

  bot.command("role", async (ctx) => {
    const reply = await listRoles(db, String(ctx.chat.id));
    await ctx.reply(reply.text, { ...html, reply_markup: keyboard(reply.buttons) });
  });

  bot.on("callback_query:data", async (ctx) => {
    const message = ctx.callbackQuery.message;
    if (!message) return ctx.answerCallbackQuery();
    const text = await handleCallback(deps, {
      chatId: String(message.chat.id),
      messageId: String(message.message_id),
      data: ctx.callbackQuery.data,
    });
    await ctx.answerCallbackQuery({ text: text.slice(0, 200) });
  });

  bot.on("message:text", async (ctx) => {
    const replyTo = ctx.message.reply_to_message?.message_id;
    const reply = await handleText(deps, String(ctx.chat.id), ctx.message.text, {
      replyToMessageId: replyTo === undefined ? undefined : String(replyTo),
    });
    await ctx.reply(reply, html);
  });

  bot.catch((err) => console.error("[telegram] ошибка обработчика:", err.error));
  return bot;
}
