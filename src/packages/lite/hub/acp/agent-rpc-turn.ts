/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// `agent rpc inspect` on the recipient's host: what became of the turn an
// agent message started, from the host's own job record (durable, unlike the
// admission receipt). Only the message's sender, as the hub authenticated
// it, learns this.

import {
  agentRpcSourceKey,
  type AgentRpcAttempt,
  type AgentRpcSource,
} from "@cocalc/conat/agents/rpc";
import type { AgentRpcTurnState } from "@cocalc/conat/agents/rpc-turn";
import {
  chainToolRan,
  parseTurnOutcome,
  toolRanOf,
  type TurnOutcome,
} from "@cocalc/conat/ai/acp/turn-outcome";
import {
  acpJobHasLiveFenceResume,
  countQueuedAcpJobsAhead,
  decodeAcpJobRequest,
  listAcpJobsForAgentRpcAttempt,
  type AcpJobRow,
} from "../sqlite/acp-jobs";

function sentBy(
  job: AcpJobRow,
  source: AgentRpcSource,
  attempt: AgentRpcAttempt,
): boolean {
  const execution = decodeAcpJobRequest(job).chat?.agent_rpc_execution;
  return (
    !!execution &&
    execution.attempt_id === attempt.attempt_id &&
    // An attempt ID is unique only within its Agent Network.
    execution.agent_network_id === attempt.agent_network_id &&
    agentRpcSourceKey(execution.source) === agentRpcSourceKey(source) &&
    agentRpcSourceKey(execution.target) === agentRpcSourceKey(attempt.target)
  );
}

/** Tool use over every attempt, for an outcome that can say it. */
function withChainToolRan(
  outcome: TurnOutcome,
  attempts: (boolean | undefined)[],
): TurnOutcome {
  if (outcome.state !== "failed" && outcome.state !== "canceled")
    return outcome;
  const { tool_ran: _, ...rest } = outcome;
  const tool_ran = chainToolRan(attempts);
  return (tool_ran === undefined ? rest : { ...rest, tool_ran }) as TurnOutcome;
}

export function agentRpcTurnState(
  source: AgentRpcSource,
  attempt: AgentRpcAttempt,
  accountId: string,
): AgentRpcTurnState | undefined {
  const jobs = listAcpJobsForAgentRpcAttempt({
    attempt_id: attempt.attempt_id,
    account_id: accountId,
  }).filter((job) => sentBy(job, source, attempt));
  if (jobs.length === 0) return undefined;
  const first = jobs[0];
  const last = jobs[jobs.length - 1];
  const started = jobs.find((job) => job.started_at != null)?.started_at;
  // A job still waiting to start has run nothing; a running one is unknown.
  const attempts = jobs.map((job) =>
    job.state === "queued" && job.started_at == null
      ? false
      : toolRanOf(parseTurnOutcome(job.outcome_json)),
  );
  const tool_ran = chainToolRan(attempts);
  const base = {
    queued_at: first.created_at,
    ...(started != null ? { started_at: started } : {}),
    ...(tool_ran !== undefined ? { tool_ran } : {}),
  };
  if (last.state === "queued")
    return {
      state: "queued",
      ...base,
      ahead_in_queue: countQueuedAcpJobsAhead(last),
    };
  // Cut off by a project restart, waiting for the project to run again.
  if (last.state === "canceled" && acpJobHasLiveFenceResume(last))
    return { state: "queued", held: true, ...base };
  if (last.state === "running") return { state: "running", ...base };
  const outcome = parseTurnOutcome(last.outcome_json);
  return {
    state: "ended",
    ...base,
    ...(last.finished_at != null ? { ended_at: last.finished_at } : {}),
    ...(outcome
      ? {
          outcome: withChainToolRan(outcome, attempts),
        }
      : {}),
  };
}
