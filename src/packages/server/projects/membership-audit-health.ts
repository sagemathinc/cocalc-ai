/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Admin health for the project membership audit
// (database/postgres/schema/project-membership-audit.ts): it fails open, so a
// broken audit must show up here instead of going unnoticed.

import type { LaunchHealthLevel } from "@cocalc/conat/hub/api/system";
import getPool from "@cocalc/database/pool";
import {
  getProjectMembershipAuditStatus,
  type ProjectMembershipAuditStatus,
} from "@cocalc/database/postgres/schema/project-membership-audit";

export async function getProjectMembershipAuditHealthStatus(): Promise<ProjectMembershipAuditStatus> {
  return await getProjectMembershipAuditStatus(getPool());
}

export function projectMembershipAuditHealth(
  status: ProjectMembershipAuditStatus,
): { level: LaunchHealthLevel; summary: string; details: string[] } {
  const details: string[] = [];
  if (status.recent_failures > 0) {
    details.push(
      `${status.recent_failures} membership change(s) in the last 7 days were not recorded; last at ${status.last_failed_at?.toISOString?.() ?? status.last_failed_at}: ${status.last_error ?? "unknown error"}`,
    );
  }
  switch (status.state) {
    case "missing":
      return {
        level: "critical",
        summary:
          "The project membership audit trigger is missing: collaborator additions are not recorded. Schema sync at bay start reinstalls it.",
        details,
      };
    case "disabled":
      return {
        level: "critical",
        summary:
          "The project membership audit trigger is disabled: collaborator additions are not recorded.",
        details,
      };
    case "outdated":
      return {
        level: "warning",
        summary:
          "The project membership audit trigger is out of date; schema sync at bay start replaces it.",
        details,
      };
  }
  if (status.recent_failures > 0) {
    return {
      level: "warning",
      summary: "Some collaborator additions could not be recorded recently.",
      details,
    };
  }
  return {
    level: "healthy",
    summary: "Collaborator additions and role changes are being recorded.",
    details,
  };
}
