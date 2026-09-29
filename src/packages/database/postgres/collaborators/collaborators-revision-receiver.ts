/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { PoolClient } from "@cocalc/database/pool";
import getPool from "@cocalc/database/pool";
import { boundedText, transaction, uuid } from "./collaborators-common";

/** Explicit prototype installation. Remote projects need not exist locally. */
export async function syncCollaborationRevisionReceiverSchema(
  db: Pick<PoolClient, "query">,
) {
  await db.query(`CREATE TABLE IF NOT EXISTS collaboration_revision_receivers (
    project_id UUID PRIMARY KEY, home_bay_id TEXT NOT NULL,
    owner_bay_id TEXT NOT NULL, lease_id UUID NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL, dirty_seq BIGINT NOT NULL DEFAULT 1,
    applied_seq BIGINT NOT NULL DEFAULT 0)`);
  await db.query(`CREATE INDEX IF NOT EXISTS collaboration_revision_receivers_expiry
    ON collaboration_revision_receivers(expires_at,project_id)`);
}

type ReceiverLease = {
  project_id: string;
  home_bay_id: string;
  owner_bay_id: string;
  lease_id: string;
};
function validate(opts: ReceiverLease) {
  uuid(opts.project_id, "receiver project");
  uuid(opts.lease_id, "receiver lease");
  boundedText(opts.home_bay_id, "receiver home", 128);
  boundedText(opts.owner_bay_id, "receiver owner", 128);
}

/** Snapshot for the registration CAS, never a metadata/access lookup. */
export async function readCollaborationRevisionReceiverLease(
  project_id: string,
  home_bay_id: string,
): Promise<string | null> {
  uuid(project_id, "receiver project");
  boundedText(home_bay_id, "receiver home", 128);
  const { rows } = await getPool().query(
    "SELECT lease_id FROM collaboration_revision_receivers WHERE project_id=$1 AND home_bay_id=$2",
    [project_id, home_bay_id],
  );
  return rows[0]?.lease_id ?? null;
}

/** Internal home worker only. Caller must verify current owner registration and
 * local demand, bound ttl_ms by both demand and owner lease remaining time,
 * deduct elapsed RPC time, and route to this home.
 * CAS prevents delayed registration responses from replacing a newer lease.
 * This stores no resources and grants no access. Every arm requires catch-up.
 */
export async function armCollaborationRevisionReceiver(
  opts: ReceiverLease & { expected_lease_id: string | null; ttl_ms: number },
): Promise<boolean> {
  validate(opts);
  if (opts.expected_lease_id !== null)
    uuid(opts.expected_lease_id, "previous receiver lease");
  if (!Number.isFinite(opts.ttl_ms) || opts.ttl_ms <= 0)
    throw Error("receiver demand expired");
  const started = performance.now();
  return transaction(async (db) => {
    await db.query("SET LOCAL lock_timeout='1s'");
    await db.query("SET LOCAL statement_timeout='2s'");
    // Serialize missing-row creation as well as replacement without account locks.
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('revision-receiver'),hashtext($1))",
      [opts.project_id.toLowerCase()],
    );
    const ttl = Math.min(120000, opts.ttl_ms - (performance.now() - started));
    if (ttl <= 0) throw Error("receiver demand expired");
    if (opts.expected_lease_id === opts.lease_id) {
      const existing = await db.query(
        `SELECT 1 FROM collaboration_revision_receivers
        WHERE project_id=$1 AND home_bay_id=$2 AND owner_bay_id=$3 AND lease_id=$4
        AND expires_at>clock_timestamp()`,
        [opts.project_id, opts.home_bay_id, opts.owner_bay_id, opts.lease_id],
      );
      if (existing.rows.length) return true;
    }
    const { rows } =
      opts.expected_lease_id === null
        ? await db.query(
            `INSERT INTO collaboration_revision_receivers(project_id,home_bay_id,owner_bay_id,lease_id,expires_at)
          VALUES($1,$2,$3,$4,clock_timestamp()+$5::double precision*interval '1 millisecond')
          ON CONFLICT DO NOTHING RETURNING project_id`,
            [
              opts.project_id,
              opts.home_bay_id,
              opts.owner_bay_id,
              opts.lease_id,
              ttl,
            ],
          )
        : await db.query(
            `UPDATE collaboration_revision_receivers SET owner_bay_id=$3,lease_id=$4,
          expires_at=clock_timestamp()+$5::double precision*interval '1 millisecond',dirty_seq=dirty_seq+1
          WHERE project_id=$1 AND home_bay_id=$2 AND lease_id=$6 RETURNING project_id`,
            [
              opts.project_id,
              opts.home_bay_id,
              opts.owner_bay_id,
              opts.lease_id,
              ttl,
              opts.expected_lease_id,
            ],
          );
    return rows.length > 0;
  });
}

