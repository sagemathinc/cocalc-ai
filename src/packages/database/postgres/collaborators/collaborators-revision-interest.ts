/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "@cocalc/database/pool";
import {
  transaction,
  boundedText,
  uuid,
  integer,
} from "./collaborators-common";
import {
  assertCollaborationAccountAuthority,
  assertCollaborationOwnerAuthority,
} from "./collaborators-owner";
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
  await db.query(`CREATE INDEX IF NOT EXISTS collaboration_revision_interests_project_expiry
    ON collaboration_revision_interests(project_id,expires_at,home_bay_id)`);
  await db.query(`ALTER TABLE collaboration_revision_interests
    ADD COLUMN IF NOT EXISTS ack_generation UUID,
    ADD COLUMN IF NOT EXISTS ack_revision BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS delivery_claim UUID,
    ADD COLUMN IF NOT EXISTS delivery_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS delivery_generation UUID,
    ADD COLUMN IF NOT EXISTS delivery_revision BIGINT`);
}

/** Internal owner-side registration, not a public API. The caller must authenticate
 * the destination home bay and bind account_id to that home's active demand.
 * The owner rechecks membership; this hint never grants metadata access. A home
 * aggregates its consumers before renewing this single project/bay row.
 * ttl_ms is the verified remaining demand duration after RPC elapsed time,
 * not a wall-clock timestamp from another bay. Deduct local fence wait too.
 */
