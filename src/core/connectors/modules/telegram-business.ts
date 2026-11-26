import type { ConnectorManifest } from "../types";

/**
 * Telegram Business: бот подключается к личному аккаунту руководителя (нужен Telegram Premium) и видит
 * личные чаты, которые руководитель сам открыл боту. Логика: src/core/telegram/business.ts.
 */
export const telegramBusiness: ConnectorManifest = {
  id: "BUILTIN_TELEGRAM_BUSINESS",
  name: "Telegram Business",
  vendor: "Telegram",
  category: "Мессенджеры",
  description: "Помощник отвечает в ваших личных чатах Telegram. Сообщения приходят в диалог от вашего аккаунта, с подписью помощника.",
  sees: [
    "После подключения здесь: в Telegram откройте Настройки → Telegram Business → Чат-боты и выберите нашего бота. Нужен Telegram Premium, и вы уже должны были запустить бота командой /start",
    "По умолчанию читаем только сообщения сотрудников, которых вы привязали к боту. Чтобы читать всех, включите это в настройках ниже. Группы и каналы не читаются никогда",
    "Ответ уходит в чат от вашего аккаунта только после вашего «Утвердить» и начинается со слов «Это ИИ-помощник …»",
    "Доступ можно отозвать в настройках Telegram в любой момент",
  ],
  letter: "T",
  color: "#2a8fd1",
  status: "ready",
  auth: { kind: "none", envRequired: ["TELEGRAM_BOT_TOKEN"] },
  tools: [
    {
      name: "telegram_business.read_messages",
      label: "Читать сообщения в открытых вами чатах",
      description: "Входящие от сотрудников и других людей: разбирать и готовить карточки решений.",
      kind: "read",
      default: "AUTO",
    },
    {
      name: "telegram_business.read_all",
      label: "Читать сообщения всех, не только сотрудников",
      description: "Выключено: разбираются только привязанные сотрудники. Включите, и помощник будет читать любого, кто пишет вам в открытых боту чатах.",
      kind: "read",
      default: "DENY",
    },
    {
      name: "telegram_business.send_reply",
      label: "Отвечать от вашего аккаунта",
      description: "Ответ в личном чате с подписью помощника. Вопросы про людей, руководство и обязательства перед клиентами всегда идут через вас.",
      kind: "write",
      default: "APPROVE",
      max: "APPROVE",
      maxReason: "Сообщения от вашего имени всегда уходят только после вашего подтверждения.",
    },
  ],
};
