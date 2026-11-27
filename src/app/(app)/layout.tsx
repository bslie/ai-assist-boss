import { Suspense } from "react";
import { AppHeader } from "@/components/assistant/app-header";
import { AvatarLayer } from "@/components/assistant/avatar/avatar-layer";
import { getCurrentLeader } from "@/lib/current-leader";

/** Маскоту нужен руководитель, чтобы показывать, чем занят воркер именно для него. Читает сессию, поэтому живёт под Suspense. */
async function Avatar() {
  const leader = await getCurrentLeader();
  return <AvatarLayer leaderId={leader?.id} />;
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
