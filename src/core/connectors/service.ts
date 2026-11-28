/**
 * Каталог подключений руководителя: манифесты модулей + его записи Connector.
 * Секреты шифруются и наружу не отдаются; права инструментов лежат в Connector.toolPermissions,
 * откуда их читает Policy Gate. Все запросы ограничены leaderId.
 */
import { z } from "zod";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { decryptJson, encryptJson, SecretsNotConfigured, secretsConfigured } from "./crypto";
import { isCalendarType } from "../calendar/factory";
import { isMailType, verifyMailCredentials } from "../mail/factory";
import { probeMcp, type McpTool } from "./mcp";
import { configuredOAuthApps } from "./oauth-app";
import { verifyConnectorCredentials } from "./verify";
import { leaderBindSecret } from "../telegram/bindings";
import { getModule, MODULES } from "./modules";
import { PermSchema, type ConnectorManifest, type ConnectorTool, type Perm } from "./types";

export type ConnectorState = "available" | "connected" | "paused" | "needs_auth" | "needs_setup" | "soon";

export interface CatalogTool {
  name: string;
  label: string;
  description: string;
  kind: "read" | "write";
  permission: Perm;
  /** Потолок прав и его причина (замок в интерфейсе). */
  max: Perm | null;
  maxReason: string | null;
}

export interface CatalogItem {
  /** Уникален в каталоге: id записи или id модуля, если записи ещё нет. */
  key: string;
  moduleId: string;
  connectorId: string | null;
  name: string;
  vendor: string;
  category: string;
  description: string;
  sees: string[];
  letter: string;
  color: string;
  state: ConnectorState;
  /** Что именно нужно сделать, если подключить пока нельзя. */
  hint: string | null;
  /** Ссылка-действие для панели подключения (например, привязка Telegram). */
  link: { label: string; url: string } | null;
  auth: { kind: "none" | "credentials" | "oauth" | "mcp"; fields: { key: string; label: string; secret: boolean; placeholder?: string; help?: string; initial?: string; optional?: boolean; options?: { value: string; label: string }[] }[] };
  /** Инструкция «как подключить» (из манифеста). */
  setup: string[];
  /** Несекретные значения полей (адрес ящика, сервер): для редактирования. */
  values: Record<string, string>;
  /** Какие секретные поля уже заполнены (сами значения не отдаём). */
  filledSecrets: string[];
  mcpUrl: string | null;
  account: string | null;
  /** Последний опрос почты (только для почтовых модулей). */
  lastSync: LastSync | null;
  /** Подключение читает почту: в панели есть «Проверить сейчас». */
  pollable: boolean;
  tools: CatalogTool[];
  multiple: boolean;
}

export interface LastSync {
  at: string;
  /** Сколько писем взяла в этот раз. */
  fetched: number;
  error?: string;
}

export interface Stored {
  values?: Record<string, string>;
  tokens?: { access_token?: string; refresh_token?: string; expires_at?: number };
  account?: string;
  mcpTools?: McpTool[];
  /** Курсор опроса почты: непрозрачная строка реализации. */
  cursor?: string;
  lastSync?: LastSync;
}

const PermsRecord = z.record(z.string(), PermSchema);
const RANK: Record<Perm, number> = { DENY: 0, APPROVE: 1, AUTO: 2 };
const clamp = (p: Perm, max: Perm | undefined): Perm => (max && RANK[p] > RANK[max] ? max : p);

type Row = Awaited<ReturnType<PrismaClient["connector"]["findMany"]>>[number];

function toolsFor(m: ConnectorManifest, row: Row | null, stored: Stored | null): CatalogTool[] {
  const perms = PermsRecord.safeParse(row?.toolPermissions ?? {}).data ?? {};
  const list: ConnectorTool[] =
    m.auth.kind === "mcp"
      ? (stored?.mcpTools ?? []).map((t) => ({
          name: t.name,
          label: t.name,
          description: t.description,
          kind: t.readOnly ? "read" : "write",
          default: "APPROVE",
        }))
      : m.tools;
  return list.map((t) => ({
    name: t.name,
    label: t.label,
    description: t.description,
    kind: t.kind,
    permission: clamp(perms[t.name] ?? t.default, t.max),
    max: t.max ?? null,
    maxReason: t.maxReason ?? null,
  }));
}

const envReady = (names: string[] = []) => names.every((n) => Boolean(process.env[n]));

