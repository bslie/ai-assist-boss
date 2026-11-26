import { Suspense } from "react";
import { redirect } from "next/navigation";
import { ControlPanel } from "@/components/control/control-panel";
import { getCurrentUser } from "@/core/auth/current-user";
import { db } from "@/db/client";

export const metadata = { title: "Панель управления · ИИ-помощник руководителя" };

async function Guarded() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/control");
  if (user.role !== "ADMIN") redirect("/");
  const leaders = await db.leader.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, name: true } });
  return <ControlPanel viewer={{ displayName: user.displayName, login: user.login }} leaders={leaders} />;
}

/** Панель управления: только для ADMIN. Остальные — на главную (API дополнительно отдаёт 403). */
export default function ControlPage() {
  return (
    <Suspense fallback={<div className="p-10 text-dim">Загружаю…</div>}>
      <Guarded />
    </Suspense>
  );
}
