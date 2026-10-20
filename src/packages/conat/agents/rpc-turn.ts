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
  /** Whether any attempt so far ran tools (a turn cut off by a restart is
   * continued by a new attempt); absent when that is not known. */
  tool_ran?: boolean;
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
    (turn.outcome !== undefined && !parseTurnOutcome(turn.outcome)) ||
    (turn.tool_ran !== undefined && typeof turn.tool_ran !== "boolean")
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

function toolsText(ran: boolean | undefined): string {
  return ran === true
    ? " It had run tools, so check what it did before resending."
    : ran === false
      ? " It had not run any tools."
      : "";
}

/** The chain's tool use, else what the final outcome says. */
function toolRan(turn: AgentRpcTurnState): boolean | undefined {
  if (turn.tool_ran !== undefined) return turn.tool_ran;
  const outcome = turn.outcome;
  if (outcome?.state === "never-started") return false;
  return outcome && "tool_ran" in outcome ? outcome.tool_ran : undefined;
}

/** One plain line on where the turn is, for people and agents. */
export function agentRpcTurnSummary(turn: AgentRpcTurnState): string {
  const ahead = turn.ahead_in_queue
    ? ` behind ${turn.ahead_in_queue} other turn(s)`
    : "";
  if (turn.state === "queued") {
    const restarting =
      "the recipient's project is restarting; it resumes when the project runs again.";
    // An attempt already ran: this is a continuation waiting, not a new turn.
    if (turn.started_at != null)
      return `Started ${iso(turn.started_at)}; interrupted and ${
        turn.held ? `held: ${restarting}` : `waiting to resume${ahead}.`
      }${toolsText(toolRan(turn))}`;
    return turn.held
      ? `Held since ${iso(turn.queued_at)}: ${restarting}`
      : `Queued since ${iso(turn.queued_at)}${ahead}; it has not started.`;
  }
  if (turn.state === "running")
    return `Running since ${iso(turn.started_at ?? turn.queued_at)}; it has not ended.${
      toolRan(turn) === true ? toolsText(true) : ""
    }`;
  const outcome = turn.outcome;
  const tools = outcome?.state === "completed" ? "" : toolsText(toolRan(turn));
  return `Ended${turn.ended_at ? ` ${iso(turn.ended_at)}` : ""}: ${outcomeText(outcome)}.${tools}`;
}
