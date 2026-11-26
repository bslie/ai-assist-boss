import { existsSync, readFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { REPORT_PATH } from "@/core/eval/inbox";
import { requireUser } from "@/lib/http";

/** Последний отчёт прогона eval-inbox (SPEC 6). Создаётся тестом `tests/eval-inbox.test.ts`. Только после входа. */
export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;
  if (!existsSync(REPORT_PATH)) {
    return NextResponse.json({ error: "Отчёта ещё нет: запустите eval-inbox с живой LLM или из кэша" }, { status: 404 });
  }
  return NextResponse.json(JSON.parse(readFileSync(REPORT_PATH, "utf8")));
}
