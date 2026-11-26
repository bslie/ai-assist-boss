import type { PrismaClient } from "@/generated/prisma/client";
import { clock } from "../clock";
import type { UsageSink } from "./index";

/** Каждый вызов LLM — строка UsageLog (SPEC инвариант 8: расчёт стоимости запроса). Время — демо-часы. */
export function dbUsageSink(db: PrismaClient): UsageSink {
  return {
    async record(u) {
      await db.usageLog.create({
        data: {
          leaderId: u.leaderId,
          createdAt: clock.now(),
          pipeline: u.pipeline,
          provider: u.provider,
          model: u.model,
          promptTokens: u.promptTokens,
          completionTokens: u.completionTokens,
          cached: u.cached,
          costRub: u.costRub,
        },
      });
    },
  };
}
