/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Access and revocation state for the per-project content origin, read from
// the host's local copy of the project row.

import { getRow } from "@cocalc/lite/hub/sqlite/database";
import { isProjectCollaboratorGroup } from "@cocalc/conat/auth/subject-policy";
// Owners and collaborators read the whole project.  Viewers have restricted
// read policies, so they get no content access until capabilities carry the
// project-wide read floor.
export function hasProjectContentReadAccess({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): boolean {
  const row = getRow("projects", JSON.stringify({ project_id }));
  const entry = row?.users?.[account_id];
  const group = typeof entry === "string" ? entry : entry?.group;
  return isProjectCollaboratorGroup(group);
}

// Bumped by the hub to revoke every outstanding capability of a project.
export function projectContentEpoch(project_id: string): number {
  const row = getRow("projects", JSON.stringify({ project_id }));
  const epoch = row?.content_epoch;
  return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : 0;
}
