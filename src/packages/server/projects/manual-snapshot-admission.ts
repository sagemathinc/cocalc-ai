/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { ConatError } from "@cocalc/conat/core/client";
import {
  DEFAULT_SNAPSHOT_COUNTS,
  type SnapshotSchedule,
} from "@cocalc/util/consts/snapshots";
import { isISODate } from "@cocalc/util/misc";

export interface ManualSnapshotQuota {
  limit: number;
  current: number;
  rolling_reserved: number;
}

const SNAPSHOT_COUNT_KEYS = ["frequent", "daily", "weekly", "monthly"] as const;

function nonNegativeInteger(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function rollingSnapshotReservedSlots(
  schedule?: Partial<SnapshotSchedule> | null,
): number {
  if (schedule?.disabled) {
    return 0;
  }
  const counts = { ...DEFAULT_SNAPSHOT_COUNTS, ...(schedule ?? {}) };
  return SNAPSHOT_COUNT_KEYS.reduce(
    (total, key) => total + nonNegativeInteger(counts[key]),
    0,
  );
}

export function normalizeManualSnapshotName(name?: string): string {
  const trimmed = `${name ?? ""}`.trim();
  const candidate = trimmed || `manual-${new Date().toISOString()}`;
  return isISODate(candidate) ? `manual-${candidate}` : candidate;
}

export function manualSnapshotQuota({
  totalLimit,
  schedule,
  snapshotNames,
}: {
  totalLimit: number;
  schedule?: Partial<SnapshotSchedule> | null;
  snapshotNames: string[];
}): ManualSnapshotQuota {
  const rolling_reserved = rollingSnapshotReservedSlots(schedule);
  const limit = Math.max(0, nonNegativeInteger(totalLimit) - rolling_reserved);
  const current = snapshotNames.filter((name) => !isISODate(name)).length;
  return { limit, current, rolling_reserved };
}

export function assertManualSnapshotCreateAllowed({
  totalLimit,
  schedule,
  snapshotNames,
}: {
  totalLimit: number;
  schedule?: Partial<SnapshotSchedule> | null;
  snapshotNames: string[];
}): ManualSnapshotQuota {
  const quota = manualSnapshotQuota({ totalLimit, schedule, snapshotNames });
  if (quota.current >= quota.limit) {
    throw new ConatError(
      "Manual snapshot limit reached. Delete a named snapshot or ask the owner to increase the snapshot limit.",
      { code: "manual_snapshot_limit_reached" },
    );
  }
  return quota;
}
