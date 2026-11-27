"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Lock, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PermissionToggle } from "@/components/assistant/permission-toggle";
import { Switch } from "@/components/assistant/switch";
import { ConnectorIcon, StatePill } from "@/components/assistant/connector-card";
import type { Perm } from "@/core/connectors/types";
import type { CatalogItem } from "@/core/connectors/service";

export type Api = <T = unknown>(path: string, init?: { method?: string; body?: unknown }) => Promise<{ ok: boolean; data: T & { error?: string } }>;

interface Props {
  item: CatalogItem | null;
  leaderId: string;
  api: Api;
  onClose: () => void;
  /** Данные изменились: перечитать каталог. `select` — открыть подключение после создания. */
  onChanged: (select?: string) => Promise<void>;
}

const inputCls =
  "min-h-11 w-full rounded-xl border border-line-strong bg-ink px-3.5 text-[15px] outline-none transition-colors placeholder:text-dim focus:border-amber/70";

/** Правая панель подключения: вход, редактирование доступов, права инструментов, отключение. */
export function ConnectorDrawer({ item, leaderId, api, onClose, onChanged }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (item && !d.open) d.showModal();
    if (!item && d.open) d.close();
  }, [item]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-label={item ? item.name : "Подключение"}
      className="drawer m-0 ml-auto h-dvh max-h-none w-full max-w-[520px] border-l border-line-strong bg-sunken p-0 text-foreground backdrop:bg-black/60 backdrop:backdrop-blur-[2px]"
    >
      {/* key: при смене подключения форма начинается с чистого состояния */}
      {item && <Body key={item.key} item={item} leaderId={leaderId} api={api} onClose={onClose} onChanged={onChanged} />}
    </dialog>
  );
}

