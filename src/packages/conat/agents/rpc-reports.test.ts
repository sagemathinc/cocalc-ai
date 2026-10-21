import type { TurnOutcome } from "@cocalc/conat/ai/acp/turn-outcome";
import {
  AGENT_RPC_REPORT_DETAIL_MAX,
  agentRpcReportBinding,
  agentRpcReportDetail,
  agentRpcReportForVersion,
  agentRpcReportKindOf,
  agentRpcReportText,
  classifyAgentTurnError,
  validateAgentRpcTurnFailureReport,
  type AgentRpcTurnFailureReport,
} from "./rpc-reports";

const A = {
  project_id: "11111111-1111-4111-8111-111111111111",
  agent_id: "22222222-2222-4222-8222-222222222222",
};
const B = {
  project_id: "33333333-3333-4333-8333-333333333333",
  agent_id: "44444444-4444-4444-8444-444444444444",
};
const attempt_id = "55555555-5555-4555-8555-555555555555";

function report(
  overrides: Partial<AgentRpcTurnFailureReport> = {},
): AgentRpcTurnFailureReport {
  return {
    version: 1,
    report_id: "66666666-6666-4666-8666-666666666666",
    attempt_id,
    authorization: {
      version: 3,
      source: A,
      source_run_id: "77777777-7777-4777-8777-777777777777",
      target: B,
      target_path: "/home/user/b.chat",
      target_thread_id: "thread-b",
      agent_network_id: "88888888-8888-4888-8888-888888888888",
      network_generation: "99999999-9999-4999-8999-999999999999",
      account_generation: 3,
      configured_delivery: "queued",
      principal_account_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      guidance: false,
      attempt_id,
      report_capability: "1791800000000." + "c".repeat(43),
    },
    turn_started_at: 1_791_800_000_000,
    kind: "refused",
    detail: "This content was flagged for possible cybersecurity risk.",
    ...overrides,
  };
}

test("errors are sorted into kinds a sender can act on", () => {
  expect(
    classifyAgentTurnError(
      "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing",
    ),
  ).toBe("refused");
  expect(
    classifyAgentTurnError("You've hit your usage limit. Upgrade to Pro"),
  ).toBe("limit");
  expect(classifyAgentTurnError("Your subscription has expired")).toBe("limit");
  expect(classifyAgentTurnError("401 Unauthorized: please sign in")).toBe(
    "sign-in",
  );
  expect(classifyAgentTurnError("Request timed out after 600s")).toBe(
    "timeout",
  );
  expect(classifyAgentTurnError("ACP process exited")).toBe("error");
});

test("the detail is one bounded line", () => {
  expect(agentRpcReportDetail("a\n\n  b\tc")).toBe("a b c");
  const long = agentRpcReportDetail("x".repeat(1000));
  expect(long).toHaveLength(AGENT_RPC_REPORT_DETAIL_MAX);
  expect(long.endsWith("…")).toBe(true);
});

test("the sender is told what happened, by CoCalc", () => {
  const text = agentRpcReportText(report(), "@reviewer");
  expect(text).toMatch(
    /^\[Delivery report\] @reviewer's turn ended before it replied to your message: the model refused/,
  );
  expect(text).toContain(
    "Error: This content was flagged for possible cybersecurity risk.",
  );
  expect(text).toContain("This report is from CoCalc, not from @reviewer.");
  expect(agentRpcReportText(report({ detail: undefined }), "@r")).not.toMatch(
    /Error:/,
  );
});

