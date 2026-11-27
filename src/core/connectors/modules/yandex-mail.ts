import type { ConnectorManifest } from "../types";

export const yandexMail: ConnectorManifest = {
  id: "BUILTIN_IMAP",
  name: "Почта по IMAP",
  vendor: "Яндекс, Mail.ru и другие",
  category: "Почта",
  description: "Любой почтовый ящик с IMAP и SMTP: входящие, ответы, архив.",
  sees: ["Входящие письма в выбранной папке", "Ответы уходят через ваш SMTP-сервер"],
  letter: "Я",
  color: "#f0524b",
  status: "ready",
  auth: {
    kind: "credentials",
    fields: [
      { key: "email", label: "Адрес ящика", secret: false, placeholder: "name@company.ru" },
      { key: "password", label: "Пароль приложения", secret: true, help: "Не основной пароль: создайте отдельный пароль приложения в настройках почты." },
      { key: "imapHost", label: "IMAP-сервер", secret: false, initial: "imap.yandex.ru" },
      { key: "smtpHost", label: "SMTP-сервер", secret: false, initial: "smtp.yandex.ru" },
    ],
  },
  tools: [
    { name: "mail.read", label: "Читать входящие", description: "Разбирать письма и готовить карточки.", kind: "read", default: "AUTO" },
    { name: "mail.archive", label: "Отправлять рассылки в архив", description: "Перемещение писем в архив.", kind: "write", default: "APPROVE" },
    { name: "mail.mark_read", label: "Помечать обработанные письма прочитанными", description: "Письма, которые вы разобрали в помощнике или которые я обработала сама, становятся прочитанными в ящике. Служебные и проигнорированные остаются непрочитанными, чтобы вы заглянули в них сами.", kind: "write", default: "AUTO" },
    { name: "mail.send_reply", label: "Отправлять ответы", description: "Ответ от вашего имени с подписью помощника.", kind: "write", default: "APPROVE" },
  ],
};
