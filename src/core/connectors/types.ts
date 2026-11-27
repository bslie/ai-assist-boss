/**
 * Каталог подключений: каждый модуль описывается манифестом. Чтобы добавить новый сервис,
 * достаточно положить файл в `modules/` и вписать его в `modules/index.ts`: каталог, форма
 * авторизации и права инструментов рисуются из манифеста, правок в интерфейсе не нужно.
 */
import { z } from "zod";

export const PermSchema = z.enum(["AUTO", "APPROVE", "DENY"]);
export type Perm = z.infer<typeof PermSchema>;

export interface ConnectorTool {
  /** Имя в Policy Gate и в Connector.toolPermissions. */
  name: string;
  label: string;
  description: string;
  kind: "read" | "write";
  default: Perm;
  /** Выше этого права инструмент поднять нельзя (например, APPROVE: всегда через руководителя). */
  max?: Perm;
  /** Почему потолок: показывается рядом с замком. */
  maxReason?: string;
}

export interface CredentialField {
  key: string;
  label: string;
  /** Секретные поля шифруются и никогда не возвращаются в интерфейс. */
  secret: boolean;
  placeholder?: string;
  help?: string;
  /** Значение по умолчанию (например, imap.yandex.ru). */
  initial?: string;
  /** Необязательное поле: можно оставить пустым. */
  optional?: boolean;
  /** Выпадающий список вместо ручного ввода. */
  options?: { value: string; label: string }[];
}

export type AuthSpec =
  | { kind: "none"; /** Что должно быть настроено на сервере, чтобы модуль работал. */ envRequired?: string[] }
  | { kind: "credentials"; fields: CredentialField[] }
  | {
      kind: "oauth";
      authorizeUrl: string;
      tokenUrl: string;
      scopes: string[];
      clientIdEnv: string;
      clientSecretEnv: string;
      /** Дополнительные параметры страницы входа (у Google нужен access_type=offline, иначе не будет refresh-токена). */
      extraParams?: Record<string, string>;
      /** Откуда взять адрес аккаунта после входа: ответ вида { email } или { mail } с токеном доступа. */
      userinfoUrl?: string;
    }
  | { kind: "mcp" };

export const CATEGORIES = ["Почта", "Календарь", "Мессенджеры", "Встречи", "Свои серверы"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface ConnectorManifest {
  /** Значение Connector.type. Не меняется: на него ссылаются права и журнал. */
  id: string;
  name: string;
  vendor: string;
  category: Category;
  description: string;
  /** Что помощник сможет видеть и делать: строки для окна подключения. */
  sees: string[];
  /** Буква и цвет значка, пока нет логотипа. */
  letter: string;
  color: string;
  auth: AuthSpec;
  /** Пошаговая инструкция «как подключить»: показывается над полями доступа. */
  setup?: string[];
  /** Под этим ключом в доступы кладётся адрес, по которому открыто приложение (берётся из запроса, пользователь его не вводит). */
  originKey?: string;
  tools: ConnectorTool[];
  /** soon — виден в каталоге, подключить нельзя. */
  status: "ready" | "soon";
  /** Можно ли подключить несколько (свой MCP). */
  multiple?: boolean;
}
