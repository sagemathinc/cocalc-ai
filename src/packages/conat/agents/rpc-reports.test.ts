import {
  AGENT_RPC_REPORT_DETAIL_MAX,
  agentRpcReportBinding,
  agentRpcReportDetail,
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
    /^\[Delivery report\] @reviewer's turn ended with an error before it replied to your message: the model refused/,
  );
  expect(text).toContain(
    "Error: This content was flagged for possible cybersecurity risk.",
  );
  expect(text).toContain("This report is from CoCalc, not from @reviewer.");
  expect(agentRpcReportText(report({ detail: undefined }), "@r")).not.toMatch(
    /Error:/,
  );
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
