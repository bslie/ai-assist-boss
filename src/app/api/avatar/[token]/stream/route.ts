import { subscribeEvents } from "@/core/events";
import { db } from "@/db/client";
import { jsonError } from "@/lib/http";

/** SSE для страницы аватара: только `avatar.speak` этой встречи (фильтр по токену), остальные события руководителя не отдаём. */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const meeting = await db.meeting.findUnique({ where: { avatarToken: token }, select: { leaderId: true } });
  if (!meeting) return jsonError(404, "Встреча не найдена");

  const enc = new TextEncoder();
  let unsubscribe: (() => Promise<void>) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => {
        if (!closed) controller.enqueue(enc.encode(s));
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
      unsubscribe = await subscribeEvents(meeting.leaderId, (e) => {
        if (e.type !== "avatar.speak" || e.data.token !== token) return;
        send(`event: avatar.speak\ndata: ${JSON.stringify({ text: e.data.text })}\n\n`);
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
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
  });
}
