/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// What became of the turn an agent message started, as `agent rpc inspect`
// reports it: from the recipient host's own record of the job, so it is
// known long after the admission receipt has expired.

import {
  parseTurnOutcome,
  type TurnOutcome,
} from "@cocalc/conat/ai/acp/turn-outcome";

export interface AgentRpcTurnState {
  /** queued includes held for a project restart (`held: true`). */
  state: "queued" | "running" | "ended";
  held?: boolean;
  /** When the message was queued (ms). */
  queued_at: number;
  started_at?: number;
  ended_at?: number;
  /** Turns ahead of it in the recipient's conversation. */
  ahead_in_queue?: number;
  /** How it ended (state "ended"); tool use counts every attempt. */
  outcome?: TurnOutcome;
}

const time = (value: unknown) =>
  value === undefined || (Number.isSafeInteger(value) && (value as number) > 0);

/** Throws unless `value` is a turn state as this version defines it. */
export function validateAgentRpcTurnState(value: unknown): void {
  const turn = value as AgentRpcTurnState;
  if (
    !turn ||
    typeof turn !== "object" ||
    !["queued", "running", "ended"].includes(turn.state) ||
    (turn.held !== undefined && typeof turn.held !== "boolean") ||
    !Number.isSafeInteger(turn.queued_at) ||
    turn.queued_at <= 0 ||
    !time(turn.started_at) ||
    !time(turn.ended_at) ||
    (turn.ahead_in_queue !== undefined &&
      (!Number.isSafeInteger(turn.ahead_in_queue) ||
        turn.ahead_in_queue < 0)) ||
    (turn.outcome !== undefined && !parseTurnOutcome(turn.outcome))
  )
    throw new Error("invalid turn state");
}

const iso = (ms: number) => new Date(ms).toISOString();

function outcomeText(outcome: TurnOutcome | undefined): string {
  if (!outcome) return "it ended (no outcome recorded)";
  switch (outcome.state) {
    case "completed":
      return "it completed";
    case "failed": {
      const f = outcome.failure;
      const reset =
        f.kind === "limit" && f.resets_at ? `, resets ${iso(f.resets_at)}` : "";
      return `it failed: ${f.kind}${reset}`;
    }
    case "canceled":
      return outcome.by === "person"
        ? "someone in the recipient's project stopped it"
        : outcome.by === "superseded"
          ? "a newer message in the recipient's conversation replaced it"
          : `it was canceled (${outcome.by})`;
    case "never-started":
      return outcome.reason === "canceled"
        ? "someone in the recipient's project canceled it before it ran"
        : `it never started: ${outcome.reason}`;
  }
}

/** One plain line on where the turn is, for people and agents. */
export function agentRpcTurnSummary(turn: AgentRpcTurnState): string {
  if (turn.state === "queued")
    return turn.held
      ? `Held since ${iso(turn.queued_at)}: the recipient's project is restarting; it resumes when the project runs again.`
      : `Queued since ${iso(turn.queued_at)}${
          turn.ahead_in_queue
            ? ` behind ${turn.ahead_in_queue} other turn(s)`
            : ""
        }; it has not started.`;
  if (turn.state === "running")
    return `Running since ${iso(turn.started_at ?? turn.queued_at)}; it has not ended.`;
  const outcome = turn.outcome;
  const tools =
    outcome?.state === "completed"
      ? ""
      : outcome && "tool_ran" in outcome && outcome.tool_ran === true
        ? " It had run tools, so check what it did before resending."
        : outcome &&
            (outcome.state === "never-started" ||
              ("tool_ran" in outcome && outcome.tool_ran === false))
          ? " It had not run any tools."
          : "";
  return `Ended${turn.ended_at ? ` ${iso(turn.ended_at)}` : ""}: ${outcomeText(outcome)}.${tools}`;
}
