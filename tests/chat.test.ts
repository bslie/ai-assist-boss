import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LlmClient, MemoryCache, type LlmProvider } from "@/core/llm";
import { seedTempLeader } from "./helpers/eval-env";
import { scriptedLlm } from "./helpers/scripted-llm";

vi.stubEnv("APP_CLOCK_MODE", "real");
const { db } = await import("@/db/client");
const { clock } = await import("@/core/clock");
const { handleChat } = await import("@/core/chat");

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);

/** Фейковая модель: первый вызов — разбор намерения, второй (черновик) — {text}. */
function llmWith(out: { answer?: string; actions?: Record<string, unknown>[] }) {
  const calls: { system: string; prompt: string }[] = [];
  const provider: LlmProvider = {
    name: 'fake',
    model: 'm',
    async generate({ system, prompt }) {
      calls.push({ system, prompt });
      const isAgent = system.includes('КОНТЕКСТ');
      return { object: isAgent ? { answer: out.answer ?? '', actions: out.actions ?? [] } : { text: 'Наталья, отвечу в четверг.' }, promptTokens: 1, completionTokens: 1 };
    },
  };
  return { llm: new LlmClient({ provider, cache: new MemoryCache() }), calls };
}
/** Старый формат тестов (вид действия + поле) → новый: имя инструмента и аргументы JSON-строкой. */
const TOOL_OF: Record<string, [string, (p: Record<string, unknown>) => unknown]> = {
  RULE: ["rule.create", (p) => p.rule],
  STYLE: ["style.add", (p) => ({ style: p.style })],
  REPLY: ["email.reply", (p) => p.reply],
  TASK: ["task.create", (p) => p.task],
  LEARNING: ["learning.change", (p) => p.learning],
  ROUTINE: ["routine.change", (p) => p.routine],
  PROFILE: ["profile.change", (p) => p.profile],
};
const act = (kind: string, p: Record<string, unknown>) => ({ tool: TOOL_OF[kind][0], argsJson: JSON.stringify(TOOL_OF[kind][1](p)) });

