import type { ConnectorManifest } from "../types";

/** Отдельный коннектор: у каждого приложения Google свои права доступа, их выдают и отзывают по отдельности. */
export const googleCalendar: ConnectorManifest = {
  id: "BUILTIN_GOOGLE_CALENDAR",
  name: "Google Календарь",
  vendor: "Google",
  category: "Календарь",
  description: "Встречи и свободное время: подтверждение внутренних встреч и подготовка ко встречам. Пока витрина: чтение календаря ещё не подключено.",
  sees: ["Встречи и свободное время", "Защищённые блоки (стратегия, 1:1) без вашего подтверждения не двигаются"],
  letter: "К",
  color: "#4285f4",
  status: "soon",
  auth: {
    kind: "oauth",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["openid", "email", "https://www.googleapis.com/auth/calendar.events"],
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
