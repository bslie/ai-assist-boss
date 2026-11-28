/**
 * Исполнение действий чата на сервере. Руководитель сам попросил изменение в чате, поэтому оно применяется сразу,
 * без второй кнопки. Применяем теми же функциями ядра, что и API страниц: все проверки остаются теми же
 * (защищённое не отпускается, небезопасные правила не запоминаются, встреча проходит Policy Gate в joinByLink).
 * Исключение — ответ на письмо (`resolve`): он уходит третьему лицу, и руководитель подтверждает текст кнопкой.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { publishEvent } from "./events";
import { clock } from "./clock";
import { LearningPatchSchema, patchLearning } from "./learning/mode";
import { joinByLink } from "./meetings/recall";
import { ProfilePatchSchema, applyProfilePatch } from "./profile/patch";
import { PatchRoutineSchema, patchRoutine } from "./routines";
import type { ChatAction } from "./chat";

export type ApplyResult = { ok: true; done: string } | { ok: false; message: string };

type ApplicableAction = Exclude<ChatAction, { resolve: unknown }>;

/**
 * Изменения, которые ослабляют защиту, руководитель подтверждает кнопкой даже в чате (SPEC 1.1: «изменение лимита всегда
 * с подтверждением»): порог по деньгам, выключение режима обучения, «решай сама». Письмо или текст в почте не должны
 * через агента молча снять защиту. Ужесточения (включить обучение, «верни мне», сменить цель) применяются сразу.
 */
export function needsConfirmation(a: ApplicableAction): boolean {
  if (!("patch" in a)) return false;
  const body = a.patch.body as Record<string, unknown>;
  if (a.patch.path === "/api/profile") return body.budgetAutoLimit !== undefined;
  if (a.patch.path === "/api/learning") return (body.kind === "mode" && body.enabled === false) || (body.kind === "trust" && body.trusted === true);
  return false;
}

export const isApplicable = (a: ChatAction): a is ApplicableAction => !("resolve" in a) && !needsConfirmation(a);

export async function applyAction(db: PrismaClient, leaderId: string, a: ApplicableAction): Promise<ApplyResult> {
  const result = await run(db, leaderId, a);
  await db.activityLog.create({
    data: {
      leaderId,
      createdAt: clock.now(),
      pipeline: "CHAT",
      action: result.ok ? "CHAT_APPLIED" : "CHAT_APPLY_FAILED",
      reason: result.ok ? `По просьбе в чате: ${result.done}` : `Просьба из чата не выполнена: ${result.message}`,
      metadata: { target: "post" in a ? a.post.path : a.patch.path },
    },
  });
  return result;
}

async function run(db: PrismaClient, leaderId: string, a: ApplicableAction): Promise<ApplyResult> {
  if ("post" in a) {
    const body = a.post.body;
    if (!body.url) return { ok: false, message: "нет ссылки на встречу" };
    const res = await joinByLink(db, leaderId, { url: body.url, ...(body.meetingId ? { meetingId: body.meetingId } : {}) });
    if (res.status === "launched") return { ok: true, done: a.done };
    return { ok: false, message: res.reason };
  }

  switch (a.patch.path) {
    case "/api/learning": {
      const body = LearningPatchSchema.safeParse(a.patch.body);
      if (!body.success) return { ok: false, message: "не разобрала изменение режима обучения" };
      const res = await patchLearning(db, leaderId, body.data);
      return res.ok ? { ok: true, done: a.done } : { ok: false, message: res.message };
    }
    case "/api/routines": {
      const body = PatchRoutineSchema.safeParse(a.patch.body);
      if (!body.success) return { ok: false, message: "не разобрала изменение рутины" };
      const res = await patchRoutine(db, leaderId, body.data);
      return res.ok ? { ok: true, done: a.done } : { ok: false, message: res.message };
    }
    case "/api/profile": {
      const body = ProfilePatchSchema.safeParse(a.patch.body);
      if (!body.success) return { ok: false, message: "не разобрала правку профиля" };
      await applyProfilePatch(db, leaderId, body.data);
      await publishEvent(leaderId, { type: "metrics.updated", data: {} });
      return { ok: true, done: a.done };
    }
  }
}
