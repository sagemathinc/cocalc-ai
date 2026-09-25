/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { resolveEmailBackendForLane } from "@cocalc/util/notification-email";

export function getProjectRecoveryNotificationConfiguration(
  settings: Record<string, any> | undefined,
): {
  oncallAccountId: string;
  criticalEmailBackend: string;
  issues: string[];
} {
  const oncallAccountId =
    `${settings?.project_recovery_oncall_account_id ?? ""}`.trim();
  let criticalEmailBackend = "";
  let invalidBackend = false;
  if (settings) {
    try {
      criticalEmailBackend = resolveEmailBackendForLane(settings, "critical");
    } catch {
      invalidBackend = true;
    }
  }
  const issues: string[] = [];
  if (settings?.project_recovery_notifications_enabled === true) {
    if (!oncallAccountId) {
      issues.push("named on-call administrator is missing");
    }
    if (invalidBackend) {
      issues.push("critical email backend configuration is invalid");
    } else if (!criticalEmailBackend || criticalEmailBackend === "none") {
      issues.push("critical email backend is unavailable");
    }
  }
  return { oncallAccountId, criticalEmailBackend, issues };
}
