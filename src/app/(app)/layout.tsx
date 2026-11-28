import { Suspense } from "react";
import { AppHeader } from "@/components/assistant/app-header";
import { AvatarLayer } from "@/components/assistant/avatar/avatar-layer";
import { getCurrentUser } from "@/core/auth/current-user";
import { getCurrentLeader } from "@/lib/current-leader";

/** Маскоту нужен руководитель, чтобы показывать, чем занят воркер именно для него. Читает сессию, поэтому живёт под Suspense. */
async function Avatar() {
  const leader = await getCurrentLeader();
  // Демо-стенд: меню по клику на маскота доступно и обычному руководителю, а часы (общие для всех) только администратору.
  const user = await getCurrentUser();
  return <AvatarLayer leaderId={leader?.id} demo={Boolean(user)} isAdmin={user?.role === "ADMIN"} />;
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
