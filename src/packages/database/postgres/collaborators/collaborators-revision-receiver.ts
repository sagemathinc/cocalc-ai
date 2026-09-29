/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { PoolClient } from "@cocalc/database/pool";
import getPool from "@cocalc/database/pool";
import type { ProjectDemandCursor } from "./collaborators-demand";
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
  await db.query(`ALTER TABLE collaboration_revision_receivers
    ADD COLUMN IF NOT EXISTS receiver_id UUID NOT NULL DEFAULT gen_random_uuid()`);
  await db.query(`ALTER TABLE collaboration_revision_receivers
    ADD COLUMN IF NOT EXISTS renew_after TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()`);
  await db.query(`ALTER TABLE collaboration_revision_receivers
    ADD COLUMN IF NOT EXISTS scheduling_seq BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS scheduling_version BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS scheduling_after JSONB,
    ADD COLUMN IF NOT EXISTS scheduling_complete BOOLEAN NOT NULL DEFAULT FALSE`);
  await db.query(`CREATE INDEX IF NOT EXISTS collaboration_revision_receivers_home_expiry
    ON collaboration_revision_receivers(home_bay_id,expires_at,project_id)`);
}

/** Local scheduling hint only; never substitutes for demand or access checks. */
export async function collaborationRevisionReceiverNeedsRenewal(
  project_id: string,
  home_bay_id: string,
): Promise<boolean> {
  uuid(project_id, "receiver project");
  boundedText(home_bay_id, "receiver home", 128);
  const { rows } = await getPool().query(
    `SELECT 1 FROM collaboration_revision_receivers WHERE project_id=$1
    AND home_bay_id=$2 AND expires_at>clock_timestamp()
    AND renew_after>clock_timestamp()`,
    [project_id, home_bay_id],
  );
  return rows.length === 0;
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

export interface RevisionSchedulingState extends ReceiverLease {
  receiver_id: string;
  dirty_seq: string;
  version: string;
  after: ProjectDemandCursor | null;
  complete: boolean;
}

/** New dirty sequences start a fresh traversal without discarding stored state
 * needed to reject stale worker updates. No projection freshness is asserted.
 */
export async function readRevisionSchedulingState(
  project_id: string,
  home_bay_id: string,
): Promise<RevisionSchedulingState | null> {
  uuid(project_id, "scheduling project");
  boundedText(home_bay_id, "scheduling home", 128);
  const { rows } = await getPool().query(
    `SELECT *,dirty_seq::text AS sequence,scheduling_version::text AS version,
      scheduling_seq=dirty_seq AS current FROM collaboration_revision_receivers
     WHERE project_id=$1 AND home_bay_id=$2 AND expires_at>clock_timestamp()`,
    [project_id, home_bay_id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    project_id: row.project_id,
    home_bay_id: row.home_bay_id,
    owner_bay_id: row.owner_bay_id,
    lease_id: row.lease_id,
    receiver_id: row.receiver_id,
    dirty_seq: row.sequence,
    version: row.version,
    after: row.current ? row.scheduling_after : null,
    complete: row.current && row.scheduling_complete,
  };
}

/** Commit only after the page's eligible accounts were durably scheduled or
 * verified inactive. Busy/failed accounts require retrying the page instead.
 * Null continuation means scheduling completed, never projection completion.
 */
export async function advanceRevisionScheduling(
  state: RevisionSchedulingState,
  after: ProjectDemandCursor | null,
): Promise<boolean> {
  validate(state);
  uuid(state.receiver_id, "scheduling receiver");
  for (const value of [state.dirty_seq, state.version])
    if (!/^[0-9]{1,19}$/.test(value) || BigInt(value) > 9223372036854775807n)
      throw Error("invalid scheduling sequence");
  if (after) {
    uuid(after.account_id, "scheduling account cursor");
    boundedText(after.grace_until, "scheduling expiry cursor", 128);
  }
  const { rows } = await getPool().query(
    `UPDATE collaboration_revision_receivers SET scheduling_seq=dirty_seq,
       scheduling_version=scheduling_version+1,scheduling_after=$7::jsonb,scheduling_complete=$8
     WHERE project_id=$1 AND home_bay_id=$2 AND owner_bay_id=$3 AND lease_id=$4
       AND receiver_id=$5 AND dirty_seq=$6 AND scheduling_version=$9
       AND expires_at>clock_timestamp()
       AND NOT (scheduling_seq=dirty_seq AND scheduling_complete)
     RETURNING project_id`,
    [
      state.project_id,
      state.home_bay_id,
      state.owner_bay_id,
      state.lease_id,
      state.receiver_id,
      state.dirty_seq,
      after === null ? null : JSON.stringify(after),
      after === null,
      state.version,
    ],
  );
  return rows.length > 0;
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
            `INSERT INTO collaboration_revision_receivers(project_id,home_bay_id,owner_bay_id,lease_id,expires_at,renew_after)
          VALUES($1,$2,$3,$4,clock_timestamp()+$5::double precision*interval '1 millisecond',
          clock_timestamp()+LEAST(30000,$5::double precision)*interval '1 millisecond')
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
          expires_at=clock_timestamp()+$5::double precision*interval '1 millisecond',dirty_seq=dirty_seq+1,
          renew_after=clock_timestamp()+LEAST(30000,$5::double precision)*interval '1 millisecond'
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
          receiver_id: row.receiver_id as string,
        })),
    };
  });
}

/** Call only after bounded catch-up committed. A concurrent wakeup keeps work
 * pending. Sequences stay decimal strings to avoid BIGINT precision loss.
 */
export async function finishCollaborationRevisionWakeup(
  opts: ReceiverLease & { dirty_seq: string; receiver_id: string },
): Promise<boolean> {
  validate(opts);
  uuid(opts.receiver_id, "receiver identity");
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
      AND expires_at>clock_timestamp() AND dirty_seq=$5 AND receiver_id=$6 RETURNING project_id`,
      [
        opts.project_id,
        opts.home_bay_id,
        opts.owner_bay_id,
        opts.lease_id,
        opts.dirty_seq,
        opts.receiver_id,
      ],
    );
    return rows.length > 0;
  });
}

// A stable cutoff allows an expiry index range instead of filtering live rows.
export const revisionReceiverPruneSql = `WITH expired AS MATERIALIZED (
      SELECT project_id FROM collaboration_revision_receivers
      WHERE home_bay_id=$1 AND expires_at<=now()
      ORDER BY expires_at,project_id LIMIT 100 FOR UPDATE SKIP LOCKED)
      DELETE FROM collaboration_revision_receivers r USING expired e
      WHERE r.project_id=e.project_id RETURNING r.project_id`;

/** Expired scheduling state only; no membership or historical-account scan.
 * Row locks serialize expiry deletion with rearming and skip busy receivers.
 */
export async function pruneCollaborationRevisionReceivers(
  home_bay_id: string,
): Promise<number> {
  boundedText(home_bay_id, "receiver home", 128);
  return transaction(async (db) => {
    await db.query("SET LOCAL lock_timeout='1s'");
    await db.query("SET LOCAL statement_timeout='2s'");
    const { rows } = await db.query(revisionReceiverPruneSql, [home_bay_id]);
    return rows.length;
  });
}
