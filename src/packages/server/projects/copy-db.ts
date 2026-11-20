import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import type {
  ProjectCopyRow,
  ProjectCopyState,
} from "@cocalc/conat/hub/api/projects";
import type { LroStatus } from "@cocalc/conat/hub/api/lro";
import { ensureLroSchema, getLro, updateLro } from "@cocalc/server/lro/lro-db";
import { publishLroSummary } from "@cocalc/server/lro/stream";
import { getProjectFileServerClient } from "@cocalc/server/conat/file-server-client";

const logger = getLogger("server:projects:copy-db");

const ACTIVE_STATUSES: ProjectCopyState[] = ["queued", "applying", "failed"];
const CLAIMABLE_STATUSES: ProjectCopyState[] = ["queued"];
const TERMINAL_STATUSES: ProjectCopyState[] = ["done", "canceled", "expired"];
const TERMINAL_LRO_STATUSES: LroStatus[] = [
  "succeeded",
  "failed",
  "canceled",
  "expired",
];
const STALE_APPLYING_MS = 35 * 60 * 1000;

function staleApplyingIntervalSql(param: number): string {
  return `now() - ($${param}::text || ' milliseconds')::interval`;
}

async function reconcileTerminalParentCopyRows(): Promise<ProjectCopyRow[]> {
  await ensureCopySchema();
  await ensureLroSchema();
  const { rows } = await pool().query(
    `
      UPDATE project_copies pc
      SET status=CASE
            WHEN l.status = 'expired' THEN 'expired'
            ELSE 'canceled'
          END,
          last_error=COALESCE(pc.last_error, 'parent operation ' || l.status),
          updated_at=now()
      FROM long_running_operations l
      WHERE pc.op_id = l.op_id
        AND pc.status = ANY($1::text[])
        AND l.status = ANY($2::text[])
      RETURNING pc.*
    `,
    [ACTIVE_STATUSES, TERMINAL_LRO_STATUSES],
  );
  return rows as ProjectCopyRow[];
}

async function refreshCopyOperation(op_id: string): Promise<void> {
  try {
    const lro = await getLro(op_id);
    if (lro?.status && TERMINAL_LRO_STATUSES.includes(lro.status)) {
      await publishLroSummary({
        scope_type: lro.scope_type,
        scope_id: lro.scope_id,
        summary: lro,
      });
      return;
    }
    const { rows } = await pool().query(
      `
        SELECT status, COUNT(*)::int AS count, MAX(last_error) AS last_error
        FROM project_copies
        WHERE op_id=$1
        GROUP BY status
      `,
      [op_id],
    );
    if (!rows.length) return;
    const summary: Record<string, number> = {};
    let total = 0;
    let failed = 0;
    let lastError: string | null = null;
    for (const row of rows) {
      const count = Number(row.count ?? 0);
      summary[row.status] = count;
      total += count;
      if (row.status === "failed") {
        failed += count;
        if (!lastError && row.last_error) {
          lastError = row.last_error;
        }
      }
    }
    const queued = summary.queued ?? 0;
    const applying = summary.applying ?? 0;
    const done = summary.done ?? 0;
    const canceled = summary.canceled ?? 0;
    const expired = summary.expired ?? 0;
    const remaining = queued + applying;
    let status: LroStatus = "running";
    if (remaining === 0) {
      status = failed > 0 ? "failed" : "succeeded";
    }
    const progress_summary = {
      total,
      queued,
      applying,
      done,
      failed,
      canceled,
      expired,
    };
    const updated = await updateLro({
      op_id,
      status,
      progress_summary,
      error: status === "failed" ? lastError : null,
      result:
        status === "succeeded"
          ? { ...(lro?.result ?? {}), ...progress_summary }
          : undefined,
    });
    if (updated) {
      await publishLroSummary({
        scope_type: updated.scope_type,
        scope_id: updated.scope_id,
        summary: updated,
      });
    }
  } catch (err) {
    logger.warn("refreshCopyOperation failed", { op_id, err: `${err}` });
  }
}

export type ProjectCopyKey = {
  src_project_id: string;
  src_path: string;
  dest_project_id: string;
  dest_path: string;
};

export type ProjectCopyInsert = ProjectCopyKey & {
  op_id?: string;
  snapshot_id: string;
  // True only if this copy made the backup snapshot_id itself.  Only such
  // snapshots are ever deleted when the copy finishes.
  snapshot_created: boolean;
  options?: any;
  exact?: boolean;
  expires_at: Date;
};

