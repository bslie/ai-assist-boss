import { Suspense } from "react";
import { connection } from "next/server";
import { LoginForm } from "@/components/auth/login-form";
import { readOidcConfig } from "@/core/auth/telegram-oidc";
import { LoginScene } from "@/components/auth/login-scene";

export const metadata = { title: "Вход · ИИ-помощник руководителя" };

type SearchParams = Promise<{ next?: string | string[]; error?: string | string[] }>;

/** Только путь внутри приложения: `//host` и `/\host` браузер понимает как другой сайт (открытый редирект). */
const safeNext = (v: string | string[] | undefined) => (typeof v === "string" && /^\/(?![/\\])/.test(v) ? v : "/");

async function Form({ searchParams }: { searchParams: SearchParams }) {
  await connection();
  const sp = await searchParams;
  const error = typeof sp.error === "string" && /^[a-z_]{1,30}$/.test(sp.error) ? sp.error : null;
  return <LoginForm telegramEnabled={readOidcConfig() !== null} next={safeNext(sp.next)} initialError={error} />;
}

export default function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main className="relative flex min-h-screen flex-1 items-center justify-center overflow-hidden px-4 py-10">
      <LoginScene />
      <Suspense fallback={<div className="text-dim">Загружаю…</div>}>
        <Form searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
