import { AppHeader } from "@/components/assistant/app-header";
import { demoLeader } from "@/lib/demo-data";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader title={demoLeader.assistantTitle} />
      {children}
    </div>
  );
}
