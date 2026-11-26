import { AppHeader } from "@/components/assistant/app-header";
import { AvatarLayer } from "@/components/assistant/avatar/avatar-layer";

// Руководитель и так знает, чей это помощник: имя в шапке не нужно (представляться «ИИ-помощник <имя>» агент будет в письмах и сообщениях).
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader title="ИИ-помощник руководителя" />
      {children}
      <AvatarLayer />
    </div>
  );
}
