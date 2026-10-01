/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { transaction } from "@cocalc/database/postgres/collaborators/collaborators-common";
import {
  assertCollaborationOwnerAuthority,
  type CollaborationOwnerAuthority,
} from "@cocalc/database/postgres/collaborators/collaborators-owner";
import { computeHostOperationalAvailability } from "@cocalc/server/conat/api/hosts-normalization";

/** Exact admission check in the project's owner bay; never starts compute. */
export async function readScanEligibleProject(
  project_id: string,
  account_id: string,
  authority: CollaborationOwnerAuthority,
): Promise<{ project_id: string; title: string } | null> {
  return transaction(async (db) => {
    await assertCollaborationOwnerAuthority(db, project_id, authority);
    const row = (
      await db.query(
        `SELECT p.project_id,p.title,p.users,p.deleted,p.archived_at,p.state,
          h.id,h.status,h.last_seen,h.metadata,h.deleted AS host_deleted
         FROM projects p LEFT JOIN project_hosts h ON h.id=p.host_id
           AND COALESCE(NULLIF(BTRIM(h.bay_id),''),$2)=$2
         WHERE p.project_id=$1`,
        [project_id, authority.owning_bay_id],
      )
    ).rows[0];
    if (
      !row ||
      row.deleted ||
      row.archived_at ||
      row.state?.state === "archived" ||
      !["owner", "collaborator"].includes(row.users?.[account_id]?.group) ||
      !row.id ||
      !computeHostOperationalAvailability(
        { ...row, deleted: row.host_deleted },
        {
          includeSyntheticProbe: false,
        },
      ).operational
    )
      return null;
    return {
      project_id: row.project_id,
      title: row.title?.trim() || "Untitled project",
    };
  });
}
