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
  originKey: "appUrl",
  setup: [
    "Зарегистрируйтесь на recall.ai и откройте личный кабинет.",
    "В разделе API Keys создайте ключ и вставьте его ниже.",
    "Выберите регион, в котором создан ключ (он указан в адресе кабинета, например eu-central-1.recall.ai).",
    "Бот открывает страницу аватара по адресу, где запущен помощник, поэтому приложение должно быть доступно из интернета (при проверке на своём компьютере нужен туннель).",
    "После подключения откройте встречу в «Вашем дне» и нажмите «Отправить помощника». Протокол соберётся сам после встречи.",
  ],
  auth: {
    kind: "credentials",
    fields: [
      { key: "apiKey", label: "API-ключ", secret: true, help: "Ключ из личного кабинета Recall.ai." },
      {
        key: "region",
        label: "Регион",
        secret: false,
        initial: "eu-central-1",
        help: "Тот, в котором вы создали ключ: он работает только в своём регионе.",
        options: [
          { value: "eu-central-1", label: "Европа, Франкфурт (eu-central-1)" },
          { value: "us-east-1", label: "США, Вирджиния (us-east-1)" },
          { value: "us-west-2", label: "США, Орегон (us-west-2)" },
          { value: "ap-northeast-1", label: "Азия, Токио (ap-northeast-1)" },
        ],
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
