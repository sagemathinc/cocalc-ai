/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { LroSummary } from "@cocalc/conat/hub/api/lro";

// Leave a scheduled collection alone this close to its run time, since the
// worker may already be starting it.
export const AUTO_COLLECT_REFRESH_MARGIN_MS = 60_000;

// A scheduled collection fixes the student projects it collects from when it
// is scheduled, so students who receive the assignment afterwards would be
// skipped (support #20954). Returns the eligible students a still-queued
// scheduled collection is missing, or [] when it needs no change.
export function autoCollectMissingStudents({
  summary,
  runAt,
  eligibleStudentIds,
  now = Date.now(),
}: {
  summary?: Pick<LroSummary, "status" | "input"> | null;
  runAt?: string | null;
  eligibleStudentIds: string[];
  now?: number;
}): string[] {
  if (summary?.status !== "queued" || !runAt) return [];
  const runTime = new Date(runAt).getTime();
  if (
    !Number.isFinite(runTime) ||
    runTime - now <= AUTO_COLLECT_REFRESH_MARGIN_MS
  ) {
    return [];
  }
  const items = Array.isArray(summary.input?.items) ? summary.input.items : [];
  const scheduled = new Set(items.map((item: any) => item?.student_id));
  return eligibleStudentIds.filter((id) => !scheduled.has(id));
}
