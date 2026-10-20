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
   * if known) or needs its sign-in renewed. As each account sees it: limits
   * and sign-ins belong to the account whose credential paid. */
  unavailable?: AgentUnavailable;
  /** Host to hub only: each account's own unavailability, from its own
   * latest turn. The hub turns it into `unavailable` for that account and
   * never passes it on (see agentTurnStatusFor). */
  by_account?: Record<string, AgentUnavailable>;
  /** How its last turn ended. */
  last?: { state: TurnOutcome["state"]; kind?: TurnFailureKind; at: number };
  /** When the host computed it (ms). */
  at: number;
}

export interface AgentUnavailable {
  reason: "limit" | "sign-in";
  until?: number;
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ACCOUNTS = 100;

function parseUnavailable(value: unknown): AgentUnavailable | undefined {
  const u = value as AgentUnavailable;
  if (
    !u ||
    typeof u !== "object" ||
    !["limit", "sign-in"].includes(u.reason) ||
    (u.until !== undefined && !time(u.until))
  )
    return;
  return { reason: u.reason, ...(u.until ? { until: u.until } : {}) };
}

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
  if (s.unavailable !== undefined && !parseUnavailable(s.unavailable)) return;
  let by_account: Record<string, AgentUnavailable> | undefined;
  if (s.by_account !== undefined) {
    if (!s.by_account || typeof s.by_account !== "object") return;
    const entries = Object.entries(s.by_account);
    if (entries.length > MAX_ACCOUNTS) return;
    by_account = {};
    for (const [account_id, value] of entries) {
      const u = parseUnavailable(value);
      if (!UUID.test(account_id) || !u) return;
      by_account[account_id] = u;
    }
  }
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
    ...(s.unavailable ? { unavailable: parseUnavailable(s.unavailable) } : {}),
    ...(by_account ? { by_account } : {}),
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

/** Unavailable after a turn that ended this way, if it is. */
function unavailableAfter(
  outcome: TurnOutcome | undefined,
  now: number,
): AgentUnavailable | undefined {
  const failure = outcome?.state === "failed" ? outcome.failure : undefined;
  if (failure?.kind === "limit")
    return failure.resets_at == null || failure.resets_at > now
      ? {
          reason: "limit",
          ...(failure.resets_at ? { until: failure.resets_at } : {}),
        }
      : undefined;
  if (failure?.kind === "sign-in") return { reason: "sign-in" };
  return undefined;
}

/** The status from a turn's outcome and what is running and waiting. With
 * `byAccount` (each account's latest turn), unavailability is per account. */
export function agentTurnStatusOf(opts: {
  running: number;
  queued: number;
  last?: { outcome?: TurnOutcome; at: number };
  byAccount?: Record<string, { outcome?: TurnOutcome; running?: number }>;
  now: number;
}): AgentTurnStatus {
  const outcome = opts.last?.outcome;
  const failure = outcome?.state === "failed" ? outcome.failure : undefined;
  let by_account: Record<string, AgentUnavailable> | undefined;
  if (opts.byAccount) {
    by_account = {};
    for (const [account_id, last] of Object.entries(opts.byAccount)) {
      // That account's own turn running now: it is not stuck on its failure
      // (another account's turn says nothing about it).
      if ((last.running ?? 0) > 0) continue;
      const u = unavailableAfter(last.outcome, opts.now);
      if (u) by_account[account_id] = u;
    }
  }
  const unavailable = opts.byAccount
    ? undefined
    : unavailableAfter(outcome, opts.now);
  return {
    version: 1,
    running: opts.running,
    queued: opts.queued,
    // A turn running now means it is not stuck on the last failure.
    ...(unavailable && opts.running === 0 ? { unavailable } : {}),
    ...(by_account && Object.keys(by_account).length ? { by_account } : {}),
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

/** The status as one account sees it: its own unavailability, and no
 * other account's. */
export function agentTurnStatusFor(
  status: AgentTurnStatus | undefined | null,
  account_id: string | undefined,
): AgentTurnStatus | undefined {
  if (!status) return undefined;
  if (!status.by_account) return status;
  const { by_account, unavailable: _shared, ...rest } = status;
  const own = account_id ? by_account[account_id] : undefined;
  return { ...rest, ...(own ? { unavailable: own } : {}) };
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
