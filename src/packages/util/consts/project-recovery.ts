/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const PAYING_SNAPSHOT_INCIDENT_DELAY_MS = 2 * 60 * 60_000;
export const PAYING_BACKUP_INCIDENT_DELAY_MS = 12 * 60 * 60_000;

export function recoveryDelayExceeds(
  dueAt: string | null | undefined,
  thresholdMs: number,
  now = Date.now(),
): boolean {
  if (!dueAt) return false;
  const due = Date.parse(dueAt);
  return Number.isFinite(due) && now - due > thresholdMs;
}
