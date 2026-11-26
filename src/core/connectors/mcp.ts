/**
 * Разведка удалённого MCP-сервера по Streamable HTTP: initialize → tools/list.
 * Только чтение: ни один инструмент сервера здесь не вызывается.
 */
import { z } from "zod";

export interface McpTool {
  name: string;
  description: string;
  /** По подсказке сервера (readOnlyHint). Нет подсказки → считаем записью: fail closed. */
  readOnly: boolean;
}

const ToolsResult = z.object({
  tools: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      annotations: z.object({ readOnlyHint: z.boolean().optional() }).passthrough().optional(),
    }),
  ),
});

/** Адреса, куда сервер не должен ходить по просьбе пользователя (локальная сеть, облачные метаданные). */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export type ProbeResult = { ok: true; tools: McpTool[] } | { ok: false; message: string };

export interface ProbeOptions {
  token?: string;
  /** Только для тестов: разрешить http и локальные адреса. */
  allowLocal?: boolean;
  timeoutMs?: number;
}

async function rpc(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number): Promise<{ res: Response; json: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error", // редирект мог бы увести запрос во внутреннюю сеть
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Сервер ответил ${res.status}`);
  if (!text.trim()) return { res, json: null };
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean);
    const last = data.at(-1);
    return { res, json: last ? JSON.parse(last) : null };
  }
  return { res, json: JSON.parse(text) };
}

export async function probeMcp(rawUrl: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, message: "Это не похоже на адрес. Нужен вид https://example.com/mcp" };
  }
  if (!opts.allowLocal) {
    if (url.protocol !== "https:") return { ok: false, message: "Принимаю только защищённые адреса (https)." };
    if (isPrivateHost(url.hostname)) return { ok: false, message: "Адреса из внутренней сети я не открываю." };
  }
  const timeout = opts.timeoutMs ?? 10_000;
  const auth: Record<string, string> = opts.token ? { authorization: `Bearer ${opts.token}` } : {};
  try {
    const init = await rpc(
      url.toString(),
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ai-assistant", version: "1.0" } } },
      auth,
      timeout,
    );
    const session = init.res.headers.get("mcp-session-id");
    const headers = { ...auth, ...(session ? { "mcp-session-id": session } : {}) };
    await rpc(url.toString(), { jsonrpc: "2.0", method: "notifications/initialized" }, headers, timeout).catch(() => null);
    const list = await rpc(url.toString(), { jsonrpc: "2.0", id: 2, method: "tools/list" }, headers, timeout);
    const result = (list.json as { result?: unknown; error?: { message?: string } } | null) ?? {};
    if (result.error) return { ok: false, message: `Сервер отказал: ${result.error.message ?? "ошибка"}` };
    const parsed = ToolsResult.safeParse(result.result);
    if (!parsed.success) return { ok: false, message: "Сервер ответил, но это не список инструментов MCP." };
    return {
      ok: true,
      tools: parsed.data.tools.map((t) => ({ name: t.name, description: t.description ?? "", readOnly: t.annotations?.readOnlyHint === true })),
    };
  } catch (e) {
    const msg = (e as Error).name === "TimeoutError" ? "Сервер не ответил за 10 секунд." : `Не удалось связаться с сервером: ${(e as Error).message}`;
    return { ok: false, message: msg };
  }
}
