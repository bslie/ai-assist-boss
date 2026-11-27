/**
 * Цикл агента чата: модель на каждом шаге либо просит выполнить инструмент чтения (`call`), либо отвечает.
 * Инструменты чтения выполняются сразу, их результат уходит модели на следующем шаге. Инструменты-действия
 * здесь не выполняются: цикл только отдаёт предложенные `actions`, а чат превращает их в карточки с кнопкой.
 * Все вызовы модели идут через LlmClient (кэш, журнал стоимости), аргументы инструментов проверяются zod.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { LlmClient } from "../llm";
import type { ReadTool, Tool, ToolCtx } from "./types";

const ToolCallSchema = z.object({
  tool: z.string().min(1).max(60),
  /** JSON-объект аргументов строкой: так надёжнее у любых провайдеров, чем открытая схема. */
  argsJson: z.string().max(2000),
});

export const StepSchema = z.object({
  /** Ответ руководителю. Пустой, если вызван инструмент или предложено действие: итог действия сообщит система. */
  answer: z.string().max(1500),
  /** Инструмент чтения, результат которого нужен для ответа. null — данных достаточно. */
  call: ToolCallSchema.nullish(),
  /** Действия: изменения и внешние шаги; выполняются только после подтверждения руководителя. */
  actions: z.array(ToolCallSchema).max(2),
});
export type Step = z.infer<typeof StepSchema>;

export interface AgentArgs {
  ctx: ToolCtx;
  /** Роль, правила и контекст; список инструментов добавляется сюда же. */
  system: string;
  dialog: string;
  tools: Tool[];
  maxSteps?: number;
}

export interface AgentOutcome {
  answer: string;
  actions: { tool: string; argsJson: string }[];
  /** Какие инструменты чтения вызывались (для тестов и журнала). */
  calls: { tool: string; args: unknown }[];
}

const OBS_LIMIT = 3000;

const compactSchema = (t: Tool): string => {
  const { $schema: _s, ...rest } = z.toJSONSchema(t.args) as Record<string, unknown>;
  return JSON.stringify(rest);
};

/** Описание инструментов для системного промпта: имя, вид, когда вызывать, схема аргументов. */
export function describeTools(tools: Tool[]): string {
  const part = (kind: Tool["kind"]) =>
    tools
      .filter((t) => t.kind === kind)
      .map((t) => `- ${t.name}: ${t.description} Аргументы: ${compactSchema(t)}`)
      .join("\n");
  return [
    "ИНСТРУМЕНТЫ ЧТЕНИЯ (поле call, выполняются сразу; за один шаг можно вызвать один):",
    part("read"),
    "",
    "ИНСТРУМЕНТЫ-ДЕЙСТВИЯ (поле actions, только когда руководитель явно просит; выполняются после его подтверждения):",
    part("write"),
    "",
    "argsJson — JSON-объект аргументов строкой, например {\"query\":\"договор\"}. Если аргументов нет — {}.",
  ].join("\n");
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export async function runAgent(llm: LlmClient, a: AgentArgs): Promise<AgentOutcome> {
  const maxSteps = a.maxSteps ?? 5;
  const byName = new Map(a.tools.map((t) => [t.name, t]));
  const system = `${a.system}\n\n${describeTools(a.tools)}`;
  const observations: string[] = [];
  const calls: AgentOutcome["calls"] = [];
  const seen = new Set<string>();

  for (let step = 0; step < maxSteps; step++) {
    const last = step === maxSteps - 1;
    const prompt = [
      a.dialog ? `Предыдущий разговор:\n${a.dialog}\n` : "",
      `Руководитель: ${a.ctx.text}`,
      observations.length ? `\nРЕЗУЛЬТАТЫ ИНСТРУМЕНТОВ (уже выполнены, опирайся на них):\n${observations.join("\n")}` : "",
      last ? "\nБольше инструменты вызывать нельзя: ответь по тому, что уже есть." : "",
    ]
      .filter(Boolean)
      .join("\n");
    const res = await llm.generateStructured({
      leaderId: a.ctx.leaderId,
      pipeline: "CHAT",
      schema: StepSchema,
      system,
      prompt,
      cacheKey: `chat\u0000${hash(`${system}\u0000${prompt}`)}`,
      temperature: 0.2,
    });
    if (!res.call || last) return { answer: res.answer, actions: res.actions, calls };

    observations.push(await observe(res.call, byName, a.ctx, seen, calls));
  }
  return { answer: "", actions: [], calls };
}

/** Выполняет вызов и возвращает строку-наблюдение; любая ошибка — тоже наблюдение, модель может поправиться. */
async function observe(call: { tool: string; argsJson: string }, byName: Map<string, Tool>, ctx: ToolCtx, seen: Set<string>, calls: AgentOutcome["calls"]): Promise<string> {
  const label = `[${call.tool} ${call.argsJson}]`;
  const tool = byName.get(call.tool);
  if (!tool) return `${label} → ошибка: такого инструмента нет. Доступные для чтения: ${[...byName.values()].filter((t) => t.kind === "read").map((t) => t.name).join(", ")}.`;
  if (tool.kind !== "read") return `${label} → ошибка: это действие, его указывают в actions, а не в call.`;
  const key = `${call.tool}\u0000${call.argsJson}`;
  if (seen.has(key)) return `${label} → этот вызов уже был, результат выше. Ответь по нему.`;
  seen.add(key);

  let raw: unknown;
  try {
    raw = JSON.parse(call.argsJson.trim() || "{}");
  } catch {
    return `${label} → ошибка: аргументы не JSON.`;
  }
  const parsed = tool.args.safeParse(raw);
  if (!parsed.success) return `${label} → ошибка аргументов: ${parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ")}.`;
  calls.push({ tool: call.tool, args: parsed.data });
  try {
    const out = JSON.stringify(await (tool as ReadTool).run(ctx, parsed.data));
    return `${label} → ${out.length > OBS_LIMIT ? `${out.slice(0, OBS_LIMIT)}… (обрезано)` : out}`;
  } catch (e) {
    return `${label} → ошибка выполнения: ${(e as Error).message}.`;
  }
}