const pool = () => getPool();

// Run once per process: the setup includes ALTER TABLE, which takes an ACCESS
// EXCLUSIVE lock even when nothing changes and queues every later query on the
// table behind any open transaction (production outage 2026-10-06).
let copySchemaReady: Promise<void> | undefined;

export async function ensureCopySchema(): Promise<void> {
  // Share one setup among concurrent callers; retry after a failure.
  copySchemaReady ??= createCopySchema().catch((err) => {
    copySchemaReady = undefined;
    throw err;
  });
  await copySchemaReady;
}

async function createCopySchema(): Promise<void> {
  await pool().query(`
    CREATE TABLE IF NOT EXISTS project_copies (
      copy_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      src_project_id UUID NOT NULL,
      src_path TEXT NOT NULL,
      dest_project_id UUID NOT NULL,
      dest_path TEXT NOT NULL,
      op_id UUID,
      snapshot_id TEXT NOT NULL,
      options JSONB DEFAULT '{}'::jsonb,
      exact BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL,
      last_error TEXT,
      attempt INTEGER DEFAULT 0,
      last_attempt_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
  await pool().query(
    "ALTER TABLE project_copies ADD COLUMN IF NOT EXISTS copy_id UUID DEFAULT gen_random_uuid()",
  );
  await pool().query(
    "UPDATE project_copies SET copy_id = gen_random_uuid() WHERE copy_id IS NULL",
  );
  await pool().query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'project_copies'
          AND c.contype = 'p'
          AND pg_get_constraintdef(c.oid) <> 'PRIMARY KEY (copy_id)'
      ) THEN
        ALTER TABLE project_copies DROP CONSTRAINT project_copies_pkey;
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'project_copies'
          AND c.contype = 'p'
          AND pg_get_constraintdef(c.oid) = 'PRIMARY KEY (copy_id)'
      ) THEN
        ALTER TABLE project_copies ADD PRIMARY KEY (copy_id);
      END IF;
    END $$;
  `);
  await pool().query(
    "ALTER TABLE project_copies ADD COLUMN IF NOT EXISTS op_id UUID",
  );
  await pool().query(
    "ALTER TABLE project_copies ADD COLUMN IF NOT EXISTS exact BOOLEAN NOT NULL DEFAULT FALSE",
  );
  // NULL (rows written before this column existed) means "not created".
  await pool().query(
    "ALTER TABLE project_copies ADD COLUMN IF NOT EXISTS snapshot_created BOOLEAN",
  );
  // A row here means cleanup decided to delete this backup snapshot and may
  // have done so; no copy may start using it again.
  await pool().query(`
    CREATE TABLE IF NOT EXISTS project_copy_snapshot_claims (
      src_project_id UUID NOT NULL,
      snapshot_id TEXT NOT NULL,
      claimed_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (src_project_id, snapshot_id)
    )
  `);
  await pool().query(
    "CREATE INDEX IF NOT EXISTS project_copies_status_idx ON project_copies(status)",
  );
  await pool().query(
    "CREATE INDEX IF NOT EXISTS project_copies_snapshot_idx ON project_copies(snapshot_id)",
  );
  await pool().query(
    "CREATE INDEX IF NOT EXISTS project_copies_op_idx ON project_copies(op_id)",
  );
  await pool().query(
    "CREATE INDEX IF NOT EXISTS project_copies_dest_idx ON project_copies(dest_project_id)",
  );
  await pool().query(
    "CREATE INDEX IF NOT EXISTS project_copies_expires_idx ON project_copies(expires_at)",
  );
  await pool().query(
    "CREATE INDEX IF NOT EXISTS project_copies_dest_status_created_idx ON project_copies(dest_project_id, dest_path, status, created_at, updated_at)",
  );
  await pool().query(
    "CREATE UNIQUE INDEX IF NOT EXISTS project_copies_op_key_idx ON project_copies(op_id, src_project_id, src_path, dest_project_id, dest_path)",
  );
}

