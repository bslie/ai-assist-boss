import { NextResponse } from "next/server";
import { costReportCsv, getCostReport } from "@/core/usage";
import { db } from "@/db/client";
import { requireLeaderId } from "@/lib/http";

/** `GET /api/usage?leaderId=&format=json|csv` — стоимость запросов по конвейерам из UsageLog (SPEC 7.4, инвариант 8). */
export async function GET(req: Request) {
  const auth = await requireLeaderId(req);
  if (!auth.ok) return auth.res;
  const report = await getCostReport(db, auth.leaderId);
  if (new URL(req.url).searchParams.get("format") === "csv") {
    return new NextResponse(costReportCsv(report), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="usage-cost.csv"' },
    });
  }
  return NextResponse.json(report);
}
