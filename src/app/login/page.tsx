import { Suspense } from "react";
import { connection } from "next/server";
import { LoginForm } from "@/components/auth/login-form";
import { LoginScene } from "@/components/auth/login-scene";

export const metadata = { title: "Вход · ИИ-помощник руководителя" };

async function Form({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  await connection();
  const sp = await searchParams;
  const bot = process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, "") || null;
  return <LoginForm telegramBot={bot} next={sp.next ?? "/"} />;
}

export default function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  return (
    <main className="relative flex min-h-screen flex-1 items-center justify-center overflow-hidden px-4 py-10">
      <LoginScene />
      <Suspense fallback={<div className="text-dim">Загружаю…</div>}>
        <Form searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