/** Trusted routed transport only. ACK only after this transaction commits.
 * Duplicates may schedule redundant catch-up but cannot regress a watermark.
 */
export async function receiveCollaborationRevisionWakeup(
  opts: ReceiverLease,
): Promise<string | null> {
  validate(opts);
  return transaction(async (db) => {
    await db.query("SET LOCAL lock_timeout='1s'");
    await db.query("SET LOCAL statement_timeout='2s'");
    const { rows } = await db.query(
      `UPDATE collaboration_revision_receivers SET dirty_seq=dirty_seq+1
      WHERE project_id=$1 AND home_bay_id=$2 AND owner_bay_id=$3 AND lease_id=$4
      AND expires_at>clock_timestamp() RETURNING dirty_seq`,
      [opts.project_id, opts.home_bay_id, opts.owner_bay_id, opts.lease_id],
    );
    return rows.length ? String(rows[0].dirty_seq) : null;
  });
}

/** Bounded restartable local worker traversal, not a public discovery API. */
export async function readCollaborationRevisionReceiverPage(opts: {
  home_bay_id: string;
  after_project_id?: string;
}) {
  boundedText(opts.home_bay_id, "receiver home", 128);
  const after = opts.after_project_id ?? "00000000-0000-0000-0000-000000000000";
  uuid(after, "receiver cursor");
  return transaction(async (db) => {
    await db.query("SET LOCAL statement_timeout='2s'");
    const { rows } = await db.query(
      `SELECT *,dirty_seq::text AS sequence,
      expires_at>clock_timestamp() AND dirty_seq>applied_seq AS pending
      FROM collaboration_revision_receivers WHERE project_id>$1
      ORDER BY project_id LIMIT 20`,
      [after],
    );
    return {
      next_after: rows.length === 20 ? (rows[19].project_id as string) : null,
      examined: rows.length,
      pending: rows
        .filter((row) => row.home_bay_id === opts.home_bay_id && row.pending)
        .map((row) => ({
          project_id: row.project_id as string,
          home_bay_id: row.home_bay_id as string,
          owner_bay_id: row.owner_bay_id as string,
          lease_id: row.lease_id as string,
          dirty_seq: row.sequence as string,
        })),
    };
  });
}

/** Call only after bounded catch-up committed. A concurrent wakeup keeps work
 * pending. Sequences stay decimal strings to avoid BIGINT precision loss.
 */
export async function finishCollaborationRevisionWakeup(
  opts: ReceiverLease & { dirty_seq: string },
): Promise<boolean> {
  validate(opts);
  if (
    !/^[1-9][0-9]{0,18}$/.test(opts.dirty_seq) ||
    BigInt(opts.dirty_seq) > 9223372036854775807n
  )
    throw Error("invalid receiver sequence");
  return transaction(async (db) => {
    await db.query("SET LOCAL lock_timeout='1s'");
    await db.query("SET LOCAL statement_timeout='2s'");
    const { rows } = await db.query(
      `UPDATE collaboration_revision_receivers SET applied_seq=dirty_seq
      WHERE project_id=$1 AND home_bay_id=$2 AND owner_bay_id=$3 AND lease_id=$4
      AND expires_at>clock_timestamp() AND dirty_seq=$5 RETURNING project_id`,
      [
        opts.project_id,
        opts.home_bay_id,
        opts.owner_bay_id,
        opts.lease_id,
        opts.dirty_seq,
      ],
    );
    return rows.length > 0;
  });
}
