import { Suspense } from "react";
import { connection } from "next/server";
import { LoginForm } from "@/components/auth/login-form";

export const metadata = { title: "Вход · ИИ-помощник руководителя" };

async function Form({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  await connection();
  const sp = await searchParams;
  const bot = process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, "") || null;
  return <LoginForm telegramBot={bot} next={sp.next ?? "/"} />;
}

export default function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  return (
    <main className="flex min-h-screen flex-1 items-center justify-center px-4 py-12">
      <Suspense fallback={<div className="text-dim">Загружаю…</div>}>
        <Form searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
