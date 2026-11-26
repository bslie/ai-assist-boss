import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db/client";
import { slugify } from "@/db/seed-leader";
import { jsonError, parseBody } from "@/lib/http";

/** Список профилей руководителей (для мастера и переключателя). Данные внутри профиля не отдаём. */
export async function GET() {
  const leaders = await db.leader.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, slug: true, name: true, role: true, email: true, profileVersion: true },
  });
  return NextResponse.json({ leaders });
}

const Create = z.object({ name: z.string().min(2).max(120), role: z.string().min(1).max(200), email: z.string().email() });

/** Мастер: создаёт пустого руководителя; цели и правила приходят через /api/leaders/import. */
export async function POST(req: Request) {
  const body = await parseBody(req, Create);
  if (!body.ok) return body.res;
  const slug = slugify(body.data.name);
  if (!slug) return jsonError(400, "Не удалось построить slug из имени");

  const clash = await db.leader.findFirst({ where: { OR: [{ slug }, { email: body.data.email }] }, select: { id: true } });
  if (clash) return jsonError(409, "Руководитель с таким именем или почтой уже есть");

  const leader = await db.leader.create({
    data: { slug, ...body.data, quarterGoals: [], stylePrompt: "", savedMinutesConfig: {}, profileMarkdown: "" },
    select: { id: true, slug: true, name: true },
  });
  return NextResponse.json(leader, { status: 201 });
}
