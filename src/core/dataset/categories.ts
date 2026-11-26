import type { EmailCategory } from "../email-triage/classify";

/** Категории inbox.csv → EmailCategory. Нужны оракулу в тестах и разбору расхождений в eval. */
export const DATASET_CATEGORY: Record<string, EmailCategory> = {
  обязательства_клиентам: "CLIENT_COMMITMENT",
  продажи: "SALES",
  рассылка: "NEWSLETTER",
  приглашение: "INVITATION",
  отчёт: "REPORT",
  календарь: "CALENDAR",
  кадры: "HR",
  деньги: "MONEY",
  руководство: "MANAGEMENT",
  статус: "STATUS",
  доступы: "ACCESS",
  клиенты: "CLIENT_SUPPORT",
};
