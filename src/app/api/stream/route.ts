import { subscribeEvents } from "@/core/events";
import { requireLeaderId } from "@/lib/http";

/** SSE `/api/stream?leaderId=`: decision.created|updated, email.processed, task.updated, metrics.updated, avatar.speak. */
export async function GET(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;

  const enc = new TextEncoder();
  let unsubscribe: (() => Promise<void>) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => {
        if (!closed) controller.enqueue(enc.encode(chunk));
      };
      const close = async () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        await unsubscribe?.();
        try {
          controller.close();
        } catch {
          /* уже закрыт */
        }
      };
      req.signal.addEventListener("abort", () => void close());

      unsubscribe = await subscribeEvents(auth.leaderId, (e) => {
        send(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
      });
      send(`retry: 3000\n: ready\n\n`);
      heartbeat = setInterval(() => send(`: ping\n\n`), 15_000);
    },
    async cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      await unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
