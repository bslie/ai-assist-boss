import type { ConnectorManifest } from "../types";

/** Отдельный коннектор: у каждого приложения Google свои права доступа, их выдают и отзывают по отдельности. */
export const googleCalendar: ConnectorManifest = {
  id: "BUILTIN_GOOGLE_CALENDAR",
  name: "Google Календарь",
  vendor: "Google",
  category: "Календарь",
  description: "Встречи и свободное время: подтверждение внутренних встреч и подготовка ко встречам.",
  sees: [
    "Ваши встречи на месяц вперёд: время, участники, ссылка на звонок",
    "Следующие встречи серии появляются и в вашем календаре, если вы разрешили их создавать",
    "Защищённые блоки (стратегия, 1:1) и встречи с внешними участниками без вашего подтверждения не двигаются",
    "Доступ можно отозвать здесь или на странице myaccount.google.com/permissions",
  ],
  letter: "К",
  color: "#4285f4",
  status: "ready",
  // Тот же OAuth-клиент Google, что и для Gmail: это настройка администратора, а не пользователя.
  setup: [
    "Откройте console.cloud.google.com и выберите проект, в котором уже настроен вход для Gmail (или создайте новый).",
    "«APIs & Services» → «Library»: включите Google Calendar API.",
    "«Data access»: добавьте право calendar.events.",
    "«OAuth consent screen» → «Test users»: добавьте адреса, чьи календари будете подключать.",
    "Client ID и Client secret те же, что для Gmail: они уже указаны в «Управление» → «Интеграции».",
  ],
  auth: {
    kind: "oauth",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["openid", "email", "https://www.googleapis.com/auth/calendar.events"],
    appKey: "google",
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
    extraParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
  },
  tools: [
    { name: "calendar.read", label: "Смотреть календарь", description: "Свободное время и список встреч.", kind: "read", default: "AUTO" },
    { name: "calendar.create_event", label: "Создавать встречи", description: "Подтверждение и создание внутренних встреч.", kind: "write", default: "APPROVE" },
    {
      name: "calendar.update_event",
      label: "Переносить и отменять встречи",
      description: "Изменение существующих встреч.",
      kind: "write",
      default: "APPROVE",
      max: "APPROVE",
      maxReason: "Перенос чужих встреч и защищённых блоков (стратегия, 1:1) всегда идёт через вас.",
    },
  ],
};
