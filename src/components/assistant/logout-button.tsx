"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Выход из аккаунта: сбрасывает сессию и возвращает на страницу входа. */
export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function logout() {
    setBusy(true);
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
    router.replace("/login");
    router.refresh();
  }

  return (
    <Button variant="outline" className="h-10 gap-2 self-start rounded-full px-5" disabled={busy} onClick={logout}>
      <LogOut className="size-4" aria-hidden="true" /> Выйти из аккаунта
    </Button>
  );
}
