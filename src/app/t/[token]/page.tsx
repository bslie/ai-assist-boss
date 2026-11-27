import { Suspense } from "react";
import { readyClock } from "@/core/clock";
import { viewTaskByLink } from "@/core/tasks/email-link";
import { db } from "@/db/client";
import { TaskAnswer } from "./task-answer";

export const metadata = { title: "Поручение · ИИ-помощник руководителя", robots: { index: false } };

async function Card({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  await readyClock();
  const view = await viewTaskByLink(db, token);
  if (!view) {
    return (
      <div className="flex flex-col gap-2 text-center">
        <div className="font-serif text-2xl">Ссылка не работает</div>
        <p className="text-soft">Возможно, задачу удалили или ссылка скопирована не полностью. Ответьте на письмо, и руководитель увидит ответ.</p>
      </div>
    );
  }
  return <TaskAnswer token={token} view={view} />;
}

/** Публичная страница исполнителя (SPEC 4.3.2): поручение пришло письмом, ответ — без входа и без Telegram. */
export default function TaskLinkPage(props: { params: Promise<{ token: string }> }) {
  return (
    <main className="flex min-h-dvh flex-1 items-center justify-center px-4 py-10">
      <div className="w-full max-w-[460px]">
        <Suspense fallback={<div className="text-center text-dim">Загружаю поручение…</div>}>
          <Card {...props} />
        </Suspense>
      </div>
    </main>
  );
}
