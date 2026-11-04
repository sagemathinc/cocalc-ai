/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import { createHash, randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import type { CatalogEntry } from "@cocalc/conat/hub/api/artifact-catalog";
import {
  ARTIFACT_CATALOG_MAX_PROJECT_BYTES,
  ARTIFACT_CATALOG_MAX_PROJECT_ITEMS,
  ARTIFACT_CATALOG_MAX_PROJECT_SOURCE_BYTES,
  ARTIFACT_CATALOG_MAX_PROJECT_SOURCES,
  ARTIFACT_CATALOG_MAX_PROJECT_WORK_PER_HOUR,
  artifactCatalogKey,
  validateArtifactCatalogSnapshot,
  type ArtifactCatalogSnapshot,
  type ArtifactCatalogSource,
} from "@cocalc/util/artifact-catalog";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function artifactCatalogSourceId(source: ArtifactCatalogSource) {
  return hash(JSON.stringify([source.project_id, source.chat_path]));
}

/** Values supplied by the authenticated service/router, NEVER request payload. */
export interface CatalogWriterAuthority {
  owning_bay_id: string;
  host_id: string | null;
}

async function transaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    const value = await fn(db);
    await db.query("COMMIT");
    return value;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

async function assertOwner(
  db: PoolClient,
  project_id: string,
  authority: CatalogWriterAuthority,
) {
  const { rows } = await db.query(
    `SELECT project_id FROM projects
    WHERE project_id=$1 AND owning_bay_id=$2 AND host_id IS NOT DISTINCT FROM $3::uuid
      AND NOT COALESCE(deleted,FALSE) FOR SHARE`,
    [project_id, authority.owning_bay_id, authority.host_id],
  );
  if (!rows.length)
    throw Error(
      "artifact catalog writer is not the current project owner/host",
    );
}

type Queryable = Pick<PoolClient, "query">;

async function lockProjectCatalog(db: Queryable, project_id: string) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `artifact-project:${project_id}`,
  ]);
}

/**
 * The one predicate for "project row is live on this bay" used by every new
 * catalog version writer and count. A missing owning bay counts as this bay,
 * as for other single-bay-compatible project routing.
 */
export function liveOnBay(alias: string, bayParam: string): string {
  const p = alias ? `${alias}.` : "";
  return `COALESCE(NULLIF(BTRIM(${p}owning_bay_id),''),${bayParam})=${bayParam}
       AND NOT COALESCE(${p}deleted,FALSE)`;
}

/**
 * For writers outside ingest that change what a catalog reader may see (agent
 * identity changes). In their transaction, before any other lock, this takes
 * the same locks in the same order as ingest: the live project row owned by
 * this bay FOR SHARE (which serializes with project hard delete, so no version
 * or change row can outlive the project), then the project catalog lock.
 * Throws if the project is not live on this bay.
 */
export async function lockArtifactCatalogProject(
  db: Queryable,
  project_id: string,
  owning_bay_id: string,
): Promise<void> {
  const { rows } = await db.query(
    `SELECT project_id FROM projects
     WHERE project_id=$1 AND ${liveOnBay("", "$2")} FOR SHARE`,
    [project_id, owning_bay_id],
  );
  if (!rows.length)
    throw Error("artifact catalog project is not live on this bay");
  await lockProjectCatalog(db, project_id);
}

export type ArtifactCatalogChangeOp = "upsert" | "remove" | "reset";

// Changes newer than both bounds are kept; older readers must reload.
export const ARTIFACT_CATALOG_CHANGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const ARTIFACT_CATALOG_CHANGE_RETENTION_SEQS = 10_000;
// A project retaining more change rows than this is reported (counts only).
export const ARTIFACT_CATALOG_CHANGE_ROWS_REPORT = 10_000;

/**
 * Creates the version baseline for a project whose catalog predates versions:
 * a fresh epoch at seq 0 with no change history. Readers treat seq 0 as "load
 * the current catalog"; nothing is fabricated or removed. Idempotent; caller
 * holds the project row (owner check) and the project catalog lock.
 */
