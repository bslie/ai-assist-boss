import { LlmClient, MemoryCache, type LlmProvider } from "@/core/llm";

export interface ScriptedStep {
  answer?: string;
  call?: { tool: string; args?: unknown };
  actions?: { tool: string; args?: unknown }[];
}

/**
 * Модель по сценарию: n-й вызов агента возвращает n-й шаг (после конца сценария — последний).
 * Вызовы без «КОНТЕКСТ» в промпте (черновики писем и т. п.) получают текст-заглушку.
 */
export function scriptedLlm(steps: ScriptedStep[]) {
  const calls: { system: string; prompt: string }[] = [];
  let agentCalls = 0;
  const provider: LlmProvider = {
    name: "scripted",
    model: "m",
    async generate({ system, prompt }) {
      calls.push({ system, prompt });
      if (!system.includes("КОНТЕКСТ")) return { object: { text: "Наталья, отвечу в четверг." }, promptTokens: 1, completionTokens: 1 };
      const s = steps[Math.min(agentCalls++, steps.length - 1)] ?? {};
      return {
        object: {
          answer: s.answer ?? "",
          call: s.call ? { tool: s.call.tool, argsJson: JSON.stringify(s.call.args ?? {}) } : null,
          actions: (s.actions ?? []).map((a) => ({ tool: a.tool, argsJson: JSON.stringify(a.args ?? {}) })),
        },
        promptTokens: 1,
        completionTokens: 1,
      };
    },
  };
  return { llm: new LlmClient({ provider, cache: new MemoryCache() }), calls, agentCalls: () => agentCalls };
}
