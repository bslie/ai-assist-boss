import { describe, expect, it } from "vitest";
import { loadInbox, loadOrg } from "@/core/dataset";
import { detectRiskSignals, hasHardSignal } from "@/core/policy-gate";

/** SPEC 7.2: детерминированный прогон по 80 письмам, без LLM. */
describe("risk signals на датасете", () => {
  const org = loadOrg();
  const inbox = loadInbox();
  const ctx = { leaderEmail: org.leader.email, org: org.members, internalDomains: [org.emailDomain] };
  const hard = (m: (typeof inbox)[number]) =>
    hasHardSignal(detectRiskSignals({ senderEmail: m.senderEmail, recipients: m.recipients, subject: m.subject, body: m.body }, ctx));

  it("80 писем, 40 с эталоном «спросить руководителя»", () => {
    expect(inbox).toHaveLength(80);
    expect(inbox.filter((m) => m.expectedAction === "ASK_LEADER")).toHaveLength(40);
  });

  it("жёсткие сигналы срабатывают на всех ASK_LEADER", () => {
    const missed = inbox.filter((m) => m.expectedAction === "ASK_LEADER" && !hard(m)).map((m) => m.externalId);
    expect(missed).toEqual([]);
  });

  it("жёсткие сигналы не срабатывают на остальных (ложные эскалации)", () => {
    const extra = inbox.filter((m) => m.expectedAction !== "ASK_LEADER" && hard(m)).map((m) => m.externalId);
    expect(extra).toEqual([]);
  });
});