test("how it ended, the limit's reset and whether resending is safe", () => {
  const now = Date.parse("2026-10-18T20:00:00Z");
  const limited = agentRpcReportText(
    report({
      kind: "limit",
      detail: undefined,
      resets_at: now + 5 * 3600_000,
      tool_ran: false,
    }),
    "@matlab",
    now,
  );
  expect(limited).toContain(
    "@matlab's turn ended before it replied to your message: a usage, credit or subscription limit.",
  );
  expect(limited).toContain(
    "The limit resets at 2026-10-19T01:00:00.000Z (in about 5 hours).",
  );
  expect(limited).toContain("it is safe to send it again");
  expect(limited).toContain("You can send it again after the reset");

  const stopped = agentRpcReportText(
    report({ kind: "stopped", tool_ran: true }),
    "@B",
  );
  expect(stopped).toMatch(
    /^\[Delivery report\] @B did not reply to your message: someone in its project stopped the turn\./,
  );
  // A cancel or stop has no error to quote.
  expect(stopped).not.toMatch(/Error:/);
  expect(stopped).toContain("check what it did before you send it again");

  const canceled = agentRpcReportText(report({ kind: "canceled" }), "@B");
  expect(canceled).toContain("canceled your message before it ran");
  expect(canceled).toContain("it is safe to send it again");
  // Unknown: say nothing either way.
  const lost = agentRpcReportText(
    report({ kind: "host-lost", detail: undefined }),
    "@B",
  );
  expect(lost).not.toMatch(/safe to send|check what it did/);
  expect(lost).toContain(
    "It is not known whether @B had started working on it, so check before you send it again.",
  );
});

test.each<[TurnOutcome, string | undefined]>([
  [{ version: 1, state: "completed" }, undefined],
  [
    {
      version: 1,
      state: "failed",
      failure: { kind: "limit", scope: "credential" },
      tool_ran: false,
    },
    "limit",
  ],
  [
    { version: 1, state: "failed", failure: { kind: "host-lost" } },
    "host-lost",
  ],
  [{ version: 1, state: "canceled", by: "person", tool_ran: true }, "stopped"],
  [{ version: 1, state: "canceled", by: "superseded" }, "superseded"],
  [{ version: 1, state: "never-started", reason: "canceled" }, "canceled"],
  [
    { version: 1, state: "never-started", reason: "project-stopped" },
    "project-stopped",
  ],
  [{ version: 1, state: "never-started", reason: "expired" }, "error"],
])("a turn that ended %j is reported as %s", (outcome, kind) => {
  expect(agentRpcReportKindOf(outcome)).toBe(kind);
});

test("a report of a queued message is valid", () => {
  expect(() => validateAgentRpcTurnFailureReport(report())).not.toThrow();
});

test.each<[string, () => AgentRpcTurnFailureReport]>([
  ["another message", () => report({ attempt_id: B.agent_id })],
  [
    "guidance (it did not start a turn)",
    () =>
      report({ authorization: { ...report().authorization, guidance: true } }),
  ],
  ["extra fields", () => ({ ...report(), body: "hi" }) as any],
  ["a bad reset time", () => report({ resets_at: -1 })],
  ["a bad tool_ran", () => ({ ...report(), tool_ran: "no" }) as any],
  ["a multi-line detail", () => report({ detail: "a\nb" })],
  ["a long detail", () => report({ detail: "x".repeat(301) })],
  ["an unknown kind", () => report({ kind: "other" as any })],
  ["an inherited kind", () => report({ kind: "toString" as any })],
  [
    "no capability from the hub",
    () =>
      report({
        authorization: {
          ...report().authorization,
          report_capability: undefined,
        },
      }),
  ],
  [
    "a malformed capability",
    () =>
      report({
        authorization: { ...report().authorization, report_capability: "c=" },
      }),
  ],
  [
    "a capability without its mint time",
    () =>
      report({
        authorization: {
          ...report().authorization,
          report_capability: "c".repeat(43),
        },
      }),
  ],
  ["no start time", () => report({ turn_started_at: 0 })],
  [
    "a registered sender without its run",
    () =>
      report({
        authorization: { ...report().authorization, source_run_id: undefined },
      }),
  ],
])("a report with %s is refused", (_, make) => {
  expect(() => validateAgentRpcTurnFailureReport(make())).toThrow();
});

