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
// The state is in memory: a restart forgets deferrals, which only restarts
// the bound.

import getLogger from "@cocalc/backend/logger";

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
  deferred: number;
  forced: number;
  pending_projects: number;
}

const firstDeferredAt = new Map<string, number>();
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
  if (first != null && deferredForMs >= maxDeferralMs) {
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

export function getSnapshotPruneGateStats(): SnapshotPruneGateStats {
  return {
    deferred: deferredCount,
    forced: forcedCount,
    pending_projects: firstDeferredAt.size,
  };
}

export function resetSnapshotPruneGateForTest(): void {
  firstDeferredAt.clear();
  deferredCount = 0;
  forcedCount = 0;
}