async function ensureCatalogProjectState(
  db: Queryable,
  project_id: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `INSERT INTO artifact_catalog_project_state
       (project_id,epoch,seq,latest_created_at,published_seq,change_rows,updated_at)
     VALUES($1,$2,0,(SELECT max(created_at) FROM artifact_catalog
       WHERE project_id=$1 AND NOT deleted),0,0,now())
     ON CONFLICT(project_id) DO NOTHING
     RETURNING project_id`,
    [project_id, randomUUID()],
  );
  return rows.length > 0;
}

/**
 * Bounded, restart-safe backfill of version baselines for catalogs on this
 * bay that have not been written since versions were introduced (dormant
 * projects). Each project is revalidated under the same locks, in the same
 * order, as ingest: the live project row owned by this bay (which serializes
 * with project hard delete), then the catalog lock, then its sources. A
 * project deleted or moved meanwhile is skipped; rerunning is harmless.
 */
export async function backfillArtifactCatalogProjectState({
  owning_bay_id,
  maxProjects = 100,
  beforeProject,
}: {
  owning_bay_id: string;
  maxProjects?: number;
  /** Test hook: runs after selection, before the project's locks. */
  beforeProject?: (project_id: string) => Promise<void>;
}): Promise<{ created: number; remaining: number }> {
  const { rows } = await getPool().query(
    `SELECT DISTINCT s.project_id FROM artifact_catalog_sources s
     JOIN projects p ON p.project_id=s.project_id
     WHERE ${liveOnBay("p", "$1")}
       AND NOT EXISTS (SELECT 1 FROM artifact_catalog_project_state st
         WHERE st.project_id=s.project_id)
     ORDER BY s.project_id LIMIT $2`,
    [owning_bay_id, maxProjects],
  );
  let created = 0;
  for (const row of rows) {
    await beforeProject?.(row.project_id);
    const inserted = await transaction(async (db) => {
      const live = await db.query(
        `SELECT project_id FROM projects
         WHERE project_id=$1 AND ${liveOnBay("", "$2")} FOR SHARE`,
        [row.project_id, owning_bay_id],
      );
      if (!live.rows.length) return false;
      await lockProjectCatalog(db, row.project_id);
      const source = await db.query(
        "SELECT 1 FROM artifact_catalog_sources WHERE project_id=$1 LIMIT 1",
        [row.project_id],
      );
      if (!source.rows.length) return false;
      return await ensureCatalogProjectState(db, row.project_id);
    });
    if (inserted) created++;
  }
  return {
    created,
    remaining: await artifactCatalogStateBackfillRemaining(owning_bay_id),
  };
}

/**
 * Live projects owned by this bay that have catalog sources but no version
 * baseline. Reads that rely on versions must not be advertised on this bay
 * until this is zero.
 */
