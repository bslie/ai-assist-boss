"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

type Props = { telegramBot: string | null; next: string };

declare global {
  interface Window {
    onTelegramLogin?: (user: Record<string, string | number>) => void;
  }
}

/** Вход: логин и пароль, либо Telegram Login Widget. Успех — переход на `next`. */
export function LoginForm({ telegramBot, next }: Props) {
  const router = useRouter();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const widgetRef = useRef<HTMLDivElement>(null);

  const done = () => {
    router.replace(next.startsWith("/") && !next.startsWith("//") ? next : "/");
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

  // Виджет Telegram: скрипт подгружается один раз, колбэк шлёт подписанные данные на сервер.
  useEffect(() => {
    if (!telegramBot || !widgetRef.current) return;
    window.onTelegramLogin = async (user) => {
      setError(null);
      const res = await fetch("/api/auth/telegram", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(user),
      });
      if (res.ok) return done();
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "Вход через Telegram не прошёл");
    };
    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.async = true;
    script.setAttribute("data-telegram-login", telegramBot);
    script.setAttribute("data-size", "large");
    script.setAttribute("data-radius", "12");
    script.setAttribute("data-onauth", "onTelegramLogin(user)");
    script.setAttribute("data-request-access", "write");
    widgetRef.current.replaceChildren(script);
    return () => {
      delete window.onTelegramLogin;
    };
    // done меняется на каждом рендере, но переход нужен только один раз на монтирование
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [telegramBot]);

  return (
    <div className="flex w-full max-w-[400px] flex-col gap-6 rounded-2xl border border-border bg-raised p-8 shadow-sm">
      <div className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl font-medium">Вход</h1>
        <p className="text-sm text-dim">Войдите логином и паролем или через Telegram.</p>
      </div>

      <form onSubmit={submitPassword} className="flex flex-col gap-3" aria-label="Вход по логину и паролю">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-dim">Логин</span>
          <input
            name="login"
            autoComplete="username"
            required
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            className="h-11 rounded-lg border border-border bg-background px-3 text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-dim">Пароль</span>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-11 rounded-lg border border-border bg-background px-3 text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <Button type="submit" size="lg" disabled={busy || !login || !password} className="mt-1 h-11 w-full text-[15px]">
          {busy ? "Вхожу…" : "Войти"}
        </Button>
      </form>

      {telegramBot ? (
        <>
          <div className="flex items-center gap-3 text-xs text-dim" role="separator">
            <span className="h-px flex-1 bg-border" />
            или
            <span className="h-px flex-1 bg-border" />
          </div>
          <div ref={widgetRef} className="flex min-h-[44px] justify-center" />
        </>
      ) : (
        <p className="text-center text-xs text-dim">Вход через Telegram не настроен: задайте TELEGRAM_BOT_USERNAME.</p>
      )}

      {error ? (
        <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