/** `ready` — ключи OAuth-приложений, уже заданные администратором (см. oauth-app.ts). */
function itemFor(m: ConnectorManifest, row: Row | null, ready: Set<string>): CatalogItem {
  const stored = row ? decryptJson<Stored>(row.encryptedConfig) : null;
  const fields = m.auth.kind === "credentials" ? m.auth.fields : [];
  const values: Record<string, string> = {};
  const filled: string[] = [];
  for (const f of fields) {
    const v = stored?.values?.[f.key];
    if (f.secret) {
      if (v) filled.push(f.key);
    } else values[f.key] = v ?? f.initial ?? "";
  }

  let state: ConnectorState;
  let hint: string | null = null;
  if (m.status === "soon") state = "soon";
  else if (!row) {
    state = "available";
    if (m.auth.kind === "oauth" && !ready.has(m.auth.appKey)) {
      state = "needs_setup";
      hint = "Администратору нужно один раз указать ключи приложения (Client ID и Client secret) в «Управление» → «Интеграции».";
    } else if (m.auth.kind === "none" && !envReady(m.auth.envRequired)) {
      state = "needs_setup";
      hint = `На сервере не задано: ${(m.auth.envRequired ?? []).join(", ")}.`;
    } else if (m.auth.kind !== "none" && !secretsConfigured()) {
      state = "needs_setup";
      hint = "На сервере не задан CONNECTOR_SECRET: без него доступы нельзя хранить безопасно.";
    }
  } else {
    const hasAccess =
      m.auth.kind === "none" ||
      m.auth.kind === "mcp" ||
      (m.auth.kind === "oauth" && Boolean(stored?.tokens?.access_token || stored?.tokens?.refresh_token)) ||
      (m.auth.kind === "credentials" && fields.filter((f) => f.secret).every((f) => Boolean(stored?.values?.[f.key])));
    state = !hasAccess ? "needs_auth" : row.isActive ? "connected" : "paused";
    if (!hasAccess) hint = "Доступ нужно выдать заново: прежний не подошёл или был сброшен.";
  }

  return {
    key: row?.id ?? m.id,
    moduleId: m.id,
    connectorId: row?.id ?? null,
    name: row && m.multiple ? row.name : m.name,
    vendor: m.vendor,
    category: m.category,
    description: m.description,
    sees: m.sees,
    letter: m.letter,
    color: m.color,
    state,
    hint,
    link: null,
    auth: {
      kind: m.auth.kind,
      fields: fields.map((f) => ({ key: f.key, label: f.label, secret: f.secret, placeholder: f.placeholder, help: f.help, initial: f.initial, optional: f.optional, options: f.options })),
    },
    setup: m.setup ?? [],
    values,
    filledSecrets: filled,
    mcpUrl: row?.mcpUrl ?? null,
    account: stored?.account ?? values.email ?? null,
    lastSync: stored?.lastSync ?? null,
    pollable: isMailType(m.id) || isCalendarType(m.id),
    tools: toolsFor(m, row, stored),
    multiple: Boolean(m.multiple),
  };
}

/**
 * Telegram: бот общий для всех, токен лежит в env воркера, а запись подключения лишь хранит права. Поэтому «подключено» означает,
 * что чат этого руководителя привязан к боту. Без привязки карточки и план некуда присылать: показываем «нужна настройка»
 * и личную ссылку привязки (она выводится из слага руководителя и ключа сервера, чужую подобрать нельзя).
 */
async function withTelegramBinding(db: PrismaClient, leaderId: string, item: CatalogItem): Promise<CatalogItem> {
  const bound = (await db.telegramBinding.count({ where: { leaderId, role: "LEADER" } })) > 0;
  if (bound) return item;
  const leader = await db.leader.findUnique({ where: { id: leaderId }, select: { slug: true } });
  const bot = process.env.TELEGRAM_BOT_USERNAME;
  let url: string | null = null;
  try {
    if (leader && bot) url = `https://t.me/${bot}?start=${leader.slug}_${leaderBindSecret(leader.slug)}`;
  } catch {
    url = null;
  }
  const hint = url
    ? "Telegram ещё не привязан: откройте ссылку ниже и нажмите Start в боте. Пока не привяжете, карточки решений и утренний план некуда присылать."
    : "Telegram ещё не привязан, а ссылку собрать нельзя: администратору нужно задать TELEGRAM_BOT_USERNAME и TELEGRAM_BIND_KEY.";
  const state: ConnectorState = item.state === "available" || item.state === "connected" || item.state === "paused" ? "needs_setup" : item.state;
  return { ...item, state, hint: item.hint ?? hint, link: url ? { label: "Привязать Telegram", url } : null };
}