type CopyDb = {
  query: (
    sql: string,
    params?: any[],
  ) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

/** The snapshot was claimed for deletion; the copy must use another backup. */
export class CopySnapshotUnavailableError extends Error {
  constructor(readonly snapshot_id: string) {
    super(
      `backup snapshot ${snapshot_id} is being removed; use another backup`,
    );
    this.name = "CopySnapshotUnavailableError";
  }
}

let copySnapshotLockTimeoutMs = 60_000;

/** Tests only: how long to wait for a snapshot's lock. */
export function setCopySnapshotLockTimeoutForTests(ms: number): void {
  copySnapshotLockTimeoutMs = ms;
}

export class CopySnapshotLockTimeoutError extends Error {
  constructor(readonly what: string) {
    super(`timed out waiting for the lock on ${what}`);
    this.name = "CopySnapshotLockTimeoutError";
  }
}

// Queueing a copy of a backup snapshot and deciding to delete that snapshot
// are serialized per source project and snapshot.  The locks are session
// advisory locks on one connection checked out for the whole operation;
// everything decided under them runs on that connection, and no transaction
// stays open across host calls.  They only order live callers: Postgres drops
// session locks with the connection, so crash safety comes from the durable
// cleanup claim, not from the locks.
type LockSession = { db: CopyDb; poisoned: boolean };

async function withLockSession<T>(
  fn: (session: LockSession) => Promise<T>,
): Promise<T> {
  const client = await pool().connect();
  const session: LockSession = { db: client, poisoned: false };
  try {
    return await fn(session);
  } finally {
    // A connection whose locks were not all confirmed released is closed,
    // never returned to the pool.
    client.release(session.poisoned ? true : undefined);
  }
}

async function withSessionLock<T>(
  session: LockSession,
  key: string,
  label: string,
  fn: (db: CopyDb) => Promise<T>,
): Promise<T> {
  // Bounded wait, so a stuck holder can't block copies forever.
  const deadline = Date.now() + copySnapshotLockTimeoutMs;
  let delay = 20;
  while (true) {
    let locked: boolean;
    try {
      const { rows } = await session.db.query(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
        [key],
      );
      locked = rows[0]?.locked === true;
    } catch (err) {
      session.poisoned = true;
      throw err;
    }
    if (locked) break;
    if (Date.now() >= deadline) {
      throw new CopySnapshotLockTimeoutError(label);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(500, delay * 2);
  }
  try {
    return await fn(session.db);
  } finally {
    let unlocked = false;
    try {
      const { rows } = await session.db.query(
        "SELECT pg_advisory_unlock(hashtext($1)) AS unlocked",
        [key],
      );
      unlocked = (rows[0]?.unlocked ?? rows[0]?.pg_advisory_unlock) === true;
    } catch (err) {
      logger.warn("advisory unlock failed", { label, err: `${err}` });
    }
    if (!unlocked) session.poisoned = true;
  }
}

// Lock order: a copy row's lock (requeues only) is always taken before any
// snapshot lock, and at most one snapshot lock is held at a time, all on the
// same connection, so these locks can't deadlock or need a second connection.
async function withCopySnapshotLock<T>(
  session: LockSession | undefined,
  {
    src_project_id,
    snapshot_id,
  }: { src_project_id: string; snapshot_id: string },
  fn: (db: CopyDb) => Promise<T>,
): Promise<T> {
  const lock = async (s: LockSession) =>
    await withSessionLock(
      s,
      `project-copy-snapshot:${src_project_id}:${snapshot_id}`,
      `backup snapshot ${snapshot_id}`,
      fn,
    );
  return session ? await lock(session) : await withLockSession(lock);
}

function copyRowLockKey(row: {
  op_id?: string | null;
  src_project_id: string;
  src_path: string;
  dest_project_id: string;
  dest_path: string;
}): string {
  return `project-copy-row:${JSON.stringify([
    row.op_id ?? null,
    row.src_project_id,
    row.src_path,
    row.dest_project_id,
    row.dest_path,
  ])}`;
}

async function assertSnapshotNotClaimed(
  db: CopyDb,
  src_project_id: string,
  snapshot_id: string,
): Promise<void> {
  const { rows } = await db.query(
    `SELECT 1 FROM project_copy_snapshot_claims
      WHERE src_project_id=$1 AND snapshot_id=$2`,
    [src_project_id, snapshot_id],
  );
  if (rows.length > 0) {
    throw new CopySnapshotUnavailableError(snapshot_id);
  }
}

async function snapshotRefs(
  db: CopyDb,
  src_project_id: string,
  snapshot_id: string,
): Promise<{
  total: number;
  active: number;
  notCreated: number;
}> {
  const { rows } = await db.query(
    `
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (WHERE status = ANY($3::text[])) AS active,
             COUNT(*) FILTER (WHERE snapshot_created IS NOT TRUE) AS not_created
      FROM project_copies
      WHERE src_project_id=$1 AND snapshot_id=$2
    `,
    [src_project_id, snapshot_id, ACTIVE_STATUSES],
  );
  return {
    total: Number(rows[0]?.total ?? 0),
    active: Number(rows[0]?.active ?? 0),
    notCreated: Number(rows[0]?.not_created ?? 0),
  };
}

// Delete a copy's backup snapshot once no copy needs it, but ONLY if every
// copy that ever referenced it made that snapshot itself.  A reused backup
// (any backup of the source project, e.g. one its owner made), a snapshot
// given by the caller, or a row written before the flag existed is never
// deleted.  The decision and a durable claim are made under the snapshot's
// lock before the host is asked to delete; the claim is never removed, since
// a failed or lost response may still have deleted the snapshot.
async function maybeCleanupSnapshot({
  src_project_id,
  snapshot_id,
  replacedCreated = false,
  session,
}: {
  src_project_id: string;
  snapshot_id: string;
  // The caller's lock session, if it already holds a copy row's lock.
  session?: LockSession;
  // The caller made this snapshot and no row of its own counts it (a requeue
  // replaced that row, or the copy failed before queueing one).
  replacedCreated?: boolean;
}): Promise<void> {
  let claimed: boolean;
  try {
    claimed = await withCopySnapshotLock(
      session,
      { src_project_id, snapshot_id },
      async (db) => {
        const refs = await snapshotRefs(db, src_project_id, snapshot_id);
        if (
          refs.active > 0 ||
          (refs.total === 0 && !replacedCreated) ||
          refs.notCreated > 0
        ) {
          logger.debug("snapshot cleanup skipped", {
            src_project_id,
            snapshot_id,
            ...refs,
          });
          return false;
        }
        const { rows } = await db.query(
          `INSERT INTO project_copy_snapshot_claims (src_project_id, snapshot_id)
           VALUES ($1, $2)
           ON CONFLICT (src_project_id, snapshot_id) DO NOTHING
           RETURNING 1`,
          [src_project_id, snapshot_id],
        );
        // An existing claim means another cleanup already asked for deletion.
        return rows.length > 0;
      },
    );
  } catch (err) {
    // Without the lock nothing is decided: the snapshot is kept, possibly
    // leaked, and never deleted unlocked.
    logger.warn("snapshot cleanup skipped: lock unavailable", {
      src_project_id,
      snapshot_id,
      err: `${err}`,
    });
    return;
  }
  if (!claimed) return;
  try {
    await (
      await getProjectFileServerClient({ project_id: src_project_id })
    ).deleteBackup({
      project_id: src_project_id,
      id: snapshot_id,
    });
  } catch (err) {
    logger.warn("snapshot cleanup failed", {
      src_project_id,
      snapshot_id,
      err: `${err}`,
    });
  }
}

/** Clean up a backup the caller made for a copy that then failed: deleted only
 * if no copy row still needs it and every row referencing it made it. */
export async function releaseCreatedCopySnapshot({
  src_project_id,
  snapshot_id,
}: {
  src_project_id: string;
  snapshot_id: string;
}): Promise<void> {
  await ensureCopySchema();
  await maybeCleanupSnapshot({
    src_project_id,
    snapshot_id,
    replacedCreated: true,
  });
}

export async function expireCopies(): Promise<ProjectCopyRow[]> {
  await ensureCopySchema();
  const terminalParentRows = await reconcileTerminalParentCopyRows();
  const { rows } = await pool().query(
    `
      UPDATE project_copies
      SET status='expired',
          last_error=COALESCE(last_error, 'expired'),
          updated_at=now()
      WHERE expires_at <= now()
        AND status <> ALL($1::text[])
      RETURNING *
    `,
    [TERMINAL_STATUSES],
  );
  const expired = [...terminalParentRows, ...(rows as ProjectCopyRow[])];
  const seen = new Set<string>();
  const opIds = new Set<string>();
  for (const row of expired) {
    const key = `${row.src_project_id}:${row.snapshot_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await maybeCleanupSnapshot({
      src_project_id: row.src_project_id,
      snapshot_id: row.snapshot_id,
    });
    if (row.op_id) {
      opIds.add(row.op_id);
    }
  }
  for (const op_id of opIds) {
    await refreshCopyOperation(op_id);
  }
  return expired;
}

export async function upsertCopyRow(
  row: ProjectCopyInsert,
): Promise<ProjectCopyRow> {
  await ensureCopySchema();
  // Requeues of the same row are serialized for the whole change, including
  // the cleanup of the snapshot it replaces; under that, the new and the
  // replaced snapshot are locked one after the other, never together.
  return await withLockSession(
    async (session) =>
      await withSessionLock(
        session,
        copyRowLockKey(row),
        "a copy row",
        async () => await upsertCopyRowLocked(session, row),
      ),
  );
}

async function upsertCopyRowLocked(
  session: LockSession,
  row: ProjectCopyInsert,
): Promise<ProjectCopyRow> {
  const {
    src_project_id,
    src_path,
    dest_project_id,
    dest_path,
    op_id,
    snapshot_id,
    snapshot_created,
    options,
    exact = false,
    expires_at,
  } = row;
  const { prevSnapshot, prevCreated, updated } = await withCopySnapshotLock(
    session,
    { src_project_id, snapshot_id },
    async (db) => {
      await assertSnapshotNotClaimed(db, src_project_id, snapshot_id);
      const existing = await db.query(
        `
          SELECT snapshot_id, snapshot_created
          FROM project_copies
          WHERE op_id IS NOT DISTINCT FROM $1
            AND src_project_id=$2
            AND src_path=$3
            AND dest_project_id=$4
            AND dest_path=$5
        `,
        [op_id ?? null, src_project_id, src_path, dest_project_id, dest_path],
      );
      const { rows } = await db.query(
        `
          INSERT INTO project_copies
            (src_project_id, src_path, dest_project_id, dest_path, op_id, snapshot_id, snapshot_created, options, exact, status, attempt, last_attempt_at, expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$10,$7,$8,'queued',0,NULL,$9)
          ON CONFLICT (op_id, src_project_id, src_path, dest_project_id, dest_path) DO UPDATE
            SET op_id=EXCLUDED.op_id,
                snapshot_id=EXCLUDED.snapshot_id,
                snapshot_created=EXCLUDED.snapshot_created,
                options=EXCLUDED.options,
                exact=EXCLUDED.exact,
                status='queued',
                last_error=NULL,
                attempt=0,
                last_attempt_at=NULL,
                updated_at=now(),
                expires_at=EXCLUDED.expires_at
          RETURNING *
        `,
        [
          src_project_id,
          src_path,
          dest_project_id,
          dest_path,
          op_id ?? null,
          snapshot_id,
          options ?? null,
          exact,
          expires_at,
          snapshot_created === true,
        ],
      );
      return {
        prevSnapshot: existing.rows[0]?.snapshot_id as string | undefined,
        prevCreated: existing.rows[0]?.snapshot_created === true,
        updated: rows[0] as ProjectCopyRow,
      };
    },
  );
  if (prevSnapshot && prevSnapshot !== snapshot_id) {
    await maybeCleanupSnapshot({
      src_project_id,
      snapshot_id: prevSnapshot,
      replacedCreated: prevCreated,
      session,
    });
  }
  return updated;
}

export async function insertCopyRowIfMissing(
  row: ProjectCopyInsert,
): Promise<ProjectCopyRow | undefined> {
  await ensureCopySchema();
  const {
    src_project_id,
    src_path,
    dest_project_id,
    dest_path,
    op_id,
    snapshot_id,
    snapshot_created,
    options,
    exact = false,
    expires_at,
  } = row;
  return await withCopySnapshotLock(
    undefined,
    { src_project_id, snapshot_id },
    async (db) => {
      await assertSnapshotNotClaimed(db, src_project_id, snapshot_id);
      const { rows } = await db.query(
        `
          INSERT INTO project_copies
            (src_project_id, src_path, dest_project_id, dest_path, op_id, snapshot_id, snapshot_created, options, exact, status, attempt, last_attempt_at, expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$10,$7,$8,'queued',0,NULL,$9)
          ON CONFLICT (op_id, src_project_id, src_path, dest_project_id, dest_path) DO NOTHING
          RETURNING *
        `,
        [
          src_project_id,
          src_path,
          dest_project_id,
          dest_path,
          op_id ?? null,
          snapshot_id,
          options ?? null,
          exact,
          expires_at,
          snapshot_created === true,
        ],
      );
      return rows[0] as ProjectCopyRow | undefined;
    },
  );
}

export async function listCopiesForProject({
  project_id,
  include_completed = false,
}: {
  project_id: string;
  include_completed?: boolean;
}): Promise<ProjectCopyRow[]> {
  await expireCopies();
  const params: any[] = [project_id];
  let statusClause = "";
  if (!include_completed) {
    params.push(ACTIVE_STATUSES);
    statusClause = "AND status = ANY($2::text[])";
  }
  const { rows } = await pool().query(
    `
      SELECT *
      FROM project_copies
      WHERE (src_project_id=$1 OR dest_project_id=$1)
      ${statusClause}
      ORDER BY created_at DESC
    `,
    params,
  );
  return rows as ProjectCopyRow[];
}

export async function listCopiesByOpId({
  op_id,
}: {
  op_id: string;
}): Promise<ProjectCopyRow[]> {
  await ensureCopySchema();
  const { rows } = await pool().query(
    `
      SELECT *
      FROM project_copies
      WHERE op_id=$1
      ORDER BY created_at DESC
    `,
    [op_id],
  );
  return rows as ProjectCopyRow[];
}

export async function cancelCopy(
  key: ProjectCopyKey,
): Promise<ProjectCopyRow | undefined> {
  await expireCopies();
  const { src_project_id, src_path, dest_project_id, dest_path } = key;
  const { rows } = await pool().query(
    `
      WITH candidate AS (
        SELECT copy_id
        FROM project_copies
        WHERE src_project_id=$1
          AND src_path=$2
          AND dest_project_id=$3
          AND dest_path=$4
          AND status <> ALL($5::text[])
        ORDER BY created_at
        LIMIT 1
      )
      UPDATE project_copies pc
      SET status='canceled',
          last_error=COALESCE(last_error, 'canceled'),
          updated_at=now()
      FROM candidate
      WHERE pc.copy_id = candidate.copy_id
      RETURNING pc.*
    `,
    [src_project_id, src_path, dest_project_id, dest_path, TERMINAL_STATUSES],
  );
  const updated = rows[0] as ProjectCopyRow | undefined;
  if (updated) {
    await maybeCleanupSnapshot({
      src_project_id: updated.src_project_id,
      snapshot_id: updated.snapshot_id,
    });
    if (updated.op_id) {
      await refreshCopyOperation(updated.op_id);
    }
  }
  return updated;
}

export async function cancelCopiesByOpId({
  op_id,
  include_applying = false,
}: {
  op_id: string;
  include_applying?: boolean;
}): Promise<ProjectCopyRow[]> {
  await expireCopies();
  const statuses = include_applying
    ? ["queued", "failed", "applying"]
    : ["queued", "failed"];
  const { rows } = await pool().query(
    `
      UPDATE project_copies
      SET status='canceled',
          last_error=COALESCE(last_error, 'canceled'),
          updated_at=now()
      WHERE op_id=$1
        AND status = ANY($2::text[])
      RETURNING *
    `,
    [op_id, statuses],
  );
  const updatedRows = rows as ProjectCopyRow[];
  const seen = new Set<string>();
  for (const row of updatedRows) {
    const key = `${row.src_project_id}:${row.snapshot_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await maybeCleanupSnapshot({
      src_project_id: row.src_project_id,
      snapshot_id: row.snapshot_id,
    });
  }
  await refreshCopyOperation(op_id);
  return updatedRows;
}

export async function claimPendingCopies({
  host_id,
  project_id,
  limit = 20,
}: {
  host_id: string;
  project_id?: string;
  limit?: number;
}): Promise<ProjectCopyRow[]> {
  await expireCopies();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const values: any[] = [host_id, CLAIMABLE_STATUSES, STALE_APPLYING_MS];
    let projectFilter = "";
    let limitIndex = 4;
    if (project_id) {
      values.push(project_id);
      projectFilter = "AND pc.dest_project_id=$4";
      limitIndex = 5;
    }
    values.push(limit);
    const staleApplying = staleApplyingIntervalSql(3);
    const { rows } = await client.query(
      `
        WITH candidates AS (
          SELECT pc.copy_id
          FROM project_copies pc
          JOIN projects p ON p.project_id = pc.dest_project_id
          WHERE p.host_id=$1
            AND (
              pc.status = ANY($2::text[])
              OR (
                pc.status = 'applying'
                AND COALESCE(pc.last_attempt_at, pc.updated_at, pc.created_at) < ${staleApplying}
              )
            )
            AND pc.expires_at > now()
            ${projectFilter}
            AND NOT EXISTS (
              SELECT 1
              FROM project_copies blocker
              WHERE blocker.dest_project_id = pc.dest_project_id
                AND blocker.dest_path = pc.dest_path
                AND blocker.status = 'applying'
                AND COALESCE(blocker.last_attempt_at, blocker.updated_at, blocker.created_at) >= ${staleApplying}
            )
            AND NOT EXISTS (
              SELECT 1
              FROM project_copies earlier
              WHERE earlier.dest_project_id = pc.dest_project_id
                AND earlier.dest_path = pc.dest_path
                AND (
                  earlier.status = ANY($2::text[])
                  OR (
                    earlier.status = 'applying'
                    AND COALESCE(earlier.last_attempt_at, earlier.updated_at, earlier.created_at) < ${staleApplying}
                  )
                )
                AND earlier.expires_at > now()
                AND (
                  earlier.created_at < pc.created_at
                  OR (
                    earlier.created_at = pc.created_at
                    AND earlier.copy_id < pc.copy_id
                  )
                )
            )
          ORDER BY pc.updated_at, pc.created_at, pc.copy_id
          FOR UPDATE OF pc SKIP LOCKED
          LIMIT $${limitIndex}
        )
        UPDATE project_copies pc
        SET status='applying',
            attempt=attempt+1,
            last_error=NULL,
            last_attempt_at=now(),
            updated_at=now()
        FROM candidates
        WHERE pc.copy_id = candidates.copy_id
        RETURNING pc.*
      `,
      values,
    );
    if (!rows.length) {
      await client.query("COMMIT");
      return [];
    }
    await client.query("COMMIT");
    const opIds = new Set<string>();
    for (const row of rows as ProjectCopyRow[]) {
      if (row.op_id) {
        opIds.add(row.op_id);
      }
    }
    for (const op_id of opIds) {
      await refreshCopyOperation(op_id);
    }
    return rows as ProjectCopyRow[];
  } catch (err) {
    await client.query("ROLLBACK");
    logger.warn("claimPendingCopies failed", { err });
    throw err;
  } finally {
    client.release();
  }
}

export async function updateCopyStatus({
  copy_id,
  key,
  status,
  last_error,
}: {
  copy_id?: string;
  key: ProjectCopyKey;
  status: ProjectCopyState;
  last_error?: string;
}): Promise<ProjectCopyRow | undefined> {
  await ensureCopySchema();
  const { src_project_id, src_path, dest_project_id, dest_path } = key;
  const { rows } = await pool().query(
    `
      WITH candidate AS (
        SELECT copy_id
        FROM project_copies
        WHERE (
              copy_id = $7
              OR (
                $7::uuid IS NULL
                AND src_project_id=$1
                AND src_path=$2
                AND dest_project_id=$3
                AND dest_path=$4
                AND status <> ALL($8::text[])
              )
            )
        ORDER BY
          CASE
            WHEN copy_id = $7 THEN 0
            WHEN status = 'applying' THEN 1
            WHEN status = 'queued' THEN 2
            WHEN status = 'failed' THEN 3
            ELSE 4
          END,
          created_at
        LIMIT 1
      )
      UPDATE project_copies pc
      SET status=$5,
          last_error=$6,
          updated_at=now()
      FROM candidate
      WHERE pc.copy_id = candidate.copy_id
      RETURNING pc.*
    `,
    [
      src_project_id,
      src_path,
      dest_project_id,
      dest_path,
      status,
      last_error ?? null,
      copy_id ?? null,
      TERMINAL_STATUSES,
    ],
  );
  const updated = rows[0] as ProjectCopyRow | undefined;
  if (
    updated &&
    (status === "done" || status === "canceled" || status === "expired")
  ) {
    await maybeCleanupSnapshot({
      src_project_id: updated.src_project_id,
      snapshot_id: updated.snapshot_id,
    });
  }
  if (updated?.op_id) {
    await refreshCopyOperation(updated.op_id);
  }
  return updated;
}
