import type { ConnectorManifest } from "../types";
import { customMcp } from "./custom-mcp";
import { gmail } from "./gmail";
import { googleCalendar } from "./google-calendar";
import { microsoft365 } from "./microsoft365";
import { recall } from "./recall";
import { telegram } from "./telegram";
import { telegramBusiness } from "./telegram-business";
import { yandexMail } from "./yandex-mail";

/** Новый модуль = новый файл рядом + строка здесь. */
export const MODULES: readonly ConnectorManifest[] = [telegram, telegramBusiness, gmail, googleCalendar, microsoft365, yandexMail, recall, customMcp];

export const getModule = (id: string) => MODULES.find((m) => m.id === id);