export async function listCatalog(db: PrismaClient, leaderId: string): Promise<CatalogItem[]> {
  const rows = await db.connector.findMany({ where: { leaderId }, orderBy: { createdAt: "asc" } });
  const ready = await configuredOAuthApps(db);
  const out: CatalogItem[] = [];
  const adjust = (m: ConnectorManifest, item: CatalogItem) => (m.id === "BUILTIN_TELEGRAM" ? withTelegramBinding(db, leaderId, item) : item);
  for (const m of MODULES) {
    const mine = rows.filter((r) => r.type === m.id);
    for (const r of mine) out.push(await adjust(m, itemFor(m, r, ready)));
    // Модуль без записи (или шаблон «добавить ещё», если модуль допускает несколько) показываем как доступный.
    if (mine.length === 0 || m.multiple) out.push(await adjust(m, itemFor(m, null, ready)));
  }
  return out;
}

export type Result<T> = { ok: true; value: T } | { ok: false; code: "NOT_FOUND" | "INVALID" | "CONFLICT" | "UNAVAILABLE"; message: string };
const fail = (code: Extract<Result<never>, { ok: false }>["code"], message: string): Result<never> => ({ ok: false, code, message });

/** Служебные данные подключения (курсор, итог опроса) без смены доступов. */
export async function patchStored(db: PrismaClient, row: Row, patch: Partial<Stored>): Promise<void> {
  const cur = decryptJson<Stored>(row.encryptedConfig) ?? {};
  await db.connector.updateMany({ where: { id: row.id, leaderId: row.leaderId }, data: { encryptedConfig: encryptJson({ ...cur, ...patch }) } });
}

export const ConnectSchema = z.object({
  module: z.string().min(1),
  name: z.string().trim().min(1).max(80).optional(),
  values: z.record(z.string(), z.string().max(500)).optional(),
  mcpUrl: z.string().max(500).optional(),
  token: z.string().max(2000).optional(),
});
export type ConnectInput = z.infer<typeof ConnectSchema>;

const defaultPerms = (m: ConnectorManifest) => Object.fromEntries(m.tools.map((t) => [t.name, t.default])) as Record<string, Perm>;

export async function connectModule(db: PrismaClient, leaderId: string, input: ConnectInput, opts: { allowLocal?: boolean; /** false — не входить в ящик при подключении (тесты). */ verifyMail?: boolean; /** Адрес, по которому открыто приложение (из запроса). */ origin?: string } = {}): Promise<Result<{ id: string }>> {
  const m = getModule(input.module);
  if (!m) return fail("NOT_FOUND", "Такого модуля нет");
  if (m.status === "soon") return fail("UNAVAILABLE", `${m.name} появится позже`);
  if (m.auth.kind === "oauth") return fail("INVALID", "Этот сервис подключается через вход в аккаунт: нажмите «Войти через …»");
  if (!m.multiple && (await db.connector.findFirst({ where: { leaderId, type: m.id }, select: { id: true } }))) {
    return fail("CONFLICT", `${m.name} уже подключён`);
  }

  let stored: Stored = {};
  let permissions: Record<string, Perm> = defaultPerms(m);
  let mcpUrl: string | null = null;

  if (m.auth.kind === "none") {
    if (!envReady(m.auth.envRequired)) return fail("UNAVAILABLE", `На сервере не задано: ${(m.auth.envRequired ?? []).join(", ")}`);
  } else if (m.auth.kind === "credentials") {
    const values: Record<string, string> = {};
    for (const f of m.auth.fields) {
      const v = (input.values?.[f.key] ?? f.initial ?? "").trim();
      if (!v && !f.optional) return fail("INVALID", `Заполните поле «${f.label}»`);
      if (v) values[f.key] = v;
    }
    if (opts.origin && m.originKey) values[m.originKey] = opts.origin;
    if (opts.verifyMail !== false) {
      try {
        await verifyMailCredentials(m.id, values);
        await verifyConnectorCredentials(m.id, values);
      } catch (e) {
        return fail("INVALID", (e as Error).message);
      }
    }
    stored = { values, account: values.email };
  } else if (m.auth.kind === "mcp") {
    if (!input.mcpUrl) return fail("INVALID", "Укажите адрес сервера");
    const probe = await probeMcp(input.mcpUrl, { token: input.token, allowLocal: opts.allowLocal });
    if (!probe.ok) return fail("INVALID", probe.message);
    stored = { values: input.token ? { token: input.token } : {}, mcpTools: probe.tools, account: new URL(input.mcpUrl).hostname };
    // Новые инструменты чужого сервера всегда через руководителя.
    permissions = Object.fromEntries(probe.tools.map((t) => [t.name, "APPROVE" as Perm]));
    mcpUrl = input.mcpUrl;
  }

  let encrypted = "";
  if (m.auth.kind !== "none") {
    try {
      encrypted = encryptJson(stored);
    } catch (e) {
      if (e instanceof SecretsNotConfigured) return fail("UNAVAILABLE", e.message);
      throw e;
    }
  }
  const row = await db.connector.create({
    data: {
      leaderId,
      name: input.name ?? m.name,
      type: m.id,
      mcpUrl,
      encryptedConfig: encrypted,
      toolPermissions: permissions as Prisma.InputJsonValue,
    },
  });
  return { ok: true, value: { id: row.id } };
}

