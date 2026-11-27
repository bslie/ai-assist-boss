import type { ConnectorManifest } from "../types";

export const recall: ConnectorManifest = {
  id: "BUILTIN_RECALL",
  name: "Запись встреч (Recall.ai)",
  vendor: "Recall.ai",
  category: "Встречи",
  description: "Бот заходит на созвон Zoom, Google Meet, Teams или Webex, записывает и присылает расшифровку для протокола.",
  sees: ["Расшифровка встреч, на которые вы отправили бота", "Участники встречи"],
  letter: "R",
  color: "#8b5cf6",
  status: "ready",
  setup: [
    "Зарегистрируйтесь на recall.ai и откройте личный кабинет.",
    "В разделе API Keys создайте ключ и вставьте его ниже.",
    "Регион — часть адреса кабинета (например, eu-central-1 для eu-central-1.recall.ai). Ключ работает только в своём регионе.",
    "Адрес приложения уже подставлен: по нему бот открывает страницу аватара, он должен быть доступен из интернета.",
    "После подключения откройте встречу в «Вашем дне» и нажмите «Отправить помощника». Протокол соберётся сам после встречи.",
  ],
  auth: {
    kind: "credentials",
    fields: [
      { key: "apiKey", label: "API-ключ", secret: true, help: "Ключ из личного кабинета Recall.ai." },
      { key: "region", label: "Регион", secret: false, initial: "eu-central-1", help: "us-east-1, us-west-2, eu-central-1 или ap-northeast-1." },
      {
        key: "appUrl",
        label: "Адрес приложения",
        secret: false,
        initial: "{origin}",
        help: "Публичный адрес, по которому Recall откроет страницу аватара. Для проверки на своём компьютере нужен туннель (ngrok и т. п.).",
      },
      {
        key: "pricePerHourRub",
        label: "Цена часа работы бота, ₽",
        secret: false,
        optional: true,
        placeholder: "Например, 35",
        help: "Нужна только для «Метрик»: считаю, во сколько обходится помощник. Можно оставить пустым.",
      },
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
