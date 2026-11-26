/**
 * Загрузка датасета организаторов (data/tz_dataset). Нужна сидеру и тестам.
 * Все внешние данные проходят через zod.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { EmailAction } from "../email-triage/classify";
import type { RelationType } from "../policy-gate";

export const DATASET_DIR = path.resolve(process.cwd(), "data", "tz_dataset");

/** Минимальный CSV-парсер (RFC 4180): кавычки, запятые и переводы строк внутри полей. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((c) => c !== "")) rows.push(row);
  }
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

const read = (name: string, dir: string) => parseCsv(readFileSync(path.join(dir, name), "utf8"));

/** Роль из org_structure.csv → relationType. Неизвестная роль — ошибка (fail loud). */
const RELATION: Record<string, RelationType | "LEADER"> = {
  руководитель: "LEADER",
  подчинённый: "SUBORDINATE",
  "руководитель руководителя": "MANAGER",
  коллега: "PEER",
};

const OrgRow = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  position: z.string().min(1),
  role_for_leader: z.string().min(1),
  reports_to: z.string(),
});

export interface OrgMember {
  externalId: string;
  name: string;
  position: string;
  /** В датасете адреса не заданы: `<id>@company.example` (так же адресованы письма и встречи). */
  email: string;
  relationType: RelationType;
}

export function loadOrg(dir = DATASET_DIR, emailDomain = "company.example") {
  const rows = read("org_structure.csv", dir).map((r) => OrgRow.parse(r));
  const toMember = (r: z.infer<typeof OrgRow>) => {
    const rel = RELATION[r.role_for_leader];
    if (!rel) throw new Error(`Unknown role_for_leader: ${r.role_for_leader}`);
    return { r, rel, email: `${r.id}@${emailDomain}` };
  };
  const all = rows.map(toMember);
  const leaderRow = all.find((m) => m.rel === "LEADER");
  if (!leaderRow) throw new Error("org_structure.csv: leader row not found");
  const members: OrgMember[] = all
    .filter((m) => m.rel !== "LEADER")
    .map((m) => ({
      externalId: m.r.id,
      name: m.r.name,
      position: m.r.position,
      email: m.email,
      relationType: m.rel as RelationType,
    }));
  return {
    leader: { externalId: leaderRow.r.id, name: leaderRow.r.name, position: leaderRow.r.position, email: leaderRow.email },
    members,
    emailDomain,
  };
}

const ACTIONS: Record<string, EmailAction> = {
  спросить_руководителя: "ASK_LEADER",
  делегировать: "DELEGATE",
  авто: "AUTO",
  в_сводку: "DIGEST",
  игнорировать: "IGNORE",
};

const InboxRow = z.object({
  id: z.string().min(1),
  received: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
  from_name: z.string(),
  from_email: z.string().email(),
  sender_role: z.string(),
  to: z.string(),
  subject: z.string(),
  body: z.string(),
  category: z.string(),
  expected_action: z.string(),
  reason: z.string(),
});

export interface InboxMail {
  externalId: string;
  receivedAt: Date;
  senderName: string;
  senderEmail: string;
  senderRole: string;
  recipients: string[];
  subject: string;
  body: string;
  datasetCategory: string;
  expectedAction: EmailAction;
  reason: string;
}

export function loadInbox(dir = DATASET_DIR): InboxMail[] {
  return read("inbox.csv", dir).map((raw) => {
    const r = InboxRow.parse(raw);
    const expectedAction = ACTIONS[r.expected_action];
    if (!expectedAction) throw new Error(`Unknown expected_action: ${r.expected_action}`);
    return {
      externalId: r.id,
      // Время в датасете — московское.
      receivedAt: new Date(`${r.received.replace(" ", "T")}:00+03:00`),
      senderName: r.from_name,
      senderEmail: r.from_email,
      senderRole: r.sender_role,
      recipients: r.to.split(/[;,]/).map((s) => s.trim()).filter(Boolean),
      subject: r.subject,
      body: r.body,
      datasetCategory: r.category,
      expectedAction,
      reason: r.reason,
    };
  });
}

const TaskRow = z.object({
  id: z.string(),
  task: z.string().min(1),
  owner: z.string().min(1),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.string(),
  source: z.string(),
});

export interface DatasetTask {
  externalId: string;
  title: string;
  ownerName: string;
  dueAt: Date;
  csvStatus: string;
  source: string;
}

export function loadTasks(dir = DATASET_DIR): DatasetTask[] {
  return read("tasks.csv", dir).map((raw) => {
    const r = TaskRow.parse(raw);
    return {
      externalId: r.id,
      title: r.task,
      ownerName: r.owner,
      dueAt: new Date(`${r.due}T18:00:00+03:00`),
      csvStatus: r.status,
      source: r.source,
    };
  });
}

export function loadProfileMarkdown(file = path.join(DATASET_DIR, "leader_profile.md")): string {
  return readFileSync(file, "utf8");
}