/** Токены после входа через OAuth: создаёт запись или обновляет существующую. */
export async function saveOAuthTokens(
  db: PrismaClient,
  leaderId: string,
  moduleId: string,
  tokens: NonNullable<Stored["tokens"]>,
  account?: string,
): Promise<Result<{ id: string }>> {
  const m = getModule(moduleId);
  if (!m || m.auth.kind !== "oauth") return fail("NOT_FOUND", "Такого модуля нет");
  const encrypted = encryptJson({ tokens, account } satisfies Stored);
  const existing = await db.connector.findFirst({ where: { leaderId, type: m.id } });
  if (existing) {
    await db.connector.updateMany({ where: { id: existing.id, leaderId }, data: { encryptedConfig: encrypted, isActive: true } });
    return { ok: true, value: { id: existing.id } };
  }
  const row = await db.connector.create({
    data: { leaderId, name: m.name, type: m.id, encryptedConfig: encrypted, toolPermissions: defaultPerms(m) as Prisma.InputJsonValue },
  });
  return { ok: true, value: { id: row.id } };
}

export const UpdateSchema = z.object({
  isActive: z.boolean().optional(),
  name: z.string().trim().min(1).max(80).optional(),
  /** Пустое значение секретного поля = «не менять». */
  values: z.record(z.string(), z.string().max(500)).optional(),
  permissions: z.record(z.string(), PermSchema).optional(),
});
export type UpdateInput = z.infer<typeof UpdateSchema>;

export async function updateConnector(db: PrismaClient, leaderId: string, id: string, input: UpdateInput, opts: { /** false — не ходить во внешний сервис проверять доступы (тесты). */ verify?: boolean; /** Адрес, по которому открыто приложение (из запроса). */ origin?: string } = {}): Promise<Result<null>> {
  const row = await db.connector.findFirst({ where: { id, leaderId } });
  const m = row && getModule(row.type);
  if (!row || !m) return fail("NOT_FOUND", "Подключение не найдено");

  const data: Prisma.ConnectorUpdateManyMutationInput = {};
  if (input.isActive !== undefined) data.isActive = input.isActive;
  if (input.name !== undefined && m.multiple) data.name = input.name;

  const stored = decryptJson<Stored>(row.encryptedConfig);
  if (input.values && m.auth.kind === "credentials") {
    const merged: Record<string, string> = { ...(stored?.values ?? {}) };
    for (const f of m.auth.fields) {
      const v = input.values[f.key]?.trim();
      if (v) merged[f.key] = v;
      else if (!f.secret && f.key in input.values) {
        if (!f.optional) return fail("INVALID", `Поле «${f.label}» не может быть пустым`);
        delete merged[f.key];
      }
    }
    if (opts.origin && m.originKey) merged[m.originKey] = opts.origin;
    if (opts.verify !== false) {
      try {
        await verifyConnectorCredentials(m.id, merged);
      } catch (e) {
        return fail("INVALID", (e as Error).message);
      }
    }
    try {
      data.encryptedConfig = encryptJson({ ...stored, values: merged, account: merged.email ?? stored?.account } satisfies Stored);
    } catch (e) {
      if (e instanceof SecretsNotConfigured) return fail("UNAVAILABLE", e.message);
      throw e;
    }
  }

  if (input.permissions) {
    const known = new Map(toolsFor(m, row, stored).map((t) => [t.name, t]));
    const current = PermsRecord.safeParse(row.toolPermissions).data ?? {};
    for (const [tool, perm] of Object.entries(input.permissions)) {
      const t = known.get(tool);
      if (!t) return fail("INVALID", `У подключения нет действия «${tool}»`);
      if (t.max && RANK[perm] > RANK[t.max]) return fail("INVALID", t.maxReason ?? "Это действие всегда идёт через вас");
      current[tool] = perm;
    }
    data.toolPermissions = current as Prisma.InputJsonValue;
  }

  await db.connector.updateMany({ where: { id, leaderId }, data });
  return { ok: true, value: null };
}

export async function removeConnector(db: PrismaClient, leaderId: string, id: string): Promise<Result<null>> {
  const { count } = await db.connector.deleteMany({ where: { id, leaderId } });
  return count ? { ok: true, value: null } : fail("NOT_FOUND", "Подключение не найдено");
}
