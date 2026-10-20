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
const MAX_REMEMBERED = 10_000;

type Thread = { project_id: string; path: string; thread_id: string };
type Reporter = (
  opts: Thread & { account_id: string; status: AgentTurnStatus },
) => Promise<{ registered: boolean }>;

let reporter: Reporter = (opts) => hubApi.agent.reportStatus(opts);
let lastSweep: number | undefined;
let sweeping = false;
const sent = new Map<string, AgentTurnStatus>();
// Not a registered agent when last asked: asked again once `until` passes,
// whether or not its jobs change (it may be registered meanwhile).
const unregistered = new Map<
  string,
  { thread: Thread & { account_id: string }; until: number }
>();

/** Tests only. */
export function setAgentStatusReporterForTests(next?: Reporter): void {
  reporter = next ?? ((opts) => hubApi.agent.reportStatus(opts));
  lastSweep = undefined;
  sent.clear();
  unregistered.clear();
}

/** The status of one conversation's agent, from its jobs. */
export function agentThreadStatus(
  thread: Thread,
  now = Date.now(),
): AgentTurnStatus {
  const { running, queued, last } = acpThreadJobSummary(thread);
  return agentTurnStatusOf({
    running,
    queued,
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
    // Due to be asked again: report even an unchanged status.
    const retry = new Set<string>();
    for (const [key, entry] of unregistered)
      if (entry.until <= now) {
        retry.add(key);
        if (!candidates.has(key)) candidates.set(key, entry.thread);
      }
    for (const [key, thread] of candidates) {
      // Only chats have registered agents.
      if (!thread.path.endsWith(".chat")) continue;
      if (!retry.has(key) && unregistered.has(key)) continue;
      const status = agentThreadStatus(thread, now);
      if (!retry.has(key) && sameAgentTurnStatus(sent.get(key), status))
        continue;
      try {
        const { registered } = await reporter({ ...thread, status });
        if (sent.size >= MAX_REMEMBERED) sent.clear();
        sent.set(key, status);
        if (!registered) {
          if (unregistered.size >= MAX_REMEMBERED) unregistered.clear();
          unregistered.set(key, {
            thread,
            until: now + UNREGISTERED_RECHECK_MS,
          });
        } else unregistered.delete(key);
      } catch (err) {
        // An older hub, or unreachable: the next change tries again.
        logger.debug("agent status not reported", { err: `${err}` });
      }
    }
  } finally {
    sweeping = false;
  }
}
