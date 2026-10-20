/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Tells the hub what each agent on this host is doing (busy, waiting,
// unavailable until a limit resets), so the agents that may message it and
// its owner's lists see it. A periodic sweep over the conversations whose
// jobs changed, rather than a hook on every job transition: it misses none
// of them, and sends a status only when it differs from the last one sent.

import {
  agentTurnStatusOf,
  sameAgentTurnStatus,
  type AgentTurnStatus,
} from "@cocalc/conat/agents/agent-status";
import { parseTurnOutcome } from "@cocalc/conat/ai/acp/turn-outcome";
import getLogger from "@cocalc/backend/logger";
import { hubApi } from "../api";
import {
  acpThreadJobSummary,
  listAcpThreadsChangedSince,
} from "../sqlite/acp-jobs";

const logger = getLogger("lite:hub:acp:agent-status-report");

/** A conversation that isn't a registered agent is asked about again after
 * this long (it may be registered later). */
const UNREGISTERED_RECHECK_MS = 60 * 60_000;
/** Overlap between sweeps, for jobs updated as the last one ran. */
const SWEEP_OVERLAP_MS = 5_000;
/** On start, what changed this recently is reported again. */
const FIRST_SWEEP_LOOKBACK_MS = 10 * 60_000;
/** ...and, further back, a status that still says something (an agent
 * blocked on its sign-in for days), so its refresh starts again too. */
const FIRST_SWEEP_STILL_TRUE_MS = 7 * 24 * 60 * 60_000;
const MAX_REMEMBERED = 10_000;
/** A report that failed (hub unreachable) is tried again after this,
 * doubling each time up to the cap, at most this many times. */
const FAILED_RETRY_MS = 30_000;
const FAILED_RETRY_MAX_MS = 10 * 60_000;
const FAILED_RETRY_ATTEMPTS = 10;
/** An unchanged status that still says something (busy, unavailable) is
 * sent again this often, so it never outlives its TTL while still true. */
export const STATUS_REFRESH_MS = 6 * 60 * 60_000;

type Thread = { project_id: string; path: string; thread_id: string };
type Reporter = (
  opts: Thread & { account_id: string; status: AgentTurnStatus },
) => Promise<{ registered: boolean }>;

let reporter: Reporter = (opts) => hubApi.agent.reportStatus(opts);
let lastSweep: number | undefined;
let sweeping = false;
const sent = new Map<
  string,
  { status: AgentTurnStatus; thread: Thread & { account_id: string } }
>();
// Not a registered agent when last asked: asked again once `until` passes,
// whether or not its jobs change (it may be registered meanwhile).
const unregistered = new Map<
  string,
  { thread: Thread & { account_id: string }; until: number }
>();

// Not reported because the hub did not answer: tried again when due, even
// if its jobs never change again (a turn that ended at a limit may not).
const failed = new Map<
  string,
  { thread: Thread & { account_id: string }; until: number; attempts: number }
>();

/** Tests only. */
export function setAgentStatusReporterForTests(next?: Reporter): void {
  reporter = next ?? ((opts) => hubApi.agent.reportStatus(opts));
  lastSweep = undefined;
  sent.clear();
  unregistered.clear();
  failed.clear();
}

/** Set, evicting only the oldest entry at the cap (never all of them, or
 * every scheduled recheck would be lost at once). */
export function remember<V>(
  map: Map<string, V>,
  key: string,
  value: V,
  cap = MAX_REMEMBERED,
): void {
  map.delete(key);
  if (map.size >= cap) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/** Busy, or unavailable for someone: worth keeping fresh. */
function saysSomething(status: AgentTurnStatus): boolean {
  return Boolean(
    status.unavailable ||
    status.by_account ||
    status.running > 0 ||
    status.queued > 0,
  );
}

/** The status of one conversation's agent, from its jobs. */
export function agentThreadStatus(
  thread: Thread,
  now = Date.now(),
): AgentTurnStatus {
  const { running, queued, last, lastByAccount, runningByAccount } =
    acpThreadJobSummary(thread);
  return agentTurnStatusOf({
    running,
    queued,
    byAccount: Object.fromEntries(
      Object.entries(lastByAccount).map(([account_id, job]) => [
        account_id,
        {
          outcome: parseTurnOutcome(job.outcome_json),
          running: runningByAccount[account_id] ?? 0,
        },
      ]),
    ),
    ...(last
      ? {
          last: {
            outcome: parseTurnOutcome(last.outcome_json),
            at: last.finished_at ?? last.updated_at,
          },
        }
      : {}),
    now,
  });
}

/** Report every conversation whose jobs changed since the last sweep. */
export async function sweepAgentStatus(now = Date.now()): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const since =
      lastSweep == null
        ? now - FIRST_SWEEP_LOOKBACK_MS
        : lastSweep - SWEEP_OVERLAP_MS;
    lastSweep = now;
    const keyOf = (thread: Thread) =>
      JSON.stringify([thread.project_id, thread.path, thread.thread_id]);
    const candidates = new Map<string, Thread & { account_id: string }>();
    for (const thread of listAcpThreadsChangedSince(since))
      candidates.set(keyOf(thread), thread);
    // After a restart (nothing sent yet): older conversations whose status
    // still says something, sent only if it does.
    const onlyIfTrue = new Set<string>();
    if (since === now - FIRST_SWEEP_LOOKBACK_MS)
      for (const thread of listAcpThreadsChangedSince(
        now - FIRST_SWEEP_STILL_TRUE_MS,
      )) {
        const key = keyOf(thread);
        if (candidates.has(key)) continue;
        candidates.set(key, thread);
        onlyIfTrue.add(key);
      }
    // Due to be asked again: report even an unchanged status.
    const retry = new Set<string>();
    // A failed report waits out its backoff, whatever else is due.
    const backingOff = (key: string) => (failed.get(key)?.until ?? 0) > now;
    for (const [key, entry] of unregistered)
      if (entry.until <= now && !backingOff(key)) {
        retry.add(key);
        if (!candidates.has(key)) candidates.set(key, entry.thread);
      }
    // Still true, but getting old: sent again before it expires.
    for (const [key, { status, thread }] of sent)
      if (
        saysSomething(status) &&
        now - status.at >= STATUS_REFRESH_MS &&
        !unregistered.has(key) &&
        !backingOff(key)
      ) {
        retry.add(key);
        if (!candidates.has(key)) candidates.set(key, thread);
      }
    // Its last report failed, so `sent` still differs: it is sent once due.
    for (const [key, entry] of failed) {
      if (candidates.has(key)) continue;
      if (entry.until <= now) candidates.set(key, entry.thread);
    }
    for (const [key, thread] of candidates) {
      // Only chats have registered agents.
      if (!thread.path.endsWith(".chat")) continue;
      if (!retry.has(key) && unregistered.has(key)) continue;
      const status = agentThreadStatus(thread, now);
      if (onlyIfTrue.has(key) && !saysSomething(status)) continue;
      if (!retry.has(key) && sameAgentTurnStatus(sent.get(key)?.status, status))
        continue;
      try {
        const { registered } = await reporter({ ...thread, status });
        failed.delete(key);
        remember(sent, key, { status, thread });
        if (!registered) {
          remember(unregistered, key, {
            thread,
            until: now + UNREGISTERED_RECHECK_MS,
          });
        } else unregistered.delete(key);
      } catch (err) {
        // Unreachable (or an older hub): tried again with backoff, and on
        // the next change.
        logger.debug("agent status not reported", { err: `${err}` });
        const attempts = (failed.get(key)?.attempts ?? 0) + 1;
        if (attempts > FAILED_RETRY_ATTEMPTS) {
          failed.delete(key);
          // Given up for now: what made it due waits its own interval
          // again (else the next sweep would start the retries over).
          const recheck = unregistered.get(key);
          if (recheck) recheck.until = now + UNREGISTERED_RECHECK_MS;
          const last = sent.get(key);
          if (last)
            sent.set(key, { ...last, status: { ...last.status, at: now } });
        } else {
          remember(failed, key, {
            thread,
            attempts,
            until:
              now +
              Math.min(
                FAILED_RETRY_MS * 2 ** (attempts - 1),
                FAILED_RETRY_MAX_MS,
              ),
          });
        }
      }
    }
  } finally {
    sweeping = false;
  }
}
