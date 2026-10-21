import { validateAgentRpcOutcome } from "./rpc";
import {
  agentRpcTurnSummary,
  validateAgentRpcTurnState,
  type AgentRpcTurnState,
} from "./rpc-turn";

const T = Date.parse("2026-10-19T05:00:00Z");

describe("a turn's state, as inspect reports it", () => {
  it.each<[AgentRpcTurnState, string]>([
    [
      { state: "queued", queued_at: T, ahead_in_queue: 2 },
      "Queued since 2026-10-19T05:00:00.000Z behind 2 other turn(s); it has not started.",
    ],
    [
      { state: "queued", held: true, queued_at: T },
      "Held since 2026-10-19T05:00:00.000Z: the recipient's project is restarting; it resumes when the project runs again.",
    ],
    [
      { state: "running", queued_at: T, started_at: T + 60_000 },
      "Running since 2026-10-19T05:01:00.000Z; it has not ended.",
    ],
    [
      {
        state: "ended",
        queued_at: T,
        ended_at: T + 120_000,
        outcome: {
          version: 1,
          state: "failed",
          failure: {
            kind: "limit",
            scope: "credential",
            resets_at: T + 3_600_000,
          },
          tool_ran: false,
        },
      },
      "Ended 2026-10-19T05:02:00.000Z: it failed: limit, resets 2026-10-19T06:00:00.000Z. It had not run any tools.",
    ],
    [
      {
        state: "ended",
        queued_at: T,
        outcome: {
          version: 1,
          state: "canceled",
          by: "person",
          tool_ran: true,
        },
      },
      "Ended: someone in the recipient's project stopped it. It had run tools, so check what it did before resending.",
    ],
    [
      {
        state: "ended",
        queued_at: T,
        outcome: { version: 1, state: "never-started", reason: "canceled" },
      },
      "Ended: someone in the recipient's project canceled it before it ran. It had not run any tools.",
    ],
    [
      {
        state: "ended",
        queued_at: T,
        outcome: { version: 1, state: "completed" },
      },
      "Ended: it completed.",
    ],
    [
      {
        state: "ended",
        queued_at: T,
        outcome: {
          version: 1,
          state: "canceled",
          by: "sender",
          tool_ran: false,
        },
      },
      "Ended: you withdrew it. It had not run any tools.",
    ],
    [
      {
        state: "queued",
        queued_at: T,
        started_at: T + 60_000,
        ahead_in_queue: 1,
        tool_ran: true,
      },
      "Started 2026-10-19T05:01:00.000Z; interrupted and waiting to resume behind 1 other turn(s). It had run tools, so check what it did before resending.",
    ],
    [
      {
        state: "queued",
        held: true,
        queued_at: T,
        started_at: T + 60_000,
        tool_ran: false,
      },
      "Started 2026-10-19T05:01:00.000Z; interrupted and held: the recipient's project is restarting; it resumes when the project runs again. It had not run any tools.",
    ],
    [
      { state: "running", queued_at: T, started_at: T, tool_ran: true },
      "Running since 2026-10-19T05:00:00.000Z; it has not ended. It had run tools, so check what it did before resending.",
    ],
    [
      {
        state: "ended",
        queued_at: T,
        outcome: { version: 1, state: "never-started", reason: "canceled" },
        tool_ran: true,
      },
      "Ended: someone in the recipient's project canceled it before it ran. It had run tools, so check what it did before resending.",
    ],
  ])("%j", (turn, text) => {
    validateAgentRpcTurnState(turn);
    expect(agentRpcTurnSummary(turn)).toBe(text);
  });

  it("refuses what is not a turn state", () => {
    for (const bad of [
      null,
      { state: "lost", queued_at: T },
      { state: "queued" },
      { state: "queued", queued_at: T, ahead_in_queue: -1 },
      { state: "running", queued_at: T, started_at: "soon" },
      { state: "running", queued_at: T, tool_ran: "yes" },
      { state: "ended", queued_at: T, outcome: { version: 1, state: "won" } },
    ])
      expect(() => validateAgentRpcTurnState(bad)).toThrow(
        "invalid turn state",
      );
  });

  it("an acknowledgment with an invalid turn is refused", () => {
    const attempt = {
      version: 3 as const,
      attempt_id: "55555555-5555-4555-8555-555555555555",
      agent_network_id: "88888888-8888-4888-8888-888888888888",
      target: {
        project_id: "11111111-1111-4111-8111-111111111111",
        agent_id: "22222222-2222-4222-8222-222222222222",
      },
    };
    const outcome = {
      ...attempt,
      outcome: "accepted" as const,
      observed_at: T,
    };
    expect(() =>
      validateAgentRpcOutcome(
        { ...outcome, turn: { state: "running", queued_at: T } },
        attempt,
      ),
    ).not.toThrow();
    expect(() =>
      validateAgentRpcOutcome(
        { ...outcome, turn: { state: "lost", queued_at: T } as any },
        attempt,
      ),
    ).toThrow("invalid turn state");
  });
});
