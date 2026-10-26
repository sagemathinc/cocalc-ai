/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// When a rolling snapshot may delete its expired snapshots.
//
// Deleting snapshots only reclaims space, but on a busy host a long prune
// that overlaps a backup and a project start makes the start slow: in prod on
// 2026-10-26, 9 of 29 starts that overlapped both took over 12 s, against 0 of
// 138 that overlapped neither. So a prune waits while a backup runs on the
// host or a project start/stop is in progress, but never longer than
// MAX_DEFERRAL_MS for a project, so expired snapshots are still deleted.
//
// The scheduler may not visit a project again for a day (unchanged content,
// sparse schedules), so the gate keeps its own list of projects with a
// deferred prune and retries them every minute (startDeferredPruneLoop): the
// bound is wall time. The state is in memory: a restart forgets deferrals;
// the next scheduled snapshot of each project prunes again.

import getLogger from "@cocalc/backend/logger";
import type { SnapshotCounts } from "@cocalc/util/db-schema/projects";

const logger = getLogger("project-host:snapshot-prune-gate");

export const DEFAULT_MAX_PRUNE_DEFERRAL_MS = 60 * 60 * 1000;

export type SnapshotPruneDecision =
  | { allow: true; reason: "idle" | "deferral_bound"; deferredForMs: number }
  | {
      allow: false;
      reason: "backup_running" | "lifecycle_active";
      deferredForMs: number;
    };

export interface SnapshotPruneGateStats {
  /** Prunes deferred, and run anyway at the bound, since start. */
  deferred: number;
  forced: number;
  /** Projects with a deferred prune waiting for the retry. */
  pending_projects: number;
}

const firstDeferredAt = new Map<string, number>();
// Projects whose prune was deferred, with what the retry needs.
const pendingPrunes = new Map<string, PendingPrune>();
// Projects whose snapshot-limit prune was deferred: when their full update
// is due again. Kept here because the bay sees a fresh snapshot (when one
// was created) and would otherwise not consider the project due for a day.
const limitRetries = new Map<string, number>();

export interface PendingPrune {
  /** The retention the deferred prune was computed with. */
  counts: Partial<SnapshotCounts>;
  /** The scheduled snapshot's assignment check, run right before deleting;
   * returns a reason if the host no longer owns the project or its schedule
   * changed (a content change alone doesn't stop a prune). */
  validate: () => Promise<string | undefined>;
}
let deferredCount = 0;
let forcedCount = 0;

export function maxPruneDeferralMs(
  value = process.env.COCALC_PROJECT_HOST_SNAPSHOT_PRUNE_MAX_DEFERRAL_MS,
): number {
  const parsed = Number(value);
  return value != null && value !== "" && Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_MAX_PRUNE_DEFERRAL_MS;
}

/** Decide, and remember, whether this project's prune may run now. */
export function decideSnapshotPrune({
  projectId,
  backupsInFlight,
  lifecycleActive,
  now = Date.now(),
  maxDeferralMs = maxPruneDeferralMs(),
}: {
  projectId: string;
  backupsInFlight: number;
  lifecycleActive: number;
  now?: number;
  maxDeferralMs?: number;
}): SnapshotPruneDecision {
  const first = firstDeferredAt.get(projectId);
  const deferredForMs = first == null ? 0 : Math.max(0, now - first);
  const busy =
    backupsInFlight > 0
      ? ("backup_running" as const)
      : lifecycleActive > 0
        ? ("lifecycle_active" as const)
        : undefined;
  if (busy == null) {
    firstDeferredAt.delete(projectId);
    return { allow: true, reason: "idle", deferredForMs };
  }
  // A bound of 0 turns deferral off.
  if (maxDeferralMs <= 0 || (first != null && deferredForMs >= maxDeferralMs)) {
    firstDeferredAt.delete(projectId);
    forcedCount += 1;
    logger.info("pruning snapshots after the deferral bound", {
      project_id: projectId,
      deferred_for_ms: deferredForMs,
      busy,
    });
    return { allow: true, reason: "deferral_bound", deferredForMs };
  }
  if (first == null) firstDeferredAt.set(projectId, now);
  deferredCount += 1;
  logger.info("deferring snapshot prune", {
    project_id: projectId,
    reason: busy,
    backups_in_flight: backupsInFlight,
    lifecycle_active: lifecycleActive,
    deferred_for_ms: deferredForMs,
  });
  return { allow: false, reason: busy, deferredForMs };
}

