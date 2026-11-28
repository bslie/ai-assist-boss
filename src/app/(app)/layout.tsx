import { Suspense } from "react";
import { AppHeader } from "@/components/assistant/app-header";
import { AvatarLayer } from "@/components/assistant/avatar/avatar-layer";
import { getCurrentUser } from "@/core/auth/current-user";
import { getCurrentLeader } from "@/lib/current-leader";

/** Маскоту нужен руководитель, чтобы показывать, чем занят воркер именно для него. Читает сессию, поэтому живёт под Suspense. */
async function Avatar() {
  const leader = await getCurrentLeader();
  // Меню демо по клику на маскота только у администратора: оно пишет в БД и тратит бюджет модели.
  const user = await getCurrentUser();
  return <AvatarLayer leaderId={leader?.id} demo={user?.role === "ADMIN"} />;
}

// Руководитель и так знает, чей это помощник: имя в шапке не нужно (представляться «ИИ-помощник <имя>» агент будет в письмах и сообщениях).
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader title="ИИ-помощник руководителя" />
      {children}
      <Suspense fallback={null}>
        <Avatar />
      </Suspense>
    </div>
  );
}
