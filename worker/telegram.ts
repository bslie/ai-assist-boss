/**
 * Тонкий адаптер grammY: Telegram ↔ транспорт-независимая логика из src/core/telegram.
 * Здесь нет бизнес-правил: только маршрутизация апдейтов и отправка.
 */
import { Bot, GrammyError, type Api } from "grammy";
import type { PrismaClient } from "@/generated/prisma/client";
import { handleStart, listRoles } from "@/core/telegram/bindings";
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
  };
}

export function createBot(token: string, db: PrismaClient, state: StateStore): Bot {
  const bot = new Bot(token);
  const messenger = createMessenger(bot.api);
  const deps = { db, messenger, state };
  const html = { parse_mode: "HTML" as const };

  // Работаем только в личных чатах: в группах карточки руководителя показывать нельзя.
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type === "private") await next();
  });

  bot.command("start", async (ctx) => {
    const reply = await handleStart(db, String(ctx.chat.id), ctx.match);
    await ctx.reply(reply.text, html);
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
    const reply = await handleText(deps, String(ctx.chat.id), ctx.message.text);
    await ctx.reply(reply, html);
  });

  bot.catch((err) => console.error("[telegram] ошибка обработчика:", err.error));
  return bot;
}
