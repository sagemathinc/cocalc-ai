/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// What an agent is doing, as the host that runs it last saw: busy, waiting,
// or unavailable until a limit resets. The host reports it when it changes;
// it travels with the agent's identity to everyone who may message it
// (`agent destinations`, the Agents page). It never names the credential.

import type {
  TurnFailureKind,
  TurnOutcome,
} from "@cocalc/conat/ai/acp/turn-outcome";

export interface AgentTurnStatus {
  version: 1;
  /** Turns running now and waiting to run. */
  running: number;
  queued: number;
  /** It can't take turns: its last turn hit a usage limit (until it resets,
   * if known) or needs its sign-in renewed. */
  unavailable?: { reason: "limit" | "sign-in"; until?: number };
  /** How its last turn ended. */
  last?: { state: TurnOutcome["state"]; kind?: TurnFailureKind; at: number };
  /** When the host computed it (ms). */
  at: number;
}

/** Older than this, a status says nothing (its host stopped reporting). */
export const AGENT_TURN_STATUS_TTL_MS = 24 * 60 * 60_000;

const OUTCOME_STATES = ["completed", "failed", "canceled", "never-started"];
const FAILURE_KINDS = [
  "limit",
  "sign-in",
  "refused",
  "host-lost",
  "project-stopped",
  "timeout",
  "error",
];
const count = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const time = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) > 0;

/** The status if `value` is one, else undefined. */
export function parseAgentTurnStatus(
  value: unknown,
): AgentTurnStatus | undefined {
  const s = value as AgentTurnStatus;
  if (
    !s ||
    typeof s !== "object" ||
    s.version !== 1 ||
    !count(s.running) ||
    !count(s.queued) ||
    !time(s.at)
  )
    return;
  if (
    s.unavailable !== undefined &&
    (!s.unavailable ||
      !["limit", "sign-in"].includes(s.unavailable.reason) ||
      (s.unavailable.until !== undefined && !time(s.unavailable.until)))
  )
    return;
  if (
    s.last !== undefined &&
    (!s.last ||
      !OUTCOME_STATES.includes(s.last.state) ||
      (s.last.kind !== undefined && !FAILURE_KINDS.includes(s.last.kind)) ||
      !time(s.last.at))
  )
    return;
  // Only these fields: nothing else (a credential name) travels with it.
  return {
    version: 1,
    running: s.running,
    queued: s.queued,
    ...(s.unavailable
      ? {
          unavailable: {
            reason: s.unavailable.reason,
            ...(s.unavailable.until ? { until: s.unavailable.until } : {}),
          },
        }
      : {}),
    ...(s.last
      ? {
          last: {
            state: s.last.state,
            ...(s.last.kind ? { kind: s.last.kind } : {}),
            at: s.last.at,
          },
        }
      : {}),
    at: s.at,
  };
}

/** The status from a turn's outcome and what is running and waiting. */
export function agentTurnStatusOf(opts: {
  running: number;
  queued: number;
  last?: { outcome?: TurnOutcome; at: number };
  now: number;
}): AgentTurnStatus {
  const outcome = opts.last?.outcome;
  const failure = outcome?.state === "failed" ? outcome.failure : undefined;
  const unavailable =
    failure?.kind === "limit"
      ? failure.resets_at == null || failure.resets_at > opts.now
        ? {
            reason: "limit" as const,
            ...(failure.resets_at ? { until: failure.resets_at } : {}),
          }
        : undefined
      : failure?.kind === "sign-in"
        ? { reason: "sign-in" as const }
        : undefined;
  return {
    version: 1,
    running: opts.running,
    queued: opts.queued,
    // A turn running now means it is not stuck on the last failure.
    ...(unavailable && opts.running === 0 ? { unavailable } : {}),
    ...(opts.last && outcome
      ? {
          last: {
            state: outcome.state,
            ...(failure ? { kind: failure.kind } : {}),
            at: opts.last.at,
          },
        }
      : {}),
    at: opts.now,
  };
}

/** Whether two statuses say the same (the time computed aside). */
export function sameAgentTurnStatus(
  a: AgentTurnStatus | undefined,
  b: AgentTurnStatus | undefined,
): boolean {
  const key = (s?: AgentTurnStatus) =>
    s ? JSON.stringify({ ...s, at: undefined }) : "";
  return key(a) === key(b);
}

/**
 * One short phrase, for `agent destinations` and the Agents page; undefined
 * when there is nothing to say (no status, or too old to mean anything).
 * `formatTime` renders a time for the reader (their time zone).
 */
export function agentTurnStatusText(
  status: AgentTurnStatus | undefined | null,
  now: number,
  formatTime: (ms: number) => string = (ms) => new Date(ms).toISOString(),
): string | undefined {
  if (!status || now - status.at > AGENT_TURN_STATUS_TTL_MS) return;
  const u = status.unavailable;
  if (u?.reason === "limit" && (!u.until || u.until > now))
    return u.until
      ? `unavailable until ${formatTime(u.until)} (usage limit)`
      : "unavailable (usage limit)";
  if (u?.reason === "sign-in") return "unavailable (sign-in needs renewing)";
  if (status.running > 0)
    return status.queued > 0 ? `busy, ${status.queued} waiting` : "busy";
  if (status.queued > 0) return `${status.queued} waiting`;
  return "idle";
}
