import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryState, type Button, type Messenger } from "@/core/telegram/types";
import { seedTempLeader } from "./helpers/eval-env";

vi.stubEnv("APP_CLOCK_MODE", "real");
const { db } = await import("@/db/client");
const { clock } = await import("@/core/clock");
const { humanizeReasons } = await import("@/core/reasons");
const { isSafeRule } = await import("@/core/learning/extract");
const { excerpt } = await import("@/core/learning/propose");
const { handleStart, leaderBindSecret } = await import("@/core/telegram/bindings");
const { sendDecisionCard } = await import("@/core/telegram/cards");
const { handleCallback, handleText } = await import("@/core/telegram/handlers");
const { processRoutineJob, resurfaceSnoozed } = await import("@/core/telegram/morning");
const { buildDecisionCards } = await import("@/core/dashboard");
const { listLearned, forgetMemory } = await import("@/core/memory");

const dbUp = await db.$queryRaw`select 1`.then(() => true, () => false);
const KEY = "test-bind-key";

describe("humanizeReasons: руководитель не видит кодов", () => {
  it("коды сигналов превращаются в человеческие фразы, повторы схлопываются", () => {
    const out = humanizeReasons(["Жёсткие сигналы: EXTERNAL_INVITATION, HR_TERMS", "Жёсткие сигналы риска: HR_TERMS"]);
    expect(out).toEqual(["Внешнее приглашение выступить или участвовать", "Речь о кадровом вопросе: отпуск, найм, увольнение или зарплата"]);
  });

  it("категории, уверенность, деньги, инструменты", () => {
    expect(humanizeReasons(["Защищённая категория HR"])).toEqual(["Кадровые вопросы я без вас не решаю"]);
    expect(humanizeReasons(["Защищённая категория CLIENT_COMMITMENT"])[0]).toContain("Обещания клиентам");
    expect(humanizeReasons(["Уверенность ниже порога"])[0]).toContain("не уверена");
    expect(humanizeReasons(["Уверенность классификатора ниже порога"])[0]).toContain("не уверена");
    expect(humanizeReasons(["Сумма 480000 ₽ выше порога автоответа 0 ₽"])[0]).toBe("Сумма 480000 ₽ выше вашего порога автоответа (0 ₽)");
    expect(humanizeReasons(["Инструмент telegram.assign_task требует подтверждения"])[0]).toContain("идёт через вас");
    expect(humanizeReasons(["Инструмент telegram.assign_task запрещён"])[0]).toBe("Вы запретили это действие");
  });

  it("неизвестная причина проходит как есть, ничего не теряется", () => {
    expect(humanizeReasons(["Что-то новое"])).toEqual(["Что-то новое"]);
    expect(humanizeReasons([])).toEqual([]);
  });

  it("ни одна известная причина шлюза не оставляет в тексте слов-кодов", () => {
    const raw = [
      "Жёсткие сигналы: MANAGER_PARTY, HR_PARTY, FINANCE_PARTY, HR_TERMS, COMMITMENT_TERMS, MONEY_APPROVAL, EXTERNAL_INVITATION, MONEY_TERMS",
      "Защищённая категория MANAGEMENT",
      "Категория не определена",
      "Деньги в исходящем действии",
      "Затронут защищённый блок календаря",
      "Режим тени",
    ];
    for (const h of humanizeReasons(raw)) expect(h).not.toMatch(/[A-Z]{3,}_[A-Z]+|[A-Z]{4,}/);
  });
});

describe("правила про подпись и представление помощника не предлагаются", () => {
  it.each(["Пиши без подписи.", "Не подписывай письма.", "Не представляйся помощником.", "Не говори, что ты ИИ-помощник."])("отклоняет: %s", (r) =>
    expect(isSafeRule(r)).toBe(false),
  );
  it("обычное правило про манеру проходит", () => expect(isSafeRule("Подписывайся полным именем помощника.")).toBe(true));
});

describe("excerpt", () => {
  it("схлопывает пробелы и обрезает длинное с многоточием", () => {
    expect(excerpt("Привет,\n  мир")).toBe("Привет, мир");
    const long = excerpt("а".repeat(200), 20);
    expect(long).toBe(`${"а".repeat(20)}…`);
  });
});

function fakeMessenger() {
  const sent: { chatId: string; text: string; buttons?: Button[][] }[] = [];
  const edits: { text: string }[] = [];
  const m: Messenger = {
    async send(chatId, text, buttons) {
      sent.push({ chatId, text, buttons });
      return { messageId: String(sent.length) };
    },
    async edit(_c, _i, text) {
      edits.push({ text });
    },
  };
  return { m, sent, edits };
}