/** Remember a project whose prune was deferred, so the loop retries it. */
export function notePendingPrune(
  projectId: string,
  pending: PendingPrune,
): void {
  pendingPrunes.set(projectId, pending);
}

/** Forget a pending background retry but keep the deferral's start, so the
 * bound keeps counting (a limit deferral, retried as a full update, must
 * not be restarted by a rolling-only retry that deletes nothing). */
export function dropPendingPruneRetry(projectId: string): void {
  pendingPrunes.delete(projectId);
}

/** A scheduled snapshot pruned (or the project went away): no retry needed. */
export function clearPendingPrune(projectId: string): void {
  pendingPrunes.delete(projectId);
  limitRetries.delete(projectId);
  firstDeferredAt.delete(projectId);
}

/** The snapshot limit couldn't be applied: run the full update again at
 * `at` (the scheduler treats the project as due then). */
export function noteLimitRetry(projectId: string, at: number): void {
  limitRetries.set(projectId, at);
}

/** The full update applied the limit: the project is no longer due for it. */
export function clearLimitRetry(projectId: string): void {
  limitRetries.delete(projectId);
}

export function limitRetryAt(projectId: string): number | undefined {
  return limitRetries.get(projectId);
}

export const DEFERRED_PRUNE_RETRY_MS = 60_000;

/** One pass over the deferred prunes: each runs once the gate allows it (the
 * host is quiet, or its bound is up). A failed run stays pending for the
 * next pass. */
export async function retryDeferredPrunes({
  prune,
  busy,
  now = Date.now,
  maxDeferralMs = maxPruneDeferralMs(),
}: {
  prune: (projectId: string, pending: PendingPrune) => Promise<void>;
  busy: () => { backupsInFlight: number; lifecycleActive: number };
  now?: () => number;
  maxDeferralMs?: number;
}): Promise<{ pruned: string[]; waiting: number }> {
  const pruned: string[] = [];
  for (const [projectId, pending] of [...pendingPrunes]) {
    const decision = decideSnapshotPrune({
      projectId,
      ...busy(),
      now: now(),
      maxDeferralMs,
    });
    if (!decision.allow) continue;
    try {
      await prune(projectId, pending);
      // Only if nothing newer replaced it meanwhile.
      if (pendingPrunes.get(projectId) === pending) {
        pendingPrunes.delete(projectId);
      }
      pruned.push(projectId);
    } catch (err) {
      // Keep it, with its original deferral start: the bound has passed or
      // the host is quiet, so the next pass tries again (storage admission
      // still decides when it may run).
      firstDeferredAt.set(projectId, now() - decision.deferredForMs);
      logger.warn("deferred snapshot prune failed; will retry", {
        project_id: projectId,
        err: `${err}`.slice(0, 200),
      });
    }
  }
  return { pruned, waiting: pendingPrunes.size };
}

let loop: ReturnType<typeof setInterval> | undefined;
let looping = false;

/** Start (once) the background retry of deferred prunes. */
export function startDeferredPruneLoop(
  opts: Parameters<typeof retryDeferredPrunes>[0],
  intervalMs = DEFERRED_PRUNE_RETRY_MS,
): void {
  if (loop != null) return;
  loop = setInterval(() => {
    if (looping || pendingPrunes.size === 0) return;
    looping = true;
    void retryDeferredPrunes(opts)
      .catch((err) =>
        logger.warn("deferred snapshot prune pass failed", { err }),
      )
      .finally(() => {
        looping = false;
      });
  }, intervalMs);
  loop.unref?.();
}

export function stopDeferredPruneLoop(): void {
  if (loop != null) clearInterval(loop);
  loop = undefined;
}

export function getSnapshotPruneGateStats(): SnapshotPruneGateStats {
  return {
    deferred: deferredCount,
    forced: forcedCount,
    pending_projects: pendingPrunes.size,
  };
}

export function resetSnapshotPruneGateForTest(): void {
  firstDeferredAt.clear();
  pendingPrunes.clear();
  limitRetries.clear();
  deferredCount = 0;
  forcedCount = 0;
  if (loop != null) clearInterval(loop);
  loop = undefined;
  looping = false;
}
