"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const EVENTS = ["decision.created", "decision.updated", "email.processed", "task.updated", "metrics.updated"] as const;

/** Подписка на SSE `/api/stream`: по любому событию перечитывает данные страницы (с задержкой на пачку событий). */
export function LiveRefresh({ leaderId }: { leaderId: string }) {
  const router = useRouter();
  useEffect(() => {
    const es = new EventSource(`/api/stream?leaderId=${encodeURIComponent(leaderId)}`);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        router.refresh();
      }, 400);
    };
    EVENTS.forEach((e) => es.addEventListener(e, refresh));
    return () => {
      if (timer) clearTimeout(timer);
      es.close();
    };
  }, [leaderId, router]);
  return null;
}