test("the capability binds every field that says who, where and under what", () => {
  const { report_capability: _, ...execution } = report().authorization;
  const binding = agentRpcReportBinding(execution);
  // Not the capability itself.
  expect(agentRpcReportBinding(report().authorization)).toBe(binding);
  for (const changed of [
    { attempt_id: B.agent_id },
    { source: B },
    { source_run_id: A.agent_id },
    { target: A },
    { target_path: "/home/user/other.chat" },
    { target_thread_id: "other" },
    { agent_network_id: A.agent_id },
    { network_generation: A.agent_id },
    { account_generation: 4 },
    { configured_delivery: "live" as const },
    { principal_account_id: A.agent_id },
    { guidance: true },
  ])
    expect(agentRpcReportBinding({ ...execution, ...changed })).not.toBe(
      binding,
    );
});

describe("a turn that ended without a reply, when the sender asked", () => {
  const completed = () =>
    report({
      kind: "completed",
      detail: undefined,
      authorization: { ...report().authorization, report_no_reply: true },
    });

  it("is a valid report with its own text", () => {
    expect(() => validateAgentRpcTurnFailureReport(completed())).not.toThrow();
    const text = agentRpcReportText(completed(), "@reviewer");
    expect(text).toMatch(
      /^\[Delivery report\] @reviewer finished its turn on your message without replying to you \(you asked to be told\)\./,
    );
    expect(text).toMatch(/check before you send it again/);
    expect(text).not.toMatch(/ended before it replied|safe to send it again/);
  });

  it("reaches only a sender's host that can say so; older ones hold it", () => {
    expect(agentRpcReportForVersion(completed(), 3)).toEqual(completed());
    expect(agentRpcReportForVersion(completed(), 2)).toBeUndefined();
    expect(agentRpcReportForVersion(completed(), 1)).toBeUndefined();
    // Version 2 still takes every earlier kind unchanged.
    const stopped = report({ kind: "stopped", tool_ran: true });
    expect(agentRpcReportForVersion(stopped, 2)).toEqual(stopped);
  });

  it("is asked for with exactly true, and is not part of the signed binding", () => {
    expect(() =>
      validateAgentRpcTurnFailureReport(
        report({
          authorization: {
            ...report().authorization,
            report_no_reply: "yes" as any,
          },
        }),
      ),
    ).toThrow("invalid report_no_reply");
    // Hosts that predate the flag still match the hub's signature.
    expect(agentRpcReportBinding(completed().authorization)).toBe(
      agentRpcReportBinding(report().authorization),
    );
  });
});

describe("a turn held until its usage limit resets", () => {
  const NOW = 1_791_800_000_000;
  const held = () =>
    report({
      kind: "limit",
      detail: undefined,
      resets_at: NOW + 3 * 3_600_000,
      tool_ran: true,
      phase: "held",
    });

  it("says the turn is paused, not over, and when it resumes", () => {
    expect(() => validateAgentRpcTurnFailureReport(held())).not.toThrow();
    const text = agentRpcReportText(held(), "@reviewer", NOW);
    expect(text).toMatch(
      /^\[Delivery report\] @reviewer stopped working on your message because a usage, credit or subscription limit was reached\. Its turn is paused, not over: CoCalc resumes it automatically at 2026-.*\(in about 3 hours\)\./,
    );
    expect(text).toMatch(/another report only if that resumed turn ends/);
    expect(text).not.toMatch(/send it again/);
  });

  it("reaches only a sender's host that knows a held report", () => {
    expect(agentRpcReportForVersion(held(), 4)).toEqual(held());
    // Version 3 knows completed reports, but rejects the phase field.
    expect(agentRpcReportForVersion(held(), 3)).toBeUndefined();
    expect(agentRpcReportForVersion(held(), 2)).toBeUndefined();
    expect(agentRpcReportForVersion(held(), 1)).toBeUndefined();
  });

  it("has only the held phase", () => {
    expect(() =>
      validateAgentRpcTurnFailureReport({ ...held(), phase: "final" } as any),
    ).toThrow("invalid phase");
  });
});
