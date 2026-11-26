import { Suspense } from "react";
import { AppHeader } from "@/components/assistant/app-header";
import { getCurrentLeader } from "@/lib/current-leader";

const FALLBACK_TITLE = "ИИ-помощник";

async function LeaderHeader() {
  const leader = await getCurrentLeader();
  // Агент всегда представляется как «ИИ-помощник <имя руководителя>» (CLAUDE.md).
  return <AppHeader title={leader ? `${FALLBACK_TITLE} ${leader.name}` : FALLBACK_TITLE} />;
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <Suspense fallback={<AppHeader title={FALLBACK_TITLE} />}>
        <LeaderHeader />
      </Suspense>
      {children}
    </div>
  );
}
