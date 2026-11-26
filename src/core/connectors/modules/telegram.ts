import type { ConnectorManifest } from "../types";

export const telegram: ConnectorManifest = {
  id: "BUILTIN_TELEGRAM",
  name: "Telegram",
  vendor: "Telegram",
  category: "Мессенджеры",
  description: "Утренний план, карточки решений и поручения сотрудникам в вашем Telegram.",
  sees: ["Сообщения в чатах, которые вы сами привязали к боту", "Ответы сотрудников на поручения"],
  letter: "T",
  color: "#4fa8e0",
  status: "ready",
  auth: { kind: "none", envRequired: ["TELEGRAM_BOT_TOKEN"] },
  tools: [
    {
      name: "telegram.send_digest",
      label: "Присылать вам утренний план и карточки",
      description: "Сообщения только вам, в привязанный чат.",
      kind: "write",
      default: "AUTO",
    },
    {
      name: "telegram.assign_task",
      label: "Отправлять поручения сотрудникам",
      description: "Сообщение сотруднику с задачей, сроком и критерием приёмки.",
      kind: "write",
      default: "APPROVE",
    },
  ],
};
