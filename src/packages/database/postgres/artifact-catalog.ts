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

async function lockProjectCatalog(db: PoolClient, project_id: string) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `artifact-project:${project_id}`,
  ]);
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
    await db.query(
      `INSERT INTO artifact_catalog
      (entry_id,source_id,project_id,thread_id,artifact_id,metadata,created_at,revision,deleted)
      SELECT e.entry_id,$1,$2,e.thread_id,e.artifact_id,e.metadata,e.created_at,$3,FALSE
      FROM jsonb_to_recordset($4::jsonb) AS e(entry_id text,thread_id text,artifact_id text,metadata jsonb,created_at timestamptz)
      ON CONFLICT(entry_id) DO UPDATE SET metadata=jsonb_set(excluded.metadata,'{created_at}',
        to_jsonb((extract(epoch FROM artifact_catalog.created_at)*1000)::bigint)),
      revision=excluded.revision,deleted=FALSE`,
      [source_id, snapshot.project_id, next, JSON.stringify(entries)],
    );
    await db.query(
      `DELETE FROM artifact_catalog
      WHERE source_id=$1 AND NOT (entry_id=ANY($2::text[]))`,
      [source_id, entries.map((entry) => entry.entry_id)],
    );
    await assertProjectCatalogSize(db, snapshot.project_id);
    await db.query(
      `UPDATE artifact_catalog_sources SET source_sequence=$2,
      catalog_revision=$3,payload_hash=$4,metadata_hash=$5,updated_at=now() WHERE source_id=$1`,
      [source_id, snapshot.sequence, next, payload_hash, metadata_hash],
    );
    return { revision: next, replayed: false };
  });
}