export async function artifactCatalogStateBackfillRemaining(
  owning_bay_id: string,
): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT count(DISTINCT s.project_id) AS n FROM artifact_catalog_sources s
     JOIN projects p ON p.project_id=s.project_id
     WHERE ${liveOnBay("p", "$1")}
       AND NOT EXISTS (SELECT 1 FROM artifact_catalog_project_state st
         WHERE st.project_id=s.project_id)`,
    [owning_bay_id],
  );
  return Number(rows[0].n);
}

/**
 * Caller holds the project catalog lock inside its transaction. Besides the
 * seq, this keeps the exact retained change-row count, and owes readers a
 * change hint: a catalog with no hint baseline yet (published_seq NULL, from
 * before hints existed) gets the seq before this change as its baseline, so
 * exactly this change is hinted.
 */
async function appendCatalogChanges(
  db: Queryable,
  project_id: string,
  changes: { entry_id: string; op: ArtifactCatalogChangeOp }[],
): Promise<number> {
  const { rows } = await db.query(
    `INSERT INTO artifact_catalog_project_state
       (project_id,epoch,seq,latest_created_at,published_seq,change_rows,updated_at)
     VALUES($1,$2,1,(SELECT max(created_at) FROM artifact_catalog
       WHERE project_id=$1 AND NOT deleted),0,$3,now())
     ON CONFLICT(project_id) DO UPDATE SET
       seq=artifact_catalog_project_state.seq+1,
       latest_created_at=excluded.latest_created_at,
       published_seq=COALESCE(artifact_catalog_project_state.published_seq,
         artifact_catalog_project_state.seq),
       change_rows=artifact_catalog_project_state.change_rows+$3,
       updated_at=now()
     RETURNING seq`,
    [project_id, randomUUID(), changes.length],
  );
  const seq = Number(rows[0].seq);
  await db.query(
    `INSERT INTO artifact_catalog_changes(project_id,seq,entry_id,op,created_at)
     SELECT $1,$2,c.entry_id,c.op,now()
     FROM jsonb_to_recordset($3::jsonb) AS c(entry_id text,op text)`,
    [project_id, seq, JSON.stringify(changes)],
  );
  return seq;
}

/**
 * Records that catalog visibility may have changed for the whole project (an
 * agent identity was registered, disabled, replaced or rebound). Caller has
 * called lockArtifactCatalogProject in the same transaction as that change.
 */
export async function appendArtifactCatalogReset(
  db: Queryable,
  project_id: string,
): Promise<number> {
  return await appendCatalogChanges(db, project_id, [
    { entry_id: "", op: "reset" },
  ]);
}

/**
 * Prunes old change records in bounded batches. The retention floor moves
 * first, under the project lock, so a reader older than the floor reloads
 * instead of applying an incomplete delta while rows are being deleted.
 */
export async function pruneArtifactCatalogChanges({
  maxProjects = 32,
  batchRows = 1000,
  maxRowsPerProject = 10_000,
}: {
  maxProjects?: number;
  batchRows?: number;
  maxRowsPerProject?: number;
} = {}): Promise<{ projects: number; deleted: number }> {
  const cutoff = new Date(Date.now() - ARTIFACT_CATALOG_CHANGE_RETENTION_MS);
  const { rows } = await getPool().query(
    `SELECT s.project_id,
       (SELECT max(c.seq) FROM artifact_catalog_changes c
        WHERE c.project_id=s.project_id AND c.created_at<$1
          AND c.seq<=s.seq-$2) AS floor
     FROM artifact_catalog_project_state s
     WHERE EXISTS (SELECT 1 FROM artifact_catalog_changes c
       WHERE c.project_id=s.project_id AND c.created_at<$1
         AND c.seq<=s.seq-$2)
     LIMIT $3`,
    [cutoff, ARTIFACT_CATALOG_CHANGE_RETENTION_SEQS, maxProjects],
  );
  let deleted = 0;
  for (const row of rows) {
    const floor = Number(row.floor);
    if (!Number.isSafeInteger(floor) || floor < 1) continue;
    await transaction(async (db) => {
      await lockProjectCatalog(db, row.project_id);
      await db.query(
        `UPDATE artifact_catalog_project_state
         SET retention_floor_seq=GREATEST(retention_floor_seq,$2)
         WHERE project_id=$1`,
        [row.project_id, floor],
      );
    });
    let projectDeleted = 0;
    while (projectDeleted < maxRowsPerProject) {
      // Each batch and its change-row count move together, under the project
      // catalog lock (as every other change-row writer), so the count stays
      // exact against a concurrent backfill measurement.
      const count = await transaction(async (db) => {
        await lockProjectCatalog(db, row.project_id);
        const result = await db.query(
          `DELETE FROM artifact_catalog_changes WHERE ctid IN (
             SELECT ctid FROM artifact_catalog_changes
             WHERE project_id=$1 AND seq<=$2 LIMIT $3)`,
          [row.project_id, floor, batchRows],
        );
        const deleted = result.rowCount ?? 0;
        if (deleted > 0)
          await db.query(
            `UPDATE artifact_catalog_project_state
             SET change_rows=change_rows-$2 WHERE project_id=$1`,
            [row.project_id, deleted],
          );
        return deleted;
      });
      projectDeleted += count;
      if (count < batchRows) break;
    }
    deleted += projectDeleted;
  }
  return { projects: rows.length, deleted };
}

/**
 * Measures the exact retained change-row count of catalogs that predate the
 * counter (NULL), in small batches, each under the project catalog lock so
 * no concurrent change is counted twice or missed. Restart-safe.
 */
export async function backfillArtifactCatalogChangeRows({
  maxProjects = 100,
}: { maxProjects?: number } = {}): Promise<{
  measured: number;
  remaining: number;
}> {
  const { rows } = await getPool().query(
    `SELECT project_id FROM artifact_catalog_project_state
     WHERE change_rows IS NULL ORDER BY project_id LIMIT $1`,
    [maxProjects],
  );
  let measured = 0;
  for (const row of rows) {
    const updated = await transaction(async (db) => {
      await lockProjectCatalog(db, row.project_id);
      const result = await db.query(
        `UPDATE artifact_catalog_project_state SET change_rows=(
           SELECT count(*) FROM artifact_catalog_changes WHERE project_id=$1)
         WHERE project_id=$1 AND change_rows IS NULL`,
        [row.project_id],
      );
      return result.rowCount ?? 0;
    });
    measured += updated;
  }
  const { rows: left } = await getPool().query(
    "SELECT count(*) AS n FROM artifact_catalog_project_state WHERE change_rows IS NULL",
  );
  return { measured, remaining: Number(left[0].n) };
}

/** Change-log size, counts only, from the state table (one row a project). */
export async function artifactCatalogChangeRowGauges(): Promise<{
  max_change_rows: number;
  projects_over_retention: number;
  projects_unmeasured: number;
}> {
  const { rows } = await getPool().query(
    `SELECT COALESCE(max(change_rows),0) AS max_rows,
       count(*) FILTER (WHERE change_rows > $1) AS over,
       count(*) FILTER (WHERE change_rows IS NULL) AS unmeasured
     FROM artifact_catalog_project_state`,
    [ARTIFACT_CATALOG_CHANGE_ROWS_REPORT],
  );
  return {
    max_change_rows: Number(rows[0].max_rows),
    projects_over_retention: Number(rows[0].over),
    projects_unmeasured: Number(rows[0].unmeasured),
  };
}

async function chargeProjectWork(
  db: PoolClient,
  project_id: string,
  units: number,
) {
  const { rows } = await db.query(
    `INSERT INTO artifact_catalog_project_budget(project_id,window_start,work_units)
     VALUES($1,now(),$2)
     ON CONFLICT(project_id) DO UPDATE SET
       window_start=CASE WHEN artifact_catalog_project_budget.window_start <= now()-interval '1 hour'
         THEN excluded.window_start ELSE artifact_catalog_project_budget.window_start END,
       work_units=CASE WHEN artifact_catalog_project_budget.window_start <= now()-interval '1 hour'
         THEN excluded.work_units ELSE artifact_catalog_project_budget.work_units+excluded.work_units END
     RETURNING work_units`,
    [project_id, units],
  );
  if (Number(rows[0].work_units) > ARTIFACT_CATALOG_MAX_PROJECT_WORK_PER_HOUR)
    throw Error("artifact catalog project mutation budget exceeded");
}

async function assertProjectCatalogSize(db: PoolClient, project_id: string) {
  const { rows } = await db.query(
    `SELECT count(*) AS items,COALESCE(sum(octet_length(metadata::text)),0) AS bytes
     FROM artifact_catalog WHERE project_id=$1`,
    [project_id],
  );
  if (
    Number(rows[0].items) > ARTIFACT_CATALOG_MAX_PROJECT_ITEMS ||
    Number(rows[0].bytes) > ARTIFACT_CATALOG_MAX_PROJECT_BYTES
  )
    throw Error("artifact catalog project metadata limit exceeded");
}

export async function artifactCatalogSourcePage(
  project_id: string,
  authority: CatalogWriterAuthority,
  after = "",
) {
  if (typeof after !== "string" || after.length > 4096)
    throw Error("invalid source cursor");
  return transaction(async (db) => {
    await assertOwner(db, project_id, authority);
    const { rows } = await db.query(
      `SELECT path FROM (
      SELECT path FROM agent_identities WHERE project_id=$1
      UNION SELECT chat_path AS path FROM artifact_catalog_sources WHERE project_id=$1
    ) sources WHERE path>$2 ORDER BY path LIMIT 101`,
      [project_id, after],
    );
    const paths = rows.slice(0, 100).map((row) => row.path as string);
    return { paths, ...(rows.length > 100 ? { next: paths[99] } : {}) };
  });
}

/** Internal read; caller must resolve ownership and check collaboration first. */
export async function readProjectArtifactCatalog(
  project_id: string,
  after = "",
) {
  if (typeof after !== "string" || (after && !/^[a-f0-9]{64}$/.test(after)))
    throw Error("invalid catalog cursor");
  const db = getPool();
  const { rows } = await db.query(
    `SELECT c.entry_id,s.chat_path,c.metadata
    FROM artifact_catalog c JOIN artifact_catalog_sources s USING(source_id)
    WHERE c.project_id=$1 AND NOT c.deleted AND c.entry_id>$2
    ORDER BY c.entry_id LIMIT 101`,
    [project_id, after],
  );
  const entries = rows.slice(0, 100).map((row) => ({
    entry_id: row.entry_id as string,
    project_id,
    chat_path: row.chat_path as string,
    item: row.metadata,
  }));
  const count = await db.query(
    `SELECT count(*) AS n FROM artifact_catalog_sources WHERE project_id=$1 AND source_sequence>0`,
    [project_id],
  );
  return {
    entries,
    indexed_sources: Number(count.rows[0].n),
    ...(rows.length > 100 ? { next: entries[99].entry_id } : {}),
  };
}

/** Internal point lookup; caller must resolve ownership and check collaboration. */
export async function readArtifactCatalogEntry(
  project_id: string,
  entry_id: string,
): Promise<CatalogEntry | null> {
  if (typeof entry_id !== "string" || !/^[a-f0-9]{64}$/.test(entry_id))
    throw Error("invalid catalog entry_id");
  const { rows } = await getPool().query(
    `SELECT c.entry_id,s.chat_path,c.metadata
    FROM artifact_catalog c JOIN artifact_catalog_sources s USING(source_id)
    WHERE c.project_id=$1 AND c.entry_id=$2 AND NOT c.deleted`,
    [project_id, entry_id],
  );
  const row = rows[0];
  return row
    ? {
        entry_id: row.entry_id,
        project_id,
        chat_path: row.chat_path,
        item: row.metadata,
      }
    : null;
}

/** Compare-and-swap rotation prevents a delayed registration fencing a newer writer. */
export async function registerArtifactCatalogSource(
  source: ArtifactCatalogSource,
  authority: CatalogWriterAuthority,
  expected_epoch: string | null,
  registration_id: string,
): Promise<string> {
  validateArtifactCatalogSnapshot({
    ...source,
    schema_version: 1,
    epoch: "validate",
    sequence: 1,
    items: [],
  });
  return transaction(async (db) => {
    await assertOwner(db, source.project_id, authority);
    await lockProjectCatalog(db, source.project_id);
    // A newly registered source is versioned before its first ingest.
    await ensureCatalogProjectState(db, source.project_id);
    const source_id = artifactCatalogSourceId(source);
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `artifact-source:${source_id}`,
    ]);
    const previous = (
      await db.query(
        "SELECT epoch,registration_id,writer_host_id,owning_bay_id FROM artifact_catalog_sources WHERE source_id=$1 FOR UPDATE",
        [source_id],
      )
    ).rows[0];
    if (
      previous?.registration_id === registration_id &&
      previous.writer_host_id === authority.host_id &&
      previous.owning_bay_id === authority.owning_bay_id
    )
      return previous.epoch;
    if ((previous?.epoch ?? null) !== expected_epoch)
      throw Error("artifact catalog writer epoch changed");
    if (!previous) {
      const { rows } = await db.query(
        `SELECT count(*) AS sources,COALESCE(sum(octet_length(chat_path)),0) AS bytes
         FROM artifact_catalog_sources WHERE project_id=$1`,
        [source.project_id],
      );
      if (
        Number(rows[0].sources) >= ARTIFACT_CATALOG_MAX_PROJECT_SOURCES ||
        Number(rows[0].bytes) + Buffer.byteLength(source.chat_path) >
          ARTIFACT_CATALOG_MAX_PROJECT_SOURCE_BYTES
      )
        throw Error("artifact catalog project source limit exceeded");
    }
    await chargeProjectWork(db, source.project_id, 1);
    const epoch = randomUUID();
    await db.query(
      `INSERT INTO artifact_catalog_sources
      (source_id,project_id,chat_path,owning_bay_id,writer_host_id,epoch,registration_id,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,now())
      ON CONFLICT(source_id) DO UPDATE SET owning_bay_id=excluded.owning_bay_id,
      writer_host_id=excluded.writer_host_id,epoch=excluded.epoch,registration_id=excluded.registration_id,source_sequence=0,
      payload_hash=NULL,updated_at=now()`,
      [
        source_id,
        source.project_id,
        source.chat_path,
        authority.owning_bay_id,
        authority.host_id,
        epoch,
        registration_id,
      ],
    );
    return epoch;
  });
}

/** Internal owner-bay lookup, after authenticating the host and resolving ownership. */
export async function getArtifactCatalogWriterState(
  source: ArtifactCatalogSource,
  authority: CatalogWriterAuthority,
): Promise<{
  epoch: string;
  registration_id: string;
  source_sequence: number;
  writer_host_id: string | null;
} | null> {
  validateArtifactCatalogSnapshot({
    ...source,
    schema_version: 1,
    epoch: "validate",
    sequence: 1,
    items: [],
  });
  return transaction(async (db) => {
    await assertOwner(db, source.project_id, authority);
    const row = (
      await db.query(
        `SELECT epoch,registration_id,source_sequence,writer_host_id
      FROM artifact_catalog_sources WHERE source_id=$1`,
        [artifactCatalogSourceId(source)],
      )
    ).rows[0];
    return row
      ? { ...row, source_sequence: Number(row.source_sequence) }
      : null;
  });
}

export async function applyArtifactCatalogSnapshot(
  input: ArtifactCatalogSnapshot,
  authority: CatalogWriterAuthority,
): Promise<{ revision: number; replayed: boolean }> {
  const snapshot = validateArtifactCatalogSnapshot(input);
  const source_id = artifactCatalogSourceId(snapshot);
  const payload_hash = hash(JSON.stringify(snapshot));
  const metadata_hash = hash(JSON.stringify(snapshot.items));
  return transaction(async (db) => {
    await assertOwner(db, snapshot.project_id, authority);
    await lockProjectCatalog(db, snapshot.project_id);
    const current = (
      await db.query(
        `SELECT * FROM artifact_catalog_sources
      WHERE source_id=$1 FOR UPDATE`,
        [source_id],
      )
    ).rows[0];
    if (
      !current ||
      current.epoch !== snapshot.epoch ||
      current.writer_host_id !== authority.host_id
    ) {
      throw Error("stale artifact catalog writer epoch");
    }
    // Catalogs written before versions existed have no state row. Create the
    // baseline on every accepted delivery, including the unchanged-metadata
    // and replay paths below, so no catalog stays unversioned.
    await ensureCatalogProjectState(db, snapshot.project_id);
    const sequence = Number(current.source_sequence);
    const revision = Number(current.catalog_revision);
    if (sequence > snapshot.sequence)
      throw Error("stale artifact catalog snapshot");
    if (sequence === snapshot.sequence) {
      if (payload_hash !== current.payload_hash)
        throw Error("artifact catalog sequence reused with different metadata");
      return { revision, replayed: true };
    }
    if (metadata_hash === current.metadata_hash) {
      await db.query(
        `UPDATE artifact_catalog_sources SET source_sequence=$2,
        payload_hash=$3,updated_at=now() WHERE source_id=$1`,
        [source_id, snapshot.sequence, payload_hash],
      );
      return { revision, replayed: true };
    }
    const next = revision + 1;
    if (!Number.isSafeInteger(next))
      throw Error("artifact catalog revision exhausted");
    const existing = await db.query(
      "SELECT count(*) AS items FROM artifact_catalog WHERE source_id=$1 AND NOT deleted",
      [source_id],
    );
    await chargeProjectWork(
      db,
      snapshot.project_id,
      Math.max(1, snapshot.items.length + Number(existing.rows[0].items)),
    );
    const entries = snapshot.items.map((item) => ({
      entry_id: hash(artifactCatalogKey(snapshot, item)),
      thread_id: item.thread_id,
      artifact_id: item.artifact_id,
      metadata: item,
      created_at: new Date(item.created_at).toISOString(),
    }));
    // Existing entries retain their creation time; omitted entries are removed.
    // A later reappearance is a new entry, not a retained historical row.
    await db.query(
      "DELETE FROM artifact_catalog WHERE project_id=$1 AND deleted",
      [snapshot.project_id],
    );
    // Only inserted or actually changed rows are returned: an update is skipped
    // when the value it would write (incoming metadata with the retained
    // creation time) equals what is stored.
    const upserted = await db.query(
      `INSERT INTO artifact_catalog
      (entry_id,source_id,project_id,thread_id,artifact_id,metadata,created_at,revision,deleted)
      SELECT e.entry_id,$1,$2,e.thread_id,e.artifact_id,e.metadata,e.created_at,$3,FALSE
      FROM jsonb_to_recordset($4::jsonb) AS e(entry_id text,thread_id text,artifact_id text,metadata jsonb,created_at timestamptz)
      ON CONFLICT(entry_id) DO UPDATE SET metadata=jsonb_set(excluded.metadata,'{created_at}',
        to_jsonb((extract(epoch FROM artifact_catalog.created_at)*1000)::bigint)),
      revision=excluded.revision,deleted=FALSE
      WHERE artifact_catalog.deleted
        OR artifact_catalog.metadata IS DISTINCT FROM jsonb_set(excluded.metadata,'{created_at}',
          to_jsonb((extract(epoch FROM artifact_catalog.created_at)*1000)::bigint))
      RETURNING entry_id`,
      [source_id, snapshot.project_id, next, JSON.stringify(entries)],
    );
    const removed = await db.query(
      `DELETE FROM artifact_catalog
      WHERE source_id=$1 AND NOT (entry_id=ANY($2::text[]))
      RETURNING entry_id`,
      [source_id, entries.map((entry) => entry.entry_id)],
    );
    await assertProjectCatalogSize(db, snapshot.project_id);
    const changes = [
      ...upserted.rows.map((row) => ({
        entry_id: row.entry_id as string,
        op: "upsert" as const,
      })),
      ...removed.rows.map((row) => ({
        entry_id: row.entry_id as string,
        op: "remove" as const,
      })),
    ];
    if (changes.length > 0) {
      await appendCatalogChanges(db, snapshot.project_id, changes);
    }
    await db.query(
      `UPDATE artifact_catalog_sources SET source_sequence=$2,
      catalog_revision=$3,payload_hash=$4,metadata_hash=$5,updated_at=now() WHERE source_id=$1`,
      [source_id, snapshot.sequence, next, payload_hash, metadata_hash],
    );
    return { revision: next, replayed: false };
  });
}
