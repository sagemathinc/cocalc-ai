/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "@cocalc/database/pool";
import { transaction, boundedText } from "./collaborators-common";
import { assertCollaborationAccountAuthority } from "./collaborators-owner";
import type { CollaborationOwnerAuthority } from "./collaborators-owner";

export async function syncCollaborationRevisionInterestSchema(
  db: Pick<PoolClient, "query">,
) {
  await db.query(`CREATE TABLE IF NOT EXISTS collaboration_revision_interests (
    project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    home_bay_id TEXT NOT NULL, lease_id UUID NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL, renew_after TIMESTAMPTZ NOT NULL,
    PRIMARY KEY(project_id,home_bay_id))`);
  await db.query(`CREATE INDEX IF NOT EXISTS collaboration_revision_interests_expiry
    ON collaboration_revision_interests(expires_at,project_id,home_bay_id)`);
}

/** Internal owner-side prototype, not a public API. The caller must authenticate
 * the destination home bay and bind account_id to that home's active demand.
 * The owner rechecks membership; this hint never grants metadata access. A home
 * aggregates its consumers before renewing this single project/bay row.
 */
export async function registerCollaborationRevisionInterest(
  opts: { project_id: string; account_id: string; home_bay_id: string },
  authority: CollaborationOwnerAuthority,
) {
  boundedText(opts.home_bay_id, "interest home bay", 128);
  return transaction(async (db) => {
    await assertCollaborationAccountAuthority(
      db,
      opts.project_id,
      opts.account_id,
      authority,
    );
    const now = (
      await db.query("SELECT clock_timestamp() AS now")
    ).rows[0].now.getTime();
    let row = (
      await db.query(
        "SELECT * FROM collaboration_revision_interests WHERE project_id=$1 AND home_bay_id=$2",
        [opts.project_id, opts.home_bay_id],
      )
    ).rows[0];
    if (!row || row.renew_after.getTime() <= now) {
      const lease_id =
        row && row.expires_at.getTime() > now ? row.lease_id : randomUUID();
      row = (
        await db.query(
          `INSERT INTO collaboration_revision_interests(project_id,home_bay_id,lease_id,expires_at,renew_after)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT(project_id,home_bay_id) DO UPDATE SET
         lease_id=excluded.lease_id,expires_at=excluded.expires_at,renew_after=excluded.renew_after RETURNING *`,
          [
            opts.project_id,
            opts.home_bay_id,
            lease_id,
            new Date(now + 120000),
            new Date(now + 30000),
          ],
        )
      ).rows[0];
    }
    // Sample the catalog under the same project fence as registration. A later
    // change advances durable catalog state; it cannot fall before this boundary.
    const catalog = (
      await db.query(
        "SELECT generation,revision FROM collaboration_projects WHERE project_id=$1",
        [opts.project_id],
      )
    ).rows[0];
    return {
      lease_id: row.lease_id as string,
      expires_at: row.expires_at.getTime() as number,
      renew_after: row.renew_after.getTime() as number,
      watermark: catalog
        ? {
            generation: catalog.generation as string,
            revision: Number(catalog.revision),
          }
        : null,
    };
  });
}