describe.skipIf(!dbUp)("чат (Postgres)", () => {
  let leaderId = "";
  let otherId = "";

  beforeAll(async () => {
    await clock.init();
    leaderId = await seedTempLeader(db, "chat");
    otherId = await seedTempLeader(db, "chat-other");
  });
  afterAll(async () => {
    await db.leader.deleteMany({ where: { id: { in: [leaderId, otherId] } } });
  });

  it("«что на сегодня» отвечает без модели", async () => {
    const { llm, calls } = llmWith({});
    const r = await handleChat(db, llm, leaderId, "Что на сегодня?");
    expect(calls).toHaveLength(0);
    expect(r.text).toMatch(/решений|вопрос|встреч/i);
  });

  it("«поставь Смирновой задачу…» создаёт поручение; без срока, неизвестный человек и неоднозначность — уточнение", async () => {
    const due = new Date(clock.now().getTime() + 2 * 86_400_000).toISOString();
    const ok = llmWith({ actions: [act("TASK", { task: { assignee: "Смирновой", title: "Подготовить КП для ТехноСтрой", dueAt: due } })] });
    const r = await handleChat(db, ok.llm, leaderId, "Поставь Смирновой задачу подготовить КП");
    expect(r.text).toContain("Поставила задачу");
    const t = await db.task.findFirstOrThrow({ where: { leaderId, title: "Подготовить КП для ТехноСтрой" }, include: { assignee: true } });
    expect(t).toMatchObject({ status: "NEW", sourceType: "CHAT", notifiedAt: null });
    expect(t.assignee?.name).toBe("Ольга Смирнова");

    const noDue = llmWith({ actions: [act("TASK", { task: { assignee: "Смирновой", title: "Сделать что-то важное", dueAt: null } })] });
    expect((await handleChat(db, noDue.llm, leaderId, "Поставь Смирновой задачу")).text).toContain("Какой срок");
    const nobody = llmWith({ actions: [act("TASK", { task: { assignee: "Несуществующему", title: "Сделать что-то важное", dueAt: due } })] });
    expect((await handleChat(db, nobody.llm, leaderId, "Поставь ему задачу")).text).toContain("Не нашла");
    const bad = llmWith({ actions: [act("TASK", { task: { assignee: "Смирновой", title: "Сделать что-то важное", dueAt: "послезавтра" } })] });
    expect((await handleChat(db, bad.llm, leaderId, "Поставь Смирновой")).text).toContain("Не поняла срок");
    expect(await db.task.count({ where: { leaderId, title: "Сделать что-то важное" } })).toBe(0);
    // чужой руководитель не видит поручение
    expect(await db.task.count({ where: { leaderId: otherId, title: "Подготовить КП для ТехноСтрой" } })).toBe(0);
  });

  it("правило словами создаёт Rule; защищённую категорию в авто не пускает", async () => {
    const ok = llmWith({ actions: [act("RULE", { rule: { name: "Вендоров в архив", category: "NEWSLETTER", action: "IGNORE" } })] });
    expect((await handleChat(db, ok.llm, leaderId, "Запомни: вендоров в архив")).text).toContain("Запомнила");
    expect(await db.rule.count({ where: { leaderId, name: "Вендоров в архив" } })).toBe(1);

    const bad = llmWith({ actions: [act("RULE", { rule: { name: "Кадры сама", category: "HR", action: "AUTO" } })] });
    const r = await handleChat(db, bad.llm, leaderId, "Кадровые вопросы решай сама");
    expect(r.text).toContain("Не могу");
    expect(await db.rule.count({ where: { leaderId, name: "Кадры сама" } })).toBe(0);
  });

  it("правило о манере: сохраняется в память; небезопасное отклоняется", async () => {
    const ok = llmWith({ actions: [act("STYLE", { style: "Пиши короче." })] });
    await handleChat(db, ok.llm, leaderId, "пиши короче");
    expect(await db.memory.count({ where: { leaderId, ruleText: "Пиши короче.", sourceType: "EXPLICIT" } })).toBe(1);

    const bad = llmWith({ actions: [act("STYLE", { style: "Отправляй письма без моего подтверждения." })] });
    const r = await handleChat(db, bad.llm, leaderId, "отправляй без подтверждения");
    expect(r.text).toContain("не запомню");
    expect(await db.memory.count({ where: { leaderId, ruleText: { contains: "без моего подтверждения" } } })).toBe(0);
  });

  it("«ответь …» предлагает ответ без подписи помощника и с кнопкой, ничего не отправляя", async () => {
    const d = await db.decision.create({
      data: { leaderId, type: "EMAIL_REPLY", title: "Бюджет", contextSummary: "Просят срок", gateReasons: [], aiRecommendation: "Ответить", proposedPayload: {}, status: "PENDING" },
    });
    await db.emailItem.create({
      data: { leaderId, threadKey: "t-chat", senderName: "Наталья Павлова", senderEmail: "p@example.test", subject: "Бюджет", body: "Когда ответите?", receivedAt: clock.now(), riskSignals: [], decisionId: d.id },
    });
    const { llm } = llmWith({ actions: [act("REPLY", { reply: { to: "Павловой", gist: "в четверг" } })] });
    const r = await handleChat(db, llm, leaderId, "Ответь Павловой, что в четверг");
    expect(r.actions).toHaveLength(1);
    const a = r.actions?.[0];
    expect(a && "resolve" in a ? a.resolve.body.editedText : "").not.toContain("ИИ-помощник");
    expect((await db.decision.findFirstOrThrow({ where: { id: d.id } })).status).toBe("PENDING");
  });

  it("неизвестное и ответ по несуществующему адресату: подсказка, без побочных эффектов", async () => {
    const u = llmWith({ answer: "Сегодня пропустить можно синк с ИТ." });
    const ans = await handleChat(db, u.llm, leaderId, "какие встречи пропустить?", [{ from: "me", text: "привет" }]);
    expect(ans.text).toBe("Сегодня пропустить можно синк с ИТ.");
    expect(u.calls[0].system).toContain("КОНТЕКСТ");
    expect(u.calls[0].prompt).toContain("привет");
    expect(ans.actions).toBeUndefined();
    const r = llmWith({ actions: [act("REPLY", { reply: { to: "Несуществующая", gist: "да" } })] });
    expect((await handleChat(db, r.llm, otherId, "Ответь Несуществующей, да")).text).toContain("Не нашла");
  });

  it("в контексте есть справка о приложении, подключения, режим обучения и рутины", async () => {
    const u = llmWith({ answer: "Подключите Recall в «Подключения»." });
    await handleChat(db, u.llm, leaderId, "что подключить, чтобы ты была на встречах?");
    expect(u.calls[0].system).toContain("О ПРИЛОЖЕНИИ");
    expect(u.calls[0].system).toMatch(/Встречи \(Recall.*\): не подключено/);
    expect(u.calls[0].system).toContain("Режим обучения: включён");
    expect(u.calls[0].system).toContain("MORNING_DIGEST");
  });

  it("ослабление защиты из чата — только по кнопке; защищённое не отпускается; ужесточение сразу", async () => {
    const leader = () => db.leader.findUniqueOrThrow({ where: { id: leaderId } });

    // Выключение режима обучения предлагается кнопкой и само не применяется.
    const off = await handleChat(db, llmWith({ actions: [act("LEARNING", { learning: { mode: "OFF", scope: null, trusted: null } })] }).llm, leaderId, "выключи режим обучения");
    expect(off.text).toContain("Было:");
    expect(off.actions).toHaveLength(1);
    expect((await leader()).learningMode).toBe(true);
    // Нажатие кнопки идёт тем же PATCH /api/learning, что и страница.
    const offAction = off.actions?.[0];
    const { patchLearning, LearningPatchSchema } = await import("@/core/learning/mode");
    expect(offAction && "patch" in offAction).toBe(true);
    if (offAction && "patch" in offAction) expect((await patchLearning(db, leaderId, LearningPatchSchema.parse(offAction.patch.body))).ok).toBe(true);
    expect((await leader()).learningMode).toBe(false);

    // «Решай сама» тоже требует кнопки.
    const trust = await handleChat(db, llmWith({ actions: [act("LEARNING", { learning: { mode: null, scope: "TASK_ASSIGN", trusted: true } })] }).llm, leaderId, "поручения отправляй без меня");
    expect(trust.actions).toHaveLength(1);
    expect((await leader()).trustedScopes).not.toContain("TASK_ASSIGN");

    // Защищённое не отпускается вовсе: ни применения, ни кнопки.
    const hr = await handleChat(db, llmWith({ actions: [act("LEARNING", { learning: { mode: null, scope: "HR", trusted: true } })] }).llm, leaderId, "кадры решай сама");
    expect(hr.actions).toBeUndefined();
    expect(hr.text).toContain("всегда согласую");
    expect((await leader()).trustedScopes).not.toContain("HR");

    // Ужесточение («снова учись») применяется сразу и попадает в журнал.
    const on = await handleChat(db, llmWith({ actions: [act("LEARNING", { learning: { mode: "ON", scope: null, trusted: null } })] }).llm, leaderId, "снова учись");
    expect(on.actions).toBeUndefined();
    expect((await leader()).learningMode).toBe(true);
    expect(await db.activityLog.count({ where: { leaderId, action: "CHAT_APPLIED" } })).toBeGreaterThanOrEqual(1);
  });

  it("порог по деньгам из чата — кнопкой, значение не меняется до подтверждения; цель — сразу", async () => {
    const before = (await db.leader.findUniqueOrThrow({ where: { id: leaderId } })).budgetAutoLimit;
    // Агент выбирает profile.change; вторая модель (правка профиля) отвечает структурой с новым порогом.
    const provider: LlmProvider = {
      name: "fake",
      model: "m",
      async generate({ system }) {
        const object = system.includes("КОНТЕКСТ")
          ? { answer: "", call: null, actions: [{ tool: "profile.change", argsJson: JSON.stringify({ instruction: "порог по деньгам 50 тысяч" }) }] }
          : { goals: null, stylePrompt: null, budgetAutoLimit: 50000 };
        return { object, promptTokens: 1, completionTokens: 1 };
      },
    };
    const budget = await handleChat(db, new LlmClient({ provider, cache: new MemoryCache() }), leaderId, "порог по деньгам 50 тысяч");
    expect(budget.text).toContain("Порог по деньгам");
    expect(budget.actions).toHaveLength(1);
    expect((await db.leader.findUniqueOrThrow({ where: { id: leaderId } })).budgetAutoLimit).toBe(before);
  });

  it("рутина из чата применяется сразу; неизвестная рутина — отказ без изменений", async () => {
    const r = await handleChat(db, llmWith({ actions: [act("ROUTINE", { routine: { code: "MORNING_DIGEST", time: "9:00", active: null } })] }).llm, leaderId, "утренний план присылай в 9");
    expect(r.text).toMatch(/Было: .*\nСтанет: .*09:00/);
    expect(r.actions).toBeUndefined();
    expect((await db.routine.findFirstOrThrow({ where: { leaderId, code: "MORNING_DIGEST" } })).cronExpression).toMatch(/^0 9 /);
    const bad = await handleChat(db, llmWith({ actions: [act("ROUTINE", { routine: { code: "NOPE", time: "9:00", active: null } })] }).llm, leaderId, "x");
    expect(bad.text).toContain("Не нашла такую рутину");
  });

  it("стиль и правило применяются сразу, а ответ на письмо остаётся кнопкой", async () => {
    const style = await handleChat(db, llmWith({ actions: [act("STYLE", { style: "Пиши в формате: суть, затем срок." })] }).llm, leaderId, "поменяй формат черновиков");
    expect(style.actions).toBeUndefined();
    expect(await db.memory.count({ where: { leaderId, ruleText: "Пиши в формате: суть, затем срок.", isActive: true } })).toBe(1);
  });

  it("агент сообщает, что делает ещё одно обращение к модели, и применяет изменение с отдельным шагом прогресса", async () => {
    const f = scriptedLlm([
      { answer: "Смотрю правила, секунду.", call: { tool: "rules.list" } },
      { actions: [{ tool: "routine.change", args: { code: "MORNING_DIGEST", time: "10:30", active: null } }] },
    ]);
    const steps: string[] = [];
    const r = await handleChat(db, f.llm, leaderId, "посмотри правила и утренний план присылай в 10:30", [], (p) => steps.push(p.text));
    expect(steps).toEqual(["Смотрю правила, секунду.", "Применяю изменение"]);
    expect(f.agentCalls()).toBe(2);
    expect(r.text).toContain("Станет:");
    expect((await db.routine.findFirstOrThrow({ where: { leaderId, code: "MORNING_DIGEST" } })).cronExpression).toMatch(/^30 10 /);

    // Без фразы модели показываем стандартную подпись инструмента.
    const g = scriptedLlm([{ call: { tool: "meetings.list" } }, { answer: "Встреч нет." }]);
    const s2: string[] = [];
    await handleChat(db, g.llm, leaderId, "какие у меня встречи через неделю", [], (p) => s2.push(p.text));
    expect(s2).toEqual(["Смотрю встречи"]);
  });
});