function Body({ item, leaderId, api, onClose, onChanged }: Props & { item: CatalogItem }) {
  const connected = item.connectorId !== null;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // `{origin}` в начальном значении — адрес, по которому открыто приложение (например, публичный адрес для Recall).
  const [values, setValues] = useState<Record<string, string>>(() => {
    const out = { ...item.values };
    for (const f of item.auth.fields) {
      if (!f.secret && !out[f.key] && f.initial?.includes("{origin}")) out[f.key] = f.initial.replace("{origin}", window.location.origin);
    }
    return out;
  });
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [mcpUrl, setMcpUrl] = useState(item.mcpUrl ?? "");
  const [token, setToken] = useState("");
  const [name, setName] = useState(item.multiple && connected ? item.name : "");
  const [found, setFound] = useState<{ name: string; description: string; readOnly: boolean }[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const say = (ok: boolean, text: string) => {
    setMsg({ ok, text });
    if (ok) setTimeout(() => setMsg((m) => (m?.text === text ? null : m)), 2500);
  };

  async function run<T>(fn: () => Promise<{ ok: boolean; data: T & { error?: string } }>, success: string, after?: (d: T) => Promise<void> | void) {
    setBusy(true);
    setMsg(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) return say(false, r.data.error ?? "Не получилось");
    say(true, success);
    await after?.(r.data);
  }

  const q = `leaderId=${encodeURIComponent(leaderId)}`;
  const isMcp = item.auth.kind === "mcp";
  const reads = item.tools.filter((t) => t.kind === "read");
  const writes = item.tools.filter((t) => t.kind === "write");

  const setPerm = (tool: string, p: Perm) =>
    run(() => api(`/api/connectors/${item.connectorId}?${q}`, { method: "PATCH", body: { permissions: { [tool]: p } } }), "Сохранено", () => onChanged());

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start gap-3.5 border-b border-line px-6 pb-5 pt-6">
        <ConnectorIcon letter={item.letter} color={item.color} size={48} />
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-[26px] font-medium leading-tight">{item.name}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-dim">
            <StatePill state={item.state} />
            <span>{item.vendor}</span>
            {item.account && <span className="w-full truncate">{item.account}</span>}
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="Закрыть" className="-mr-2 -mt-1 flex size-11 items-center justify-center rounded-full text-dim transition-colors hover:bg-raised hover:text-foreground">
          <X size={20} />
        </button>
      </header>

      <div className="no-scrollbar flex flex-1 flex-col gap-7 overflow-y-auto px-6 py-6">
        <p className="text-[15px] text-soft">{item.description}</p>

        {item.hint && <div className="rounded-2xl border border-line bg-ink px-4 py-3 text-[13px] text-amber">{item.hint}</div>}

        {connected && item.state !== "needs_auth" && (
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-ink pl-4 pr-1">
            <div>
              <div className="text-[15px]">{item.state === "paused" ? "Выключено" : "Включено"}</div>
              <div className="text-[13px] text-dim">{item.state === "paused" ? "Я не пользуюсь этим сервисом, доступы сохранены." : "Я могу пользоваться сервисом в рамках прав ниже."}</div>
            </div>
            <Switch
              label={`${item.name}: включено`}
              checked={item.state === "connected"}
              disabled={busy}
              onChange={(v) => run(() => api(`/api/connectors/${item.connectorId}?${q}`, { method: "PATCH", body: { isActive: v } }), v ? "Включено" : "Выключено", () => onChanged())}
            />
          </div>
        )}

        {connected && item.state === "connected" && item.pollable && (
          <section className="flex flex-col gap-2.5 rounded-2xl border border-line bg-ink p-4">
            <div className="text-[15px]">Проверка почты</div>
            <div className={`text-[13px] ${item.lastSync?.error ? "text-coral" : "text-dim"}`}>
              {!item.lastSync
                ? "Автоматически раз в пару минут. Пока ни разу не проверяла."
                : item.lastSync.error
                  ? `Последняя проверка не удалась: ${item.lastSync.error}`
                  : `Последняя проверка: ${new Date(item.lastSync.at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}, новых писем: ${item.lastSync.fetched}.`}
            </div>
            <Button
              variant="outline"
              className="h-11 self-start rounded-full px-5"
              disabled={busy}
              onClick={() => run(() => api<{ fetched: number; decisions: number }>(`/api/connectors/${item.connectorId}/poll?${q}`, { method: "POST" }), "Проверила", async (d) => { say(true, d.fetched ? `Новых писем: ${d.fetched}, карточек: ${d.decisions}` : "Новых писем нет"); await onChanged(); })}
            >
              {busy ? "Проверяю…" : "Проверить сейчас"}
            </Button>
          </section>
        )}

        {!connected && item.sees.length > 0 && (
          <section className="flex flex-col gap-2.5">
            <h3 className="text-xs font-medium uppercase tracking-[0.08em] text-dim">Что я смогу</h3>
            <ul className="flex flex-col gap-2 text-[15px]">
              {item.sees.map((s) => (
                <li key={s} className="flex gap-2.5">
                  <Check size={16} className="mt-1 shrink-0 text-sage" aria-hidden="true" />
                  {s}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Вход и доступы */}
        {item.auth.kind === "oauth" && (
          <section className="flex flex-col gap-3">
            <h3 className="text-xs font-medium uppercase tracking-[0.08em] text-dim">Вход</h3>
            <p className="text-[13px] text-dim">
              Откроется страница входа сервиса. Пароль вводится только там: до меня он не доходит. Отозвать доступ можно здесь или в настройках аккаунта.
            </p>
            <a
              href={item.state === "needs_setup" ? undefined : `/api/connectors/oauth/start?${q}&module=${encodeURIComponent(item.moduleId)}`}
              aria-disabled={item.state === "needs_setup"}
              className={`flex min-h-12 items-center justify-center rounded-full px-6 font-semibold ${item.state === "needs_setup" ? "cursor-not-allowed bg-line-strong text-dim" : "bg-amber text-[#1b1305] transition-transform hover:scale-[1.02]"}`}
            >
              {connected ? "Войти заново" : `Войти через ${item.vendor}`}
            </a>
          </section>
        )}

        {item.auth.kind === "credentials" && (
          <section className="flex flex-col gap-3.5">
            {item.setup.length > 0 && !connected && (
              <div className="rounded-2xl border border-line bg-ink px-4 py-3.5">
                <h3 className="mb-2 text-[13px] font-medium text-soft">Как подключить</h3>
                <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-[13px] text-dim">
                  {item.setup.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
              </div>
            )}
            <h3 className="text-xs font-medium uppercase tracking-[0.08em] text-dim">Доступ</h3>
            {item.auth.fields.map((f) => {
              const filled = f.secret && item.filledSecrets.includes(f.key);
              return (
                <label key={f.key} className="flex flex-col gap-1.5">
                  <span className="text-[13px] text-soft">
                    {f.label}
                    {f.optional && <span className="text-dim"> · необязательно</span>}
                  </span>
                  <input
                    type={f.secret ? "password" : "text"}
                    autoComplete="off"
                    value={f.secret ? (secrets[f.key] ?? "") : (values[f.key] ?? "")}
                    onChange={(e) => (f.secret ? setSecrets({ ...secrets, [f.key]: e.target.value }) : setValues({ ...values, [f.key]: e.target.value }))}
                    placeholder={filled ? "•••••••• (оставьте пустым, чтобы не менять)" : f.placeholder}
                    className={inputCls}
                  />
                  {f.help && <span className="text-xs text-dim">{f.help}</span>}
                </label>
              );
            })}
            <div className="flex items-center gap-2 text-xs text-dim">
              <ShieldCheck size={14} className="shrink-0 text-sage" aria-hidden="true" />
              Пароли хранятся в зашифрованном виде и не показываются даже вам.
            </div>
            <Button
              className="h-12 rounded-full bg-amber px-6 font-semibold text-[#1b1305] hover:bg-amber/90"
              disabled={busy}
              onClick={() => {
                const all = { ...values, ...Object.fromEntries(Object.entries(secrets).filter(([, v]) => v)) };
                return connected
                  ? run(() => api(`/api/connectors/${item.connectorId}?${q}`, { method: "PATCH", body: { values: all } }), "Доступы сохранены", () => { setSecrets({}); return onChanged(); })
                  : run(() => api<{ id: string }>(`/api/connectors?${q}`, { method: "POST", body: { module: item.moduleId, values: all } }), "Подключено", (d) => onChanged(d.id));
              }}
            >
              {busy ? "Проверяю доступы…" : connected ? "Проверить и сохранить" : "Проверить и подключить"}
            </Button>
          </section>
        )}

        {isMcp && (
          <section className="flex flex-col gap-3.5">
            <h3 className="text-xs font-medium uppercase tracking-[0.08em] text-dim">{connected ? "Сервер" : "Адрес сервера"}</h3>
            {connected ? (
              <div className="rounded-xl border border-line bg-ink px-3.5 py-3 text-[14px] text-soft [overflow-wrap:anywhere]">{item.mcpUrl}</div>
            ) : (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[13px] text-soft">Название</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Например, Трекер задач" className={inputCls} />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[13px] text-soft">Адрес MCP-сервера</span>
                  <input value={mcpUrl} onChange={(e) => { setMcpUrl(e.target.value); setFound(null); }} placeholder="https://" inputMode="url" className={inputCls} />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[13px] text-soft">Ключ доступа (если сервер его требует)</span>
                  <input type="password" autoComplete="off" value={token} onChange={(e) => { setToken(e.target.value); setFound(null); }} className={inputCls} />
                </label>
                {!found ? (
                  <Button
                    variant="outline"
                    className="h-12 rounded-full px-6"
                    disabled={busy || !mcpUrl.trim()}
                    onClick={() => run(() => api<{ tools: NonNullable<typeof found> }>(`/api/connectors/probe?${q}`, { method: "POST", body: { url: mcpUrl.trim(), token: token || undefined } }), "Сервер ответил", (d) => setFound(d.tools))}
                  >
                    {busy ? "Смотрю…" : "Посмотреть, что умеет сервер"}
                  </Button>
                ) : (
                  <div className="chat-in flex flex-col gap-3 rounded-2xl border border-line bg-ink p-4">
                    <div className="text-[13px] text-dim">Нашла {found.length} действий. Пока все на вашем подтверждении, изменить можно после подключения.</div>
                    <ul className="flex flex-col gap-1.5 text-[14px]">
                      {found.map((t) => (
                        <li key={t.name} className="flex justify-between gap-3">
                          <span className="[overflow-wrap:anywhere]">{t.name}</span>
                          <span className="shrink-0 text-xs text-dim">{t.readOnly ? "чтение" : "запись"}</span>
                        </li>
                      ))}
                    </ul>
                    <Button
                      className="h-12 rounded-full bg-amber px-6 font-semibold text-[#1b1305] hover:bg-amber/90"
                      disabled={busy}
                      onClick={() => run(() => api<{ id: string }>(`/api/connectors?${q}`, { method: "POST", body: { module: item.moduleId, name: name || undefined, mcpUrl: mcpUrl.trim(), token: token || undefined } }), "Подключено", (d) => onChanged(d.id))}
                    >
                      Подключить
                    </Button>
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {isMcp && connected && (
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] text-soft">Название</span>
            <div className="flex gap-2">
              <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
              <Button variant="outline" className="h-11 rounded-full px-5" disabled={busy || !name.trim() || name === item.name} onClick={() => run(() => api(`/api/connectors/${item.connectorId}?${q}`, { method: "PATCH", body: { name: name.trim() } }), "Название сохранено", () => onChanged())}>
                Сохранить
              </Button>
            </div>
          </label>
        )}

        {item.auth.kind === "none" && !connected && (
          <Button
            className="h-12 rounded-full bg-amber px-6 font-semibold text-[#1b1305] hover:bg-amber/90"
            disabled={busy || item.state !== "available"}
            onClick={() => run(() => api<{ id: string }>(`/api/connectors?${q}`, { method: "POST", body: { module: item.moduleId } }), "Подключено", (d) => onChanged(d.id))}
          >
            Подключить
          </Button>
        )}

        {/* Права инструментов */}
        {connected && item.state !== "needs_auth" && item.tools.length > 0 && (
          <section className="flex flex-col gap-1">
            <h3 className="text-xs font-medium uppercase tracking-[0.08em] text-dim">Что мне можно</h3>
            <p className="text-[13px] text-dim">«Сама» значит без вопроса к вам, «Спрашивать» — сначала покажу карточку. Защищённые темы (кадры, деньги, клиенты) я всё равно принесу вам.</p>
            {[["Чтение", reads], ["Действия", writes]].map(([title, list]) =>
              (list as typeof reads).length ? (
                <div key={title as string} className="mt-3 flex flex-col divide-y divide-line">
                  <div className="pb-1 text-[13px] font-medium text-soft">{title as string}</div>
                  {(list as typeof reads).map((t) => (
                    <PermissionToggle key={t.name} label={t.label} description={t.description} value={t.permission} max={t.max} maxReason={t.maxReason} disabled={busy} onChange={(p) => setPerm(t.name, p)} />
                  ))}
                </div>
              ) : null,
            )}
          </section>
        )}

        {connected && (
          <section className="mt-auto flex flex-col gap-2.5 border-t border-line pt-5">
            {confirmDelete ? (
              <div className="chat-in flex flex-col gap-3 rounded-2xl bg-[#2a1a18] p-4">
                <div className="flex items-start gap-2 text-[14px] text-coral">
                  <Lock size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
                  Отключу {item.name} и сотру сохранённые доступы. Права придётся настраивать заново.
                </div>
                <div className="flex gap-2">
                  <Button className="h-11 rounded-full bg-coral px-5 font-semibold text-[#2a0c08] hover:bg-coral/90" disabled={busy} onClick={() => run(() => api(`/api/connectors/${item.connectorId}?${q}`, { method: "DELETE" }), "Отключено", async () => { onClose(); await onChanged(); })}>
                    Да, отключить
                  </Button>
                  <Button variant="ghost" className="h-11 rounded-full px-5 text-dim" onClick={() => setConfirmDelete(false)}>Отмена</Button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirmDelete(true)} className="min-h-11 self-start text-[13px] text-dim underline underline-offset-4 hover:text-coral">
                Отключить и стереть доступы
              </button>
            )}
          </section>
        )}
      </div>

      <div aria-live="polite" className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-6">
        {msg && (
          <div className={`chat-in rounded-full px-4 py-2 text-[13px] shadow-lg ${msg.ok ? "bg-sage text-[#0b1e10]" : "bg-coral text-[#2a0c08]"}`}>{msg.text}</div>
        )}
      </div>
    </div>
  );
}
