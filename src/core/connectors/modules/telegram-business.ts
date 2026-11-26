import type { ConnectorManifest } from "../types";

/**
 * Telegram Business: бот подключается к личному аккаунту руководителя (нужен Telegram Premium) и видит
 * личные чаты, которые руководитель сам открыл боту. Пока витрина: приём и отправка через
 * business_connection_id ещё не реализованы, поэтому подключить нельзя.
 */
export const telegramBusiness: ConnectorManifest = {
  id: "BUILTIN_TELEGRAM_BUSINESS",
  name: "Telegram Business",
  vendor: "Telegram",
  category: "Мессенджеры",
  description: "Помощник отвечает в ваших личных чатах Telegram. Сообщения приходят в диалог от вашего аккаунта, с подписью помощника.",
  sees: [
    "Личные чаты, которые вы сами открыли боту в Telegram: Настройки → Telegram Business → Чат-боты",
    "Группы, каналы и секретные чаты недоступны",
    "Ответы идут в диалог от вашего аккаунта и подписаны «ИИ-помощник»",
    "Нужен Telegram Premium. Доступ можно отозвать в настройках Telegram в любой момент",
  ],
  letter: "T",
  color: "#2a8fd1",
  status: "soon",
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
