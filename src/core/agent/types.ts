/**
 * Реестр инструментов агента чата. Чтобы дать помощнику новую возможность, достаточно описать инструмент здесь:
 * имя, описание для модели, схему аргументов (zod) и обработчик. Править чат и промпт не нужно.
 *
 * - `read` — только чтение данных руководителя: выполняется сразу, результат уходит модели на следующем шаге.
 * - `write` — изменение или внешнее действие: выполняется только как предложение (кнопка подтверждения) либо
 *   через Policy Gate. Агент сам ничего не отправляет и не меняет.
 */
import type { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import type { LlmClient } from "../llm";

export interface ToolCtx {
  db: PrismaClient;
  llm: LlmClient;
  leaderId: string;
  /** Исходная реплика руководителя. */
  text: string;
}

interface Base<A extends z.ZodType> {
  /** Точечное имя: `группа.действие`. Стабильно: на него ссылаются кэш и журнал. */
  name: string;
  /** Одна-две фразы для модели: когда вызывать и что вернёт. */
  description: string;
  args: A;
}

export interface ReadTool<A extends z.ZodType = z.ZodType> extends Base<A> {
  kind: "read";
  /** Результат — любой JSON-совместимый объект; длинное обрезается циклом. */
  run(ctx: ToolCtx, args: z.infer<A>): Promise<unknown>;
}

/** Ответ чата: то, что видит руководитель. Определён здесь, чтобы инструменты не зависели от chat.ts. */
export type ToolReply = {
  text: string;
  draft?: string;
  actions?: unknown[];
};

export interface WriteTool<A extends z.ZodType = z.ZodType> extends Base<A> {
  kind: "write";
  propose(ctx: ToolCtx, args: z.infer<A>): Promise<ToolReply>;
}

export type Tool = ReadTool | WriteTool;
