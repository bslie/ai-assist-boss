import { NextResponse } from "next/server";
import { getCurrentUser } from "@/core/auth/current-user";

/** `GET /api/auth/me` → текущий пользователь или 401. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Не выполнен вход" }, { status: 401 });
  return NextResponse.json({ user });
}
