/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { LegacyMigrationProjectSummary } from "@cocalc/conat/hub/api/legacy-migration";

export function archiveAvailable(
  project: LegacyMigrationProjectSummary,
): boolean {
  return (
    project.artifact_status === "available" &&
    !!project.artifact_key &&
    typeof project.artifact_bytes === "number" &&
    Number.isFinite(project.artifact_bytes)
  );
}

// A failed restore into an already created project can be retried from the
// Legacy Projects page. The project banner also offers a retry, but it
// disappears once the user clicks "Accept and hide", which used to leave no
// way to try again.
export function restoreRetryAvailable(
  project: LegacyMigrationProjectSummary,
): boolean {
  return (
    !!project.project_id &&
    // The server only retries for the account that owns the import; another
    // linked account must Open (join) the project first.
    project.joined === true &&
    project.restore_status === "failed" &&
    archiveAvailable(project)
  );
}
