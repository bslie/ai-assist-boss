import { describe, expect, it } from "vitest";
import {
  detectRiskSignals,
  hasHardSignal,
  type OrgPerson,
  type RiskContext,
  type RiskInput,
  type RiskSignal,
} from "@/core/policy-gate";

/**
 * Детерминированный тест без LLM (SPEC 7.2).
 * Синтетическая оргструктура; когда в data/tz_dataset появится inbox.csv,
 * добавить прогон по 80 строкам: жёсткие сигналы на всех 40 «спросить_руководителя»
 * и ни на одной из остальных 40.
 */

const org: OrgPerson[] = [
  { email: "ceo@corp.ru", position: "Генеральный директор", relationType: "MANAGER" },
  { email: "hr@corp.ru", position: "HR-партнёр", relationType: "PEER" },
  { email: "fin@corp.ru", position: "Руководитель финансового контроля", relationType: "PEER" },
  { email: "sales@corp.ru", position: "Директор по продажам", relationType: "SUBORDINATE" },
  { email: "it@corp.ru", position: "Руководитель ИТ", relationType: "SUBORDINATE" },
];

const ctx: RiskContext = { leaderEmail: "boss@corp.ru", org };

const mail = (over: Partial<RiskInput> & Pick<RiskInput, "senderEmail">): RiskInput => ({
  subject: "",
  body: "",
  ...over,
});

const signals = (input: RiskInput): RiskSignal[] => detectRiskSignals(input, ctx);

describe("жёсткие сигналы → письмо уходит руководителю", () => {
  it("MANAGER_PARTY: отправитель — вышестоящий руководитель", () => {
    const s = signals(mail({ senderEmail: "ceo@corp.ru", subject: "Встреча", body: "Зайди ко мне" }));
    expect(s).toContain("MANAGER_PARTY");
    expect(hasHardSignal(s)).toBe(true);
  });

  it("MANAGER_PARTY: вышестоящий среди получателей", () => {
    const s = signals(
      mail({ senderEmail: "sales@corp.ru", recipients: ["boss@corp.ru", "ceo@corp.ru"], body: "Статус" }),
    );
    expect(s).toContain("MANAGER_PARTY");
  });

  it("получатель-руководитель сам по себе не считается стороной", () => {
    const s = signals(mail({ senderEmail: "sales@corp.ru", recipients: ["boss@corp.ru"], body: "Привет" }));
    expect(s).not.toContain("MANAGER_PARTY");
  });

  it("HR_PARTY и FINANCE_PARTY определяются по должности из оргструктуры", () => {
    expect(signals(mail({ senderEmail: "hr@corp.ru", body: "Привет" }))).toContain("HR_PARTY");
    expect(signals(mail({ senderEmail: "fin@corp.ru", body: "Привет" }))).toContain("FINANCE_PARTY");
  });

  it("HR_TERMS: кадровые слова в тексте", () => {
    for (const word of ["отпуск", "оффер", "найм", "увольнение", "больничный", "зарплата", "кандидат"]) {
      const s = signals(mail({ senderEmail: "sales@corp.ru", body: `Нужно решить про ${word}` }));
      expect(s, word).toContain("HR_TERMS");
    }
  });

  it("COMMITMENT_TERMS: только для внешнего домена", () => {
    const external = signals(
      mail({ senderEmail: "client@acme.com", body: "Подтвердите срок запуска, нужна гарантия по SLA" }),
    );
    expect(external).toContain("COMMITMENT_TERMS");

    const internal = signals(mail({ senderEmail: "it@corp.ru", body: "Срок запуска сдвигается" }));
    expect(internal).not.toContain("COMMITMENT_TERMS");
  });

  it("EXTERNAL_INVITATION: внешнее приглашение выступить", () => {
    const s = signals(
      mail({ senderEmail: "org@conf.io", subject: "Приглашаем", body: "Приглашаем вас выступить спикером" }),
    );
    expect(s).toContain("EXTERNAL_INVITATION");
  });

  it("MONEY_APPROVAL: деньги + просьба согласовать", () => {
    const cases = [
      "Нужно согласование бюджета на закупку",
      "Согласуйте скидку 15%",
      "Прошу вас подтвердить оплату 300 тыс. руб.",
    ];
    for (const body of cases) {
      const s = signals(mail({ senderEmail: "sales@corp.ru", body }));
      expect(s, body).toContain("MONEY_APPROVAL");
      expect(hasHardSignal(s), body).toBe(true);
    }
  });
});

describe("не-риск: внутренние рутинные письма не эскалируются", () => {
  it("рассылка и отчёт без денег и кадров — сигналов нет", () => {
    expect(signals(mail({ senderEmail: "it@corp.ru", subject: "Дайджест", body: "Новости недели" }))).toEqual([]);
  });

  it("мягкий MONEY_TERMS: проценты в отчёте — не жёсткий сигнал", () => {
    const s = signals(
      mail({ senderEmail: "sales@corp.ru", subject: "Отчёт", body: "Выручка выросла на 12%, план выполнен" }),
    );
    expect(s).toEqual(["MONEY_TERMS"]);
    expect(hasHardSignal(s)).toBe(false);
  });

  it("«бюджет согласован» в запросе КП — мягкий сигнал, а не просьба согласовать", () => {
    const s = signals(
      mail({ senderEmail: "sales@corp.ru", body: "Бюджет согласован, подготовьте КП для клиента" }),
    );
    expect(s).toEqual(["MONEY_TERMS"]);
    expect(hasHardSignal(s)).toBe(false);
  });

  it("запрос доступа от подчинённого — без сигналов", () => {
    expect(
      signals(mail({ senderEmail: "it@corp.ru", subject: "Доступ", body: "Нужен доступ к CRM для нового сотрудника" })),
    ).toEqual([]);
  });

  it("жалоба внешнего клиента без сроков и денег — без жёстких сигналов", () => {
    const s = signals(mail({ senderEmail: "client@acme.com", body: "Сервис работает медленно, помогите" }));
    expect(hasHardSignal(s)).toBe(false);
  });
});

describe("устойчивость", () => {
  it("регистр и пробелы в адресах не влияют", () => {
    const s = signals(mail({ senderEmail: "  CEO@Corp.RU ", body: "Привет" }));
    expect(s).toContain("MANAGER_PARTY");
  });

  it("результат детерминирован и упорядочен", () => {
    const input = mail({ senderEmail: "hr@corp.ru", body: "Оффер кандидату, нужно согласование бюджета" });
    expect(signals(input)).toEqual(signals(input));
    expect(signals(input)).toEqual(["HR_PARTY", "HR_TERMS", "MONEY_APPROVAL"]);
  });
});