describe.skipIf(!dbUp)("UX бота и экрана (Postgres)", () => {
  let leaderId = "";
  let otherId = "";
  let slug = "";
  let otherSlug = "";
  const chat = (s: string) => `${s}-${leaderId.slice(-6)}`;
  const bind = (c: string, s = slug) => handleStart(db, c, `${s}_${leaderBindSecret(s, KEY)}`, KEY);

  const newDecision = (lid = leaderId, over: Record<string, unknown> = {}) =>
    db.decision.create({
      data: {
        leaderId: lid,
        type: "EMAIL_REPLY",
        title: "Тема",
        contextSummary: "Суть",
        gateReasons: ["Жёсткие сигналы: EXTERNAL_INVITATION"],
        aiRecommendation: "Спросить",
        proposedPayload: {},
        draftText: "Черновик ответа",
        ...over,
      },
    });

  beforeAll(async () => {
    await clock.init();
    leaderId = await seedTempLeader(db, "ux");
    otherId = await seedTempLeader(db, "ux-other");
    slug = (await db.leader.findUniqueOrThrow({ where: { id: leaderId } })).slug;
    otherSlug = (await db.leader.findUniqueOrThrow({ where: { id: otherId } })).slug;
  }, 60_000);

  afterAll(async () => {
    await db.leader.deleteMany({ where: { id: { in: [leaderId, otherId].filter(Boolean) } } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    await db.telegramBinding.deleteMany({ where: { leaderId: { in: [leaderId, otherId] } } });
    await db.decision.deleteMany({ where: { leaderId: { in: [leaderId, otherId] } } });
    await db.memory.deleteMany({ where: { leaderId: { in: [leaderId, otherId] } } });
    await db.activityLog.deleteMany({ where: { leaderId } });
  });

  it("карточка (веб и Telegram) показывает человеческие причины, в БД остаётся исходная формулировка", async () => {
    await bind(chat("L"));
    const d = await newDecision();
    const [card] = await buildDecisionCards(db, leaderId, [d]);
    expect(card.reasons).toEqual(["Внешнее приглашение выступить или участвовать"]);
    expect((await db.decision.findUniqueOrThrow({ where: { id: d.id } })).gateReasons).toEqual(["Жёсткие сигналы: EXTERNAL_INVITATION"]);

    const { m, sent } = fakeMessenger();
    await sendDecisionCard(db, m, leaderId, d.id);
    expect(sent[0].text).toContain("Внешнее приглашение выступить или участвовать");
    expect(sent[0].text).not.toContain("EXTERNAL_INVITATION");
    // У карточки без письма-источника нет отправителя и времени: заголовок без висящей точки.
    const header = sent[0].text.split("\n")[0];
    expect(header).toBe("<b>Решение</b>");
    expect(header.trimEnd().endsWith("·")).toBe(false);
  });

  describe("правка ответом на карточку", () => {
    async function card(learns = false) {
      await bind(chat("L"));
      const d = await newDecision();
      const { m, sent, edits } = fakeMessenger();
      await sendDecisionCard(db, m, leaderId, d.id);
      return { d, sent, deps: { db, messenger: m, state: new MemoryState(), learns }, edits };
    }

    it("reply на карточку = правка, кнопка «Поправить» не нужна", async () => {
      const { d, deps } = await card();
      const reply = await handleText(deps, chat("L"), "Мой текст", { replyToMessageId: "1" });
      expect(reply).toContain("Принято, использую ваш вариант");
      expect(reply).not.toContain("Посмотрю");
      expect(await db.decision.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: "EDITED_APPROVED", editedText: "Мой текст" });
    });

    it("если воркер анализирует правки, пользователя предупреждают, что скажут о правиле", async () => {
      const { deps } = await card(true);
      expect(await handleText(deps, chat("L"), "Мой текст", { replyToMessageId: "1" })).toContain("Посмотрю, нет ли в правке правила");
    });

    it("reply на постороннее сообщение карточкой не считается", async () => {
      const { d, deps } = await card();
      expect(await handleText(deps, chat("L"), "что-то", { replyToMessageId: "999" })).toContain("кнопками");
      expect((await db.decision.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("PENDING");
    });

    it("reply из чужого чата карточку не правит", async () => {
      const { d, deps } = await card();
      await bind(chat("Z"), otherSlug);
      // у чужого чата своё сообщение с тем же номером: ссылка на карточку строится по chatId
      const out = await handleText(deps, chat("Z"), "Чужая правка", { replyToMessageId: "1" });
      expect(out).not.toContain("Принято");
      expect((await db.decision.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("PENDING");
    });

    it("«Поправить» присылает черновик для копирования; повторный reply на уже решённую карточку не меняет её", async () => {
      const { d, deps } = await card();
      await handleText(deps, chat("L"), "Первая правка", { replyToMessageId: "1" });
      const again = await handleText(deps, chat("L"), "Вторая правка", { replyToMessageId: "1" });
      expect(again).toContain("кнопками");
      expect((await db.decision.findUniqueOrThrow({ where: { id: d.id } })).editedText).toBe("Первая правка");
    });
  });

  describe("«Не сейчас» возвращается в утреннем плане", () => {
    it("кнопка отвечает понятно и помечает карточку отложенной", async () => {
      await bind(chat("L"));
      const d = await newDecision();
      const { m, sent, edits } = fakeMessenger();
      await sendDecisionCard(db, m, leaderId, d.id);
      const toast = await handleCallback({ db, messenger: m, state: new MemoryState() }, { chatId: chat("L"), messageId: sent[0].chatId ? "1" : "1", data: `d:s:${d.id}` });
      expect(toast).toBe("Верну в утреннем плане");
      expect(edits.at(-1)?.text).toContain("верну в утреннем плане");
      expect((await db.decision.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("SNOOZED");
    });

    it("resurfaceSnoozed: только свои, снова PENDING, ссылка на старое сообщение сброшена, есть след в журнале", async () => {
      const mine = await newDecision(leaderId, { status: "SNOOZED", telegramMessageId: "x:1", resolvedAt: new Date() });
      const foreign = await newDecision(otherId, { status: "SNOOZED" });
      expect(await resurfaceSnoozed(db, leaderId)).toEqual([mine.id]);
      const row = await db.decision.findUniqueOrThrow({ where: { id: mine.id } });
      expect(row).toMatchObject({ status: "PENDING", telegramMessageId: null, resolvedAt: null });
      expect((await db.decision.findUniqueOrThrow({ where: { id: foreign.id } })).status).toBe("SNOOZED");
      expect(await db.activityLog.count({ where: { leaderId, action: "DECISION_RESURFACED" } })).toBe(1);
      expect(await resurfaceSnoozed(db, leaderId)).toEqual([]);
    });

    it("утренний план упоминает вернувшееся и присылает карточку заново; без чата отложенное всё равно возвращается", async () => {
      const job = { routineId: "r", leaderId, code: "MORNING_DIGEST", firedAt: new Date().toISOString() };
      const d = await newDecision(leaderId, { status: "SNOOZED", telegramMessageId: "old:1" });

      const { m: m0, sent: s0 } = fakeMessenger();
      await processRoutineJob({ db, messenger: m0 }, { ...job });
      expect(s0).toHaveLength(0); // чата нет
      expect((await db.decision.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("PENDING"); // но в вебе карточка вернулась

      await db.decision.update({ where: { id: d.id }, data: { status: "SNOOZED", telegramMessageId: "old:1" } });
      await bind(chat("L"));
      const { m, sent } = fakeMessenger();
      expect(await processRoutineJob({ db, messenger: m }, job)).toEqual({ sent: 1 });
      expect(sent[0].text).toContain("Вернула отложенные по вашей просьбе: 1.");
      expect(sent[1].buttons?.flat().map((b) => b.data)).toContain(`d:a:${d.id}`); // карточка пришла заново с кнопками
    });
  });

  describe("«Чему я научилась»: список и «Забыть»", () => {
    it("видны только активные правила руководителя; предложения и чужие не показываются", async () => {
      await db.memory.createMany({
        data: [
          { leaderId, sourceType: "EDIT_LEARNING", ruleText: "Активное.", isActive: true },
          { leaderId, sourceType: "EDIT_LEARNING", ruleText: "Предложение.", isActive: false },
          { leaderId: otherId, sourceType: "EDIT_LEARNING", ruleText: "Чужое.", isActive: true },
        ],
      });
      expect((await listLearned(db, leaderId)).map((r) => r.ruleText)).toEqual(["Активное."]);
    });

    it("«Забыть» удаляет своё активное правило; чужое, ожидающее ответа и несуществующее — нет", async () => {
      const mine = await db.memory.create({ data: { leaderId, sourceType: "EDIT_LEARNING", ruleText: "Моё.", isActive: true } });
      const pending = await db.memory.create({ data: { leaderId, sourceType: "EDIT_LEARNING", ruleText: "Ждёт.", isActive: false } });
      const foreign = await db.memory.create({ data: { leaderId: otherId, sourceType: "EDIT_LEARNING", ruleText: "Чужое.", isActive: true } });

      expect(await forgetMemory(db, otherId, mine.id)).toBe(false); // чужой leaderId
      expect(await forgetMemory(db, leaderId, foreign.id)).toBe(false);
      expect(await forgetMemory(db, leaderId, pending.id)).toBe(false);
      expect(await forgetMemory(db, leaderId, "nope")).toBe(false);
      expect(await db.memory.count({ where: { id: { in: [mine.id, pending.id, foreign.id] } } })).toBe(3);

      expect(await forgetMemory(db, leaderId, mine.id)).toBe(true);
      expect(await db.memory.count({ where: { id: mine.id } })).toBe(0);
    });
  });
});
