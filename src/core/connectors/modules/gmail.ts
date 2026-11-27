import type { ConnectorManifest } from "../types";

export const gmail: ConnectorManifest = {
  id: "BUILTIN_GMAIL",
  name: "Gmail",
  vendor: "Google",
  category: "Почта",
  description: "Почта Google: входящие письма, ответы и архив.",
  sees: ["Входящие письма и ветки переписки", "Письма уходят только от вашего имени, в ту же ветку и с подписью помощника", "Доступ можно отозвать здесь или на странице myaccount.google.com/permissions"],
  letter: "G",
  color: "#ea4335",
  status: "ready",
  // Один OAuth-клиент Google на всё приложение: те же ключи подходят для Календаря. Это настройка администратора, а не пользователя.
  setup: [
    "Откройте console.cloud.google.com и создайте проект (или выберите существующий).",
    "«APIs & Services» → «Library»: включите Gmail API (для Календаря — ещё Google Calendar API).",
    "«OAuth consent screen» (Google Auth Platform): тип External, режим Testing. В «Test users» добавьте адреса, чьи ящики будете подключать.",
    "«Data access»: добавьте права gmail.modify и gmail.send (для Календаря — calendar.events).",
    "«Clients» → «Create client» → Web application. В «Authorized redirect URIs» вставьте адрес, показанный ниже.",
    "Скопируйте Client ID и Client secret в GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET на сервере и перезапустите приложение.",
  ],
  auth: {
    kind: "oauth",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.send"],
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
    // Без offline и consent Google не выдаст refresh-токен, и через час доступ пропадёт.
    extraParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
  },
  tools: [
    { name: "mail.read", label: "Читать входящие", description: "Разбирать письма и готовить карточки.", kind: "read", default: "AUTO" },
    { name: "mail.archive", label: "Отправлять рассылки в архив", description: "Убрать письмо из входящих (оно останется в «Вся почта»).", kind: "write", default: "APPROVE" },
    { name: "mail.send_reply", label: "Отправлять ответы", description: "Ответ на письмо от вашего имени с подписью помощника.", kind: "write", default: "APPROVE" },
  ],
};