export async function registerCollaborationRevisionInterest(
  opts: {
    project_id: string;
    account_id: string;
    home_bay_id: string;
    ttl_ms: number;
  },
  authority: CollaborationOwnerAuthority,
) {
  boundedText(opts.home_bay_id, "interest home bay", 128);
  if (!Number.isFinite(opts.ttl_ms) || opts.ttl_ms <= 0)
    throw Error("project has no home demand");
  const started = performance.now();
  return transaction(async (db) => {
    await assertCollaborationAccountAuthority(
      db,
      opts.project_id,
      opts.account_id,
      authority,
    );
    const sampled = performance.now();
    const now = (
      await db.query("SELECT clock_timestamp() AS now")
    ).rows[0].now.getTime();
    const remaining = Math.min(
      120000,
      opts.ttl_ms - (performance.now() - started),
    );
    if (remaining <= 0) throw Error("project has no home demand");
    let row = (
      await db.query(
        "SELECT * FROM collaboration_revision_interests WHERE project_id=$1 AND home_bay_id=$2",
        [opts.project_id, opts.home_bay_id],
      )
    ).rows[0];
    if (
      !row ||
      row.expires_at.getTime() <= now ||
      row.renew_after.getTime() <= now
    ) {
      // A delayed release must not erase a subsequently renewed interest.
      const lease_id = randomUUID();
      row = (
        await db.query(
          `INSERT INTO collaboration_revision_interests(project_id,home_bay_id,lease_id,expires_at,renew_after)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT(project_id,home_bay_id) DO UPDATE SET
         lease_id=excluded.lease_id,expires_at=excluded.expires_at,renew_after=excluded.renew_after,
         delivery_claim=NULL,delivery_until=NULL,delivery_generation=NULL,delivery_revision=NULL,
         ack_generation=CASE WHEN collaboration_revision_interests.expires_at<=$6 THEN NULL ELSE collaboration_revision_interests.ack_generation END,
         ack_revision=CASE WHEN collaboration_revision_interests.expires_at<=$6 THEN 0 ELSE collaboration_revision_interests.ack_revision END RETURNING *`,
          [
            opts.project_id,
            opts.home_bay_id,
            lease_id,
            new Date(Math.max(row?.expires_at.getTime() ?? 0, now + remaining)),
            new Date(now + Math.min(30000, remaining)),
            new Date(now),
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
      remaining_ms: Math.max(
        0,
        row.expires_at.getTime() - now - (performance.now() - sampled),
      ),
      watermark: catalog
        ? {
            generation: catalog.generation as string,
            revision: Number(catalog.revision),
          }
        : null,
    };
  });
}

type InterestLookup = {
  project_id: string;
  account_id: string;
  home_bay_id: string;
  lease_id: string;
};

type FanoutLease = {
  project_id: string;
  home_bay_id: string;
  lease_id: string;
};

export type RevisionDispatchCursor = Pick<
  FanoutLease,
  "project_id" | "home_bay_id"
>;

/** Bounded repair traversal over interest state, not historical memberships.
 * The subsequent claim rechecks ownership, expiry and the current watermark.
 */
export async function readCollaborationRevisionDispatchPage(
  owning_bay_id: string,
  after?: RevisionDispatchCursor,
) {
  boundedText(owning_bay_id, "revision owner", 128);
  if (after) {
    uuid(after.project_id, "revision dispatch cursor");
    boundedText(after.home_bay_id, "revision home cursor", 128);
  }
  return transaction(async (db) => {
    await db.query("SET LOCAL statement_timeout='2s'");
    const { rows } = await db.query(
      `WITH candidates AS MATERIALIZED (
        SELECT * FROM collaboration_revision_interests
        ${after ? "WHERE (project_id,home_bay_id)>($2::uuid,$3::text)" : ""}
        ORDER BY project_id,home_bay_id LIMIT 20)
      SELECT i.project_id,i.home_bay_id,i.lease_id,
        (p.owning_bay_id=$1 AND i.expires_at>now()
        AND (i.delivery_until IS NULL OR i.delivery_until<=now())
        AND (i.ack_generation IS DISTINCT FROM c.generation OR i.ack_revision<c.revision)
        AND c.project_id IS NOT NULL) AS pending
      FROM candidates i LEFT JOIN projects p USING(project_id)
      LEFT JOIN collaboration_projects c USING(project_id)
      ORDER BY i.project_id,i.home_bay_id`,
      after
        ? [owning_bay_id, after.project_id, after.home_bay_id]
        : [owning_bay_id],
    );
    return {
      complete: rows.length < 20,
      candidates: rows.map((r) => ({
        project_id: r.project_id as string,
        home_bay_id: r.home_bay_id as string,
        lease_id: r.lease_id as string,
        pending: r.pending === true,
      })),
    };
  });
}

/** Durable worker claim, not proof of delivery or authorization to fetch data.
 * Unknown transport outcomes leave the claim intact until expiry. The next
 * claim samples the current catalog, coalescing changes during the retry wait.
 */
export async function claimCollaborationRevisionHint(
  opts: FanoutLease,
  authority: CollaborationOwnerAuthority,
) {
  boundedText(opts.home_bay_id, "interest home bay", 128);
  uuid(opts.lease_id, "interest lease");
  return transaction(async (db) => {
    await db.query("SET LOCAL lock_timeout='1s'");
    await db.query("SET LOCAL statement_timeout='2s'");
    await assertCollaborationOwnerAuthority(db, opts.project_id, authority);
    const claim_id = randomUUID();
    const { rows } = await db.query(
      `WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS t)
       UPDATE collaboration_revision_interests i SET delivery_claim=$4,
       delivery_generation=c.generation,delivery_revision=c.revision,
       delivery_until=LEAST(i.expires_at,clock.t+interval '15 seconds')
       FROM collaboration_projects c,clock
       WHERE c.project_id=i.project_id AND i.project_id=$1 AND i.home_bay_id=$2
       AND i.lease_id=$3 AND i.expires_at>clock.t
       AND (i.delivery_until IS NULL OR i.delivery_until<=clock.t)
       AND (i.ack_generation IS DISTINCT FROM c.generation OR i.ack_revision<c.revision)
       RETURNING c.generation,c.revision,i.delivery_until`,
      [opts.project_id, opts.home_bay_id, opts.lease_id, claim_id],
    );
    return rows.length
      ? {
          project_id: opts.project_id,
          home_bay_id: opts.home_bay_id,
          lease_id: opts.lease_id,
          claim_id,
          generation: rows[0].generation as string,
          revision: Number(rows[0].revision),
          claim_until: rows[0].delivery_until.getTime() as number,
        }
      : null;
  });
}

/** Settle only after the destination home durably accepted this wakeup.
 * A stale worker cannot settle a replacement claim, lease or catalog generation.
 */
export async function settleCollaborationRevisionHint(
  opts: FanoutLease & {
    claim_id: string;
    generation: string;
    revision: number;
  },
  authority: CollaborationOwnerAuthority,
): Promise<boolean> {
  boundedText(opts.home_bay_id, "interest home bay", 128);
  uuid(opts.lease_id, "interest lease");
  uuid(opts.claim_id, "delivery claim");
  uuid(opts.generation, "catalog generation");
  integer(opts.revision, "catalog revision");
  return transaction(async (db) => {
    await db.query("SET LOCAL lock_timeout='1s'");
    await db.query("SET LOCAL statement_timeout='2s'");
    await assertCollaborationOwnerAuthority(db, opts.project_id, authority);
    const { rows } = await db.query(
      `UPDATE collaboration_revision_interests i SET ack_generation=$5,
       ack_revision=CASE WHEN i.ack_generation=$5 THEN GREATEST(i.ack_revision,$6) ELSE $6 END,
       delivery_claim=NULL,delivery_until=NULL,delivery_generation=NULL,delivery_revision=NULL
       FROM collaboration_projects c WHERE c.project_id=i.project_id
       AND i.project_id=$1 AND i.home_bay_id=$2 AND i.lease_id=$3 AND i.delivery_claim=$4
       AND i.delivery_generation=$5 AND i.delivery_revision=$6
       AND i.expires_at>clock_timestamp() AND i.delivery_until>clock_timestamp()
       AND c.generation=$5 AND c.revision>=$6 RETURNING i.lease_id`,
      [
        opts.project_id,
        opts.home_bay_id,
        opts.lease_id,
        opts.claim_id,
        opts.generation,
        opts.revision,
      ],
    );
    return rows.length > 0;
  });
}

/** Internal owner worker page. Limit candidate rows BEFORE filtering pending
 * hints so an idle/expired population cannot turn one page into a full scan.
 * A sweep is not a snapshot: later revisions/registrations require another
 * bounded sweep. Delivery must revalidate the exact lease before sending.
 */
export async function readCollaborationRevisionFanoutPage(
  opts: { project_id: string; after_home_bay_id?: string },
  authority: CollaborationOwnerAuthority,
) {
  const after = opts.after_home_bay_id ?? "";
  boundedText(after, "interest cursor", 128, true);
  return transaction(async (db) => {
    await db.query("SET LOCAL lock_timeout='1s'");
    await db.query("SET LOCAL statement_timeout='2s'");
    await assertCollaborationOwnerAuthority(db, opts.project_id, authority);
    const { rows } = await db.query(
      `SELECT home_bay_id,lease_id,expires_at,ack_generation,ack_revision
       FROM collaboration_revision_interests WHERE project_id=$1 AND home_bay_id>$2
       ORDER BY home_bay_id LIMIT 20`,
      [opts.project_id, after],
    );
    const { rows: catalogs } = await db.query(
      "SELECT generation,revision,clock_timestamp() AS now FROM collaboration_projects WHERE project_id=$1",
      [opts.project_id],
    );
    const catalog = catalogs[0];
    return {
      next_after: rows.length === 20 ? (rows[19].home_bay_id as string) : null,
      examined: rows.length,
      hints: rows
        .filter(
          (row) =>
            catalog &&
            row.expires_at.getTime() > catalog.now.getTime() &&
            (row.ack_generation !== catalog.generation ||
              Number(row.ack_revision) < Number(catalog.revision)),
        )
        .map((row) => ({
          project_id: opts.project_id,
          home_bay_id: row.home_bay_id as string,
          lease_id: row.lease_id as string,
          expires_at: row.expires_at.getTime() as number,
          generation: catalog.generation as string,
          revision: Number(catalog.revision),
        })),
    };
  });
}

/** Read-only coalesced wakeup, not a delta or an access grant. Registration's
 * authenticated-home binding applies here too. No expiry or renewal mutation.
 */
export async function readCollaborationRevisionHint(
  opts: InterestLookup,
  authority: CollaborationOwnerAuthority,
) {
  boundedText(opts.home_bay_id, "interest home bay", 128);
  uuid(opts.lease_id, "interest lease");
  return transaction(async (db) => {
    await assertCollaborationAccountAuthority(
      db,
      opts.project_id,
      opts.account_id,
      authority,
    );
    const row = (
      await db.query(
        `SELECT c.generation,c.revision FROM collaboration_revision_interests i
       JOIN collaboration_projects c USING(project_id)
       WHERE i.project_id=$1 AND i.home_bay_id=$2 AND i.lease_id=$3 AND i.expires_at>clock_timestamp()
       AND (i.ack_generation IS DISTINCT FROM c.generation OR i.ack_revision<c.revision)`,
        [opts.project_id, opts.home_bay_id, opts.lease_id],
      )
    ).rows[0];
    return row
      ? { generation: row.generation as string, revision: Number(row.revision) }
      : null;
  });
}

/** Acknowledges only the hint accepted durably at home, never view freshness. */
export async function acknowledgeCollaborationRevisionHint(
  opts: InterestLookup & { generation: string; revision: number },
  authority: CollaborationOwnerAuthority,
): Promise<boolean> {
  boundedText(opts.home_bay_id, "interest home bay", 128);
  uuid(opts.lease_id, "interest lease");
  uuid(opts.generation, "catalog generation");
  integer(opts.revision, "catalog revision");
  return transaction(async (db) => {
    await assertCollaborationAccountAuthority(
      db,
      opts.project_id,
      opts.account_id,
      authority,
    );
    const { rows } = await db.query(
      `UPDATE collaboration_revision_interests i SET ack_generation=$4,
       ack_revision=CASE WHEN i.ack_generation=$4 THEN GREATEST(i.ack_revision,$5) ELSE $5 END
       FROM collaboration_projects c WHERE c.project_id=i.project_id
       AND i.project_id=$1 AND i.home_bay_id=$2 AND i.lease_id=$3 AND i.expires_at>clock_timestamp()
       AND c.generation=$4 AND c.revision>=$5 RETURNING i.lease_id`,
      [
        opts.project_id,
        opts.home_bay_id,
        opts.lease_id,
        opts.generation,
        opts.revision,
      ],
    );
    return rows.length > 0;
  });
}

/** Called only by the authenticated aggregate home, after its last consumer
 * leaves. Membership is not required to relinquish a hint after revocation.
 */
export async function releaseCollaborationRevisionInterest(
  opts: { project_id: string; home_bay_id: string; lease_id: string },
  authority: CollaborationOwnerAuthority,
): Promise<boolean> {
  boundedText(opts.home_bay_id, "interest home bay", 128);
  uuid(opts.lease_id, "interest lease");
  return transaction(async (db) => {
    await assertCollaborationOwnerAuthority(db, opts.project_id, authority);
    const { rows } = await db.query(
      `DELETE FROM collaboration_revision_interests
       WHERE project_id=$1 AND home_bay_id=$2 AND lease_id=$3 RETURNING lease_id`,
      [opts.project_id, opts.home_bay_id, opts.lease_id],
    );
    return rows.length > 0;
  });
}

// Stable candidate cutoff permits an index range. Expiry after transaction
// start waits for the next pass; the final delete still rechecks current time.
export const revisionInterestPruneSql = `WITH expired AS MATERIALIZED (
        SELECT home_bay_id,lease_id FROM collaboration_revision_interests
        WHERE project_id=$1 AND expires_at<=now()
        ORDER BY expires_at,home_bay_id LIMIT 100 FOR UPDATE SKIP LOCKED)
      DELETE FROM collaboration_revision_interests i USING expired e
      WHERE i.project_id=$1 AND i.home_bay_id=e.home_bay_id
        AND i.lease_id=e.lease_id AND i.expires_at<=clock_timestamp()
      RETURNING i.home_bay_id`;

/** Internal owner maintenance. Serialize with registration and rehome before
 * deleting expired scheduling state; never delete a renewed live interest.
 */
export async function pruneCollaborationRevisionInterests(
  project_id: string,
  authority: CollaborationOwnerAuthority,
): Promise<number> {
  return transaction(async (db) => {
    await db.query("SET LOCAL lock_timeout='1s'");
    await db.query("SET LOCAL statement_timeout='2s'");
    await assertCollaborationOwnerAuthority(db, project_id, authority);
    const { rows } = await db.query(revisionInterestPruneSql, [project_id]);
    return rows.length;
  });
}

export interface RevisionInterestExpiryCursor {
  expires_at: string;
  project_id: string;
  home_bay_id: string;
}

/** Bound candidates before filtering ownership, and preserve timestamp precision
 * in the cursor. A full traversal wraps to catch rows renewed behind the cursor.
 */
export async function readCollaborationRevisionExpiryPage(
  owning_bay_id: string,
  after?: RevisionInterestExpiryCursor,
) {
  boundedText(owning_bay_id, "interest owner bay", 128);
  if (after) {
    boundedText(after.expires_at, "interest expiry cursor", 128);
    uuid(after.project_id, "interest project cursor");
    boundedText(after.home_bay_id, "interest home cursor", 128);
  }
  return transaction(async (db) => {
    await db.query("SET LOCAL statement_timeout='2s'");
    const { rows } = await db.query(
      `WITH candidates AS MATERIALIZED (
        SELECT project_id,home_bay_id,expires_at FROM collaboration_revision_interests
        WHERE expires_at<=now()
        ${after ? "AND (expires_at,project_id,home_bay_id)>($2::timestamptz,$3::uuid,$4::text)" : ""}
        ORDER BY expires_at,project_id,home_bay_id LIMIT 20)
      SELECT c.project_id,c.home_bay_id,c.expires_at::text,
        p.owning_bay_id=$1 AS local_owner
      FROM candidates c LEFT JOIN projects p USING(project_id)
      ORDER BY c.expires_at,c.project_id,c.home_bay_id`,
      after
        ? [owning_bay_id, after.expires_at, after.project_id, after.home_bay_id]
        : [owning_bay_id],
    );
    return {
      complete: rows.length < 20,
      candidates: rows.map((row) => ({
        cursor: {
          expires_at: row.expires_at,
          project_id: row.project_id,
          home_bay_id: row.home_bay_id,
        } as RevisionInterestExpiryCursor,
        local_owner: row.local_owner === true,
      })),
    };
  });
}
