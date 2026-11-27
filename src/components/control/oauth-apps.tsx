"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, ShieldCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

type App = { key: string; label: string; consoleUrl: string; configured: boolean; source: "db" | "env" | null; clientIdTail: string | null };

const INPUT = "h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

async function call(method: string, body?: unknown): Promise<{ ok: true; apps: App[]; redirectUri?: string } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/control/oauth-apps", { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as { apps?: App[]; redirectUri?: string; error?: string };
    return res.ok && data.apps ? { ok: true, apps: data.apps, redirectUri: data.redirectUri } : { ok: false, error: data.error ?? `Ошибка ${res.status}` };
  } catch {
    return { ok: false, error: "Нет связи с сервером" };
  }
}

/** Ключи OAuth-приложений Google и Microsoft: секрет уходит на сервер и шифруется, обратно не возвращается. */
export function OAuthApps() {
  const [apps, setApps] = useState<App[] | null>(null);
  const [redirectUri, setRedirectUri] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    call("GET").then((r) => {
      if (!alive) return;
      if (r.ok) {
        setApps(r.apps);
        setRedirectUri(r.redirectUri ?? "");
      } else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-normal">Интеграции</h1>
        <p className="text-sm text-dim">
          Ключи приложений, через которые пользователи входят в Google и Microsoft. Задаются один раз. Секрет хранится в зашифрованном виде и после сохранения не показывается.
        </p>
      </header>
      {error && <p role="alert" className="text-sm text-coral">{error}</p>}
      {!apps && !error && <p className="text-sm text-dim">Загружаю…</p>}
      {apps?.map((a) => (
        <AppForm key={a.key} app={a} redirectUri={redirectUri} onChange={setApps} />
      ))}
    </div>
  );
}

function AppForm({ app, redirectUri, onChange }: { app: App; redirectUri: string; onChange: (a: App[]) => void }) {
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    setBusy(true);
    setMsg(null);
    const r = await call("PUT", { key: app.key, clientId, clientSecret: secret || undefined });
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: r.error });
    setSecret("");
    setClientId("");
    onChange(r.apps);
    setMsg({ ok: true, text: "Сохранено. Секрет зашифрован и больше не показывается." });
  }

  async function remove() {
    setBusy(true);
    const r = await call("DELETE", { key: app.key });
    setBusy(false);
    if (r.ok) {
      onChange(r.apps);
      setMsg({ ok: true, text: "Ключи удалены." });
    } else setMsg({ ok: false, text: r.error });
  }

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-border bg-sunken p-5" aria-label={app.label}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-medium">{app.label}</h2>
        {app.configured ? (
          <span className="flex items-center gap-1.5 text-sm text-sage">
            <CheckCircle2 className="size-4" aria-hidden="true" /> Настроено{app.source === "env" ? " (из переменных окружения)" : ""}
            {app.clientIdTail && <span className="text-dim"> · Client ID …{app.clientIdTail}</span>}
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-sm text-dim">
            <XCircle className="size-4" aria-hidden="true" /> Не настроено
          </span>
        )}
        <a href={app.consoleUrl} target="_blank" rel="noreferrer" className="ml-auto flex items-center gap-1 text-sm text-amber underline underline-offset-4">
          Открыть кабинет <ExternalLink className="size-3.5" aria-hidden="true" />
        </a>
      </div>

      <div className="flex flex-col gap-1 text-xs text-dim">
        Redirect URI, который приложение отправляет сервису. Запишите в кабинете в точности его (с https и без слэша в конце):
        <code className="rounded-lg bg-background px-3 py-2 text-[13px] text-soft [overflow-wrap:anywhere]">{redirectUri || "…"}</code>
      </div>

      <form
        className="flex flex-col gap-3"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="flex flex-col gap-1.5 text-sm">
          Client ID
          <input value={clientId} onChange={(e) => setClientId(e.target.value)} className={INPUT} autoComplete="off" spellCheck={false} placeholder={app.configured ? "Оставьте пустым только если не меняете" : "123456-abc.apps.googleusercontent.com"} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          Client secret
          <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} className={INPUT} autoComplete="new-password" spellCheck={false} placeholder={app.configured ? "•••••••• (пусто — не менять)" : "GOCSPX-…"} />
        </label>
        <div className="flex items-center gap-2 text-xs text-dim">
          <ShieldCheck className="size-3.5 shrink-0 text-sage" aria-hidden="true" />
          Секрет передаётся по защищённому соединению, шифруется на сервере и обратно в браузер не возвращается.
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={busy || (!clientId && !secret) || (!app.configured && (!clientId || !secret))}>
            {busy ? "Сохраняю…" : "Сохранить"}
          </Button>
          {app.configured && app.source === "db" && (
            <Button type="button" variant="ghost" disabled={busy} onClick={remove} className="text-dim hover:text-coral">
              Удалить ключи
            </Button>
          )}
          {msg && <span role="status" className={`text-sm ${msg.ok ? "text-sage" : "text-coral"}`}>{msg.text}</span>}
        </div>
      </form>
    </section>
  );
}
