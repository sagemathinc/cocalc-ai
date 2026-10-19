import {
  parseTurnOutcome,
  turnFailureFromRateLimit,
  turnFailureFromText,
  turnFailureOf,
  turnOutcomeOf,
  withTurnFailure,
} from "./turn-outcome";

const NOW = Date.parse("2026-10-18T20:00:00Z");

describe("Claude's rate limit report", () => {
  it("a rejection is a limit of this credential, with its reset", () => {
    expect(
      turnFailureFromRateLimit(
        {
          status: "rejected",
          resetsAt: NOW / 1000 + 5 * 3600,
          rateLimitType: "seven_day",
          utilization: 1,
        },
        "cred-1",
        NOW,
      ),
    ).toEqual({
      kind: "limit",
      scope: "credential",
      credential_id: "cred-1",
      resets_at: NOW + 5 * 3600 * 1000,
      window: "seven_day",
    });
  });

  it("allowed and warnings are not failures", () => {
    for (const status of ["allowed", "allowed_warning", undefined])
      expect(
        turnFailureFromRateLimit({ status, resetsAt: NOW / 1000 }, "c", NOW),
      ).toBeUndefined();
    expect(turnFailureFromRateLimit(null)).toBeUndefined();
  });

  it("drops a reset time or window it cannot trust", () => {
    expect(
      turnFailureFromRateLimit(
        { status: "rejected", resetsAt: 12, rateLimitType: "<b>x</b>" },
        undefined,
        NOW,
      ),
    ).toEqual({ kind: "limit", scope: "credential" });
  });
});

describe("classifying by text, the last resort", () => {
  it.each([
    ["You've hit your weekly limit · resets Oct 19, 1am", "limit"],
    ["5-hour limit reached ∙ resets 3pm", "limit"],
    ["Claude AI usage limit reached|1792400000", "limit"],
    ["429 Too Many Requests", "limit"],
    ["Claude is not signed in.", "sign-in"],
    ["401 Unauthorized", "sign-in"],
    ["This request was flagged by our cybersecurity filter", "refused"],
    ["The model timed out", "timeout"],
    [
      "Claude could not run this request. (ACP session/prompt, code -32603)",
      "error",
    ],
  ])("%s", (text, kind) => {
    expect(turnFailureFromText(text).kind).toBe(kind);
  });

  it("CoCalc's own allowance is not the account's credential", () => {
    expect(
      turnFailureFromText(
        "Stopped: you reached your CoCalc AI usage limit for site-provided OpenAI access.",
      ),
    ).toEqual({ kind: "limit", scope: "cocalc" });
    expect(turnFailureFromText("usage limit: upgrade your membership")).toEqual(
      { kind: "limit", scope: "cocalc" },
    );
    expect(turnFailureFromText("You've hit your weekly limit")).toEqual({
      kind: "limit",
      scope: "credential",
    });
  });
});

describe("a turn's outcome", () => {
  it("completed", () => {
    expect(
      turnOutcomeOf({ terminalState: "completed", toolRan: true }),
    ).toEqual({ version: 1, state: "completed" });
  });

  it("a person stopped it", () => {
    expect(
      turnOutcomeOf({ terminalState: "interrupted", toolRan: true }),
    ).toEqual({ version: 1, state: "canceled", by: "person", tool_ran: true });
  });

  it("an explicit failure wins over the code and the text", () => {
    const failure = { kind: "limit", scope: "credential" } as const;
    expect(
      turnOutcomeOf({
        terminalState: "error",
        failure,
        code: "codex_turn_lost",
        error: "401 Unauthorized",
        toolRan: false,
      }),
    ).toEqual({
      version: 1,
      state: "failed",
      failure,
      tool_ran: false,
      classified_by: "signal",
      detail: "401 Unauthorized",
    });
  });

  it("then a recovery code, then the text", () => {
    expect(
      turnOutcomeOf({
        terminalState: "error",
        code: "acp_harness_killed",
        error: "401",
        toolRan: true,
      }),
    ).toMatchObject({
      failure: { kind: "host-lost" },
      classified_by: "signal",
      tool_ran: true,
    });
    expect(
      turnOutcomeOf({
        terminalState: "error",
        code: "codex_model_capacity",
        toolRan: false,
      }),
    ).toMatchObject({
      failure: { kind: "error", code: "codex_model_capacity" },
    });
    expect(
      turnOutcomeOf({
        terminalState: "error",
        error: "You've hit your weekly limit",
        toolRan: false,
      }),
    ).toMatchObject({
      failure: { kind: "limit", scope: "credential" },
      classified_by: "text",
    });
  });

  it("keeps its detail to one short line", () => {
    const outcome = turnOutcomeOf({
      terminalState: "error",
      error: `line one\nline two ${"x".repeat(500)}`,
      toolRan: false,
    });
    expect(outcome.detail).toMatch(/^line one line two x+…$/);
    expect(outcome.detail!.length).toBe(300);
  });
});

describe("stored outcomes", () => {
  it("round-trip", () => {
    const outcome = turnOutcomeOf({
      terminalState: "error",
      failure: { kind: "sign-in", credential_id: "c" },
      toolRan: false,
    });
    expect(parseTurnOutcome(JSON.stringify(outcome))).toEqual(outcome);
    expect(
      parseTurnOutcome({
        version: 1,
        state: "never-started",
        reason: "project-stopped",
      }),
    ).toBeTruthy();
  });

  it("refuses what is not an outcome", () => {
    for (const value of [
      null,
      "",
      "{",
      { version: 2, state: "completed" },
      {
        version: 1,
        state: "failed",
        failure: { kind: "nope" },
        tool_ran: false,
      },
      {
        version: 1,
        state: "failed",
        failure: { kind: "limit" },
        tool_ran: false,
      },
      {
        version: 1,
        state: "failed",
        failure: { kind: "error" },
        tool_ran: "yes",
      },
      { version: 1, state: "canceled", by: "someone", tool_ran: false },
      { version: 1, state: "never-started", reason: "whatever" },
    ])
      expect(parseTurnOutcome(value)).toBeUndefined();
  });
});

describe("a failure attached to an error", () => {
  it("travels with the error, and only a valid one is read back", () => {
    const error = withTurnFailure(new Error("x"), { kind: "refused" });
    expect(turnFailureOf(error)).toEqual({ kind: "refused" });
    expect(turnFailureOf(new Error("x"))).toBeUndefined();
    expect(turnFailureOf("x")).toBeUndefined();
    expect(
      turnFailureOf(Object.assign(new Error("x"), { cocalcTurnFailure: {} })),
    ).toBeUndefined();
  });
});
