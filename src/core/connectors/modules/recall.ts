import type { ConnectorManifest } from "../types";

export const recall: ConnectorManifest = {
  id: "BUILTIN_RECALL",
  name: "Запись встреч (Recall.ai)",
  vendor: "Recall.ai",
  category: "Встречи",
  description: "Бот заходит на созвон, записывает и присылает расшифровку для протокола.",
  sees: ["Расшифровка встреч, на которые вы отправили бота", "Участники встречи"],
  letter: "R",
  color: "#8b5cf6",
  status: "ready",
  auth: {
    kind: "credentials",
    fields: [
      { key: "apiKey", label: "API-ключ", secret: true, help: "Ключ из личного кабинета Recall.ai." },
      { key: "region", label: "Регион", secret: false, initial: "eu-central-1" },
    ],
  },
  tools: [
    { name: "meeting.get_transcript", label: "Получать расшифровку", description: "Текст встречи после её окончания.", kind: "read", default: "AUTO" },
    {
      name: "meeting.join_bot",
      label: "Отправлять бота на встречу",
      description: "Бот представляется как «ИИ-помощник» и виден всем участникам.",
      kind: "write",
      default: "APPROVE",
      max: "APPROVE",
      maxReason: "Запись разговоров всегда с вашего ведома.",
    },
  ],
};
