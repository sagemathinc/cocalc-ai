/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type {
  HostIntrusionReviewReport,
  LaunchHealthLevel,
} from "@cocalc/conat/hub/api/system";

const MAX_REVIEW_AGE_MS = 60 * 60 * 1000;

export function classifyHostIntrusionReviewHealth(
  report: HostIntrusionReviewReport,
): LaunchHealthLevel {
  if (
    report.reviewer.last_error_at != null ||
    report.notifications.failed > 0
  ) {
    return "critical";
  }
  if (
    report.reviewer.last_success_at == null ||
    report.reviewer.backlog > 1000 ||
    (report.reviewer.last_success_age_ms ?? 0) > MAX_REVIEW_AGE_MS
  ) {
    return "warning";
  }
  if (report.collector_coverage.overdue_hosts > 0) return "warning";
  if (
    report.collector_coverage.active_hosts > 0 &&
    report.collector_coverage.observed_hosts === 0
  )
    return "unknown";
  return "healthy";
}
