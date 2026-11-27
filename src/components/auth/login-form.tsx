"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Eye, EyeOff, Loader2, Mail, Send, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";

type Props = { telegramEnabled: boolean; next: string; initialError: string | null };

const TELEGRAM_ERRORS: Record<string, string> = {
  not_configured: "Вход через Telegram не настроен: задайте TELEGRAM_LOGIN_CLIENT_ID и TELEGRAM_LOGIN_CLIENT_SECRET.",
  denied: "Вход через Telegram отменён.",
  state: "Сессия входа устарела, попробуйте ещё раз.",
  exchange: "Telegram не подтвердил вход, попробуйте ещё раз.",
  signature: "Не удалось проверить ответ Telegram.",
  expired: "Ответ Telegram устарел, попробуйте ещё раз.",
  not_linked: "Этот Telegram-аккаунт не привязан к доступу в приложение. Обратитесь к администратору.",
};

const FIELD =
  "h-11 w-full rounded-lg border border-border bg-background px-3 text-[15px] outline-none transition-colors placeholder:text-dim/60 hover:border-line-strong focus-visible:border-amber focus-visible:ring-2 focus-visible:ring-ring/40";

const POINTS = [
  { icon: Mail, text: "Разбирает почту и готовит ответы" },
  { icon: CalendarClock, text: "Ведёт день, встречи и задачи" },
  { icon: ShieldCheck, text: "Важное решаете только вы" },
];

/** Вход: логин и пароль, либо Telegram (OpenID Connect, полный редирект). Успех — переход на `next`. */
export function LoginForm({ telegramEnabled, next, initialError }: Props) {
  const router = useRouter();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const [error, setError] = useState<string | null>(
    initialError ? (TELEGRAM_ERRORS[initialError] ?? "Вход через Telegram не прошёл") : null,
  );

  const done = () => {
    router.replace(/^\/(?![/\\])/.test(next) ? next : "/");
    router.refresh();
  };

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login, password }),
    });
    setBusy(false);
    if (res.ok) return done();
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    setError(data.error ?? "Не удалось войти");
  }

  return (
    <div data-login-card className="relative z-10 grid w-full max-w-[960px] overflow-hidden rounded-3xl border border-border bg-raised shadow-2xl shadow-black/40 md:grid-cols-[1fr_420px]">
      <aside className="hidden flex-col justify-between gap-10 border-r border-border bg-sunken p-10 md:flex">
        <div className="flex items-center gap-3">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <circle cx="16" cy="16" r="15" stroke="var(--amber)" strokeWidth="1.5" />
            <circle cx="16" cy="16" r="9" stroke="var(--amber)" strokeWidth="1.5" opacity="0.6" />
            <circle cx="16" cy="16" r="3.5" fill="var(--amber)" />
          </svg>
          <span className="font-serif text-lg">ИИ-помощник руководителя</span>
        </div>
        <div className="flex flex-col gap-6">
          <h2 className="font-serif text-[34px] leading-[1.15] tracking-[-0.02em]">
            Утро начинается <span className="text-amber">с готового плана</span>
          </h2>
          <ul className="flex flex-col gap-3 text-[15px] text-soft">
            {POINTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3">
                <span className="flex size-8 items-center justify-center rounded-full border border-line bg-raised text-amber">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-dim">Доступ выдаёт администратор. Нет учётной записи — обратитесь к нему.</p>
      </aside>

      <div className="flex flex-col gap-6 p-6 sm:p-10">
        <div className="flex flex-col gap-1.5">
          <h1 className="font-serif text-[28px] font-medium tracking-[-0.01em]">С возвращением</h1>
          <p className="text-sm text-dim">Войдите, чтобы увидеть, что уже решено без вас.</p>
        </div>

        <form onSubmit={submitPassword} className="flex flex-col gap-4" aria-label="Вход по логину и паролю">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-soft">Логин</span>
            <input name="login" autoComplete="username" autoFocus required placeholder="например, ivanov" value={login} onChange={(e) => setLogin(e.target.value)} className={FIELD} />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-soft">Пароль</span>
            <div className="relative">
              <input
                name="password"
                type={show ? "text" : "password"}
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyUp={(e) => setCaps(e.getModifierState("CapsLock"))}
                onBlur={() => setCaps(false)}
                className={`${FIELD} pr-11`}
              />
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                aria-label={show ? "Скрыть пароль" : "Показать пароль"}
                aria-pressed={show}
                className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-dim transition-colors hover:text-foreground"
              >
                {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            {caps ? <span className="text-xs text-amber">Включён Caps Lock</span> : null}
          </label>
          <Button type="submit" size="lg" disabled={busy || !login || !password} className="mt-1 h-11 w-full text-[15px]">
            {busy ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Вхожу…
              </>
            ) : (
              "Войти"
            )}
          </Button>
        </form>

        {error ? (
          <p role="alert" className="rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-sm text-coral">
            {error}
          </p>
        ) : null}

        {telegramEnabled ? (
          <>
            <div className="flex items-center gap-3 text-xs text-dim" role="separator">
              <span className="h-px flex-1 bg-border" />
              или продолжить через
              <span className="h-px flex-1 bg-border" />
            </div>
            <a
              href={`/api/auth/telegram/start?next=${encodeURIComponent(next)}`}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-border bg-background text-[15px] transition-colors hover:border-line-strong focus-visible:border-amber focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <Send className="size-4" aria-hidden="true" /> Войти через Telegram
            </a>
          </>
        ) : (
          <p className="text-center text-xs text-dim">Вход через Telegram не настроен: задайте TELEGRAM_LOGIN_CLIENT_ID и TELEGRAM_LOGIN_CLIENT_SECRET.</p>
        )}
      </div>
    </div>
  );
}
