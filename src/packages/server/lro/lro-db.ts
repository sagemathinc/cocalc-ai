import { randomUUID } from "node:crypto";
import getLogger from "@cocalc/backend/logger";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import { createIndexConcurrentlyBestEffort } from "../database/concurrent-index";
import type {
  LroScopeType,
  LroStatus,
  LroSummary,
} from "@cocalc/conat/hub/api/lro";

const TERMINAL_STATUSES: LroStatus[] = [
  "succeeded",
  "failed",
  "canceled",
  "expired",
];

const pool = () => getPool();
const logger = getLogger("server:lro:lro-db");
let ensuredSchema: Promise<void> | undefined;
let expiryIndexReady: Promise<void> | undefined;

async function ensureExpiryIndexBestEffort(): Promise<void> {
  await createIndexConcurrentlyBestEffort({
    name: "lro_expiry_idx",
    sql: "CREATE INDEX CONCURRENTLY IF NOT EXISTS lro_expiry_idx ON long_running_operations(expires_at) WHERE dismissed_at IS NULL AND status IN ('queued', 'running')",
  });
}

async function hasColumn({
  client,
  table,
  column,
}: {
  client: PoolClient;
  table: string;
  column: string;
}): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `
    SELECT EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema='public'
         AND table_name=$1
         AND column_name=$2
    ) AS exists
    `,
    [table, column],
  );
  return result.rows[0]?.exists === true;
}

async function addColumnIfMissing({
  client,
  table,
  column,
  definition,
}: {
  client: PoolClient;
  table: string;
  column: string;
  definition: string;
}): Promise<void> {
  if (await hasColumn({ client, table, column })) return;
  await client.query(
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`,
  );
}

async function ensureLroSchemaInternal(): Promise<void> {
  const client = await pool().connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [
      "cocalc:lro-schema",
    ]);
    locked = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS long_running_operations (
        op_id UUID PRIMARY KEY,
        kind TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        scope_id UUID NOT NULL,
        status TEXT NOT NULL,
        created_by UUID,
        owner_type TEXT,
        owner_id UUID,
        routing TEXT,
        input JSONB DEFAULT '{}'::jsonb,
        result JSONB DEFAULT '{}'::jsonb,
        error TEXT,
        progress_summary JSONB DEFAULT '{}'::jsonb,
        attempt INTEGER DEFAULT 0,
        heartbeat_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT now(),
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        dismissed_at TIMESTAMPTZ,
        dismissed_by UUID,
        updated_at TIMESTAMPTZ DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        dedupe_key TEXT,
        parent_id UUID
      )
    `);
    await client.query(
      "CREATE INDEX IF NOT EXISTS lro_scope_status_idx ON long_running_operations(scope_type, scope_id, status)",
    );
    await client.query(
      "CREATE INDEX IF NOT EXISTS lro_owner_status_idx ON long_running_operations(owner_type, owner_id, status)",
    );
    await client.query(
      "CREATE INDEX IF NOT EXISTS lro_dedupe_idx ON long_running_operations(dedupe_key, scope_type, scope_id)",
    );
    await client.query(
      "CREATE INDEX IF NOT EXISTS lro_updated_idx ON long_running_operations(updated_at)",
    );
    await addColumnIfMissing({
      client,
      table: "long_running_operations",
      column: "dismissed_at",
      definition: "TIMESTAMPTZ",
    });
    await addColumnIfMissing({
      client,
      table: "long_running_operations",
      column: "dismissed_by",
      definition: "UUID",
    });
    await addColumnIfMissing({
      client,
      table: "long_running_operations",
      column: "parent_id",
      definition: "UUID",
    });
    await client.query(
      "CREATE INDEX IF NOT EXISTS lro_parent_idx ON long_running_operations(parent_id)",
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS scheduled_collection_expiry_repairs (
        actor_id UUID NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_sha256 TEXT NOT NULL,
        reason TEXT NOT NULL,
        receipt JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (actor_id, idempotency_key)
      )
    `);
  } finally {
    if (locked) {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [
          "cocalc:lro-schema",
        ]);
      } catch {}
    }
    client.release();
  }
}

export async function ensureLroSchema(): Promise<void> {
  ensuredSchema ??= ensureLroSchemaInternal().catch((err) => {
    ensuredSchema = undefined;
    throw err;
  });
  await ensuredSchema;
  expiryIndexReady ??= ensureExpiryIndexBestEffort().catch((err) => {
    expiryIndexReady = undefined;
    logger.warn("failed to initialize LRO expiration index", { err: `${err}` });
  });
  await expiryIndexReady;
}

export async function createLro({
  kind,
  scope_type,
  scope_id,
  created_by,
  owner_type,
  owner_id,
  routing,
  input,
  dedupe_key,
  parent_id,
  expires_at,
  status = "queued",
}: {
  kind: string;
  scope_type: LroScopeType;
  scope_id: string;
  created_by?: string;
  owner_type?: "hub" | "host";
  owner_id?: string;
  routing?: string;
  input?: any;
  dedupe_key?: string;
  parent_id?: string;
  expires_at?: Date;
  status?: LroStatus;
}): Promise<LroSummary> {
  return (
    await createLroDetailed({
      kind,
      scope_type,
      scope_id,
      created_by,
      owner_type,
      owner_id,
      routing,
      input,
      dedupe_key,
      parent_id,
      expires_at,
      status,
    })
  ).lro;
}

export async function createLroDetailed({
  kind,
  scope_type,
  scope_id,
  created_by,
  owner_type,
  owner_id,
  routing,
  input,
  dedupe_key,
  reuse_terminal_dedupe = false,
  parent_id,
  expires_at,
  status = "queued",
}: {
  kind: string;
  scope_type: LroScopeType;
  scope_id: string;
  created_by?: string;
  owner_type?: "hub" | "host";
  owner_id?: string;
  routing?: string;
  input?: any;
  dedupe_key?: string;
  reuse_terminal_dedupe?: boolean;
  parent_id?: string;
  expires_at?: Date;
  status?: LroStatus;
}): Promise<{ lro: LroSummary; created: boolean }> {
  await ensureLroSchema();
  const op_id = randomUUID();
  const expires = expires_at ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const values = [
    op_id,
    kind,
    scope_type,
    scope_id,
    status,
    created_by ?? null,
    owner_type ?? null,
    owner_id ?? null,
    routing ?? null,
    input ?? null,
    expires,
    dedupe_key ?? null,
    parent_id ?? null,
  ];
  const insert = `
    INSERT INTO long_running_operations
      (op_id, kind, scope_type, scope_id, status, created_by, owner_type, owner_id, routing, input, expires_at, dedupe_key, parent_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    RETURNING *
  `;
  if (!dedupe_key) {
    const { rows } = await pool().query(insert, values);
    return { lro: rows[0] as LroSummary, created: true };
  }

  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `cocalc:lro-dedupe:${scope_type}:${scope_id}:${dedupe_key}`,
    ]);
    const terminalClause = reuse_terminal_dedupe
      ? ""
      : "AND status <> ALL($4::text[])";
    const existing = await client.query(
      `
        SELECT *
        FROM long_running_operations
        WHERE scope_type=$1
          AND scope_id=$2
          AND dedupe_key=$3
          ${terminalClause}
        ORDER BY created_at DESC
        LIMIT 1
      `,
      reuse_terminal_dedupe
        ? [scope_type, scope_id, dedupe_key]
        : [scope_type, scope_id, dedupe_key, TERMINAL_STATUSES],
    );
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return { lro: existing.rows[0] as LroSummary, created: false };
    }
    const { rows } = await client.query(insert, values);
    await client.query("COMMIT");
    return { lro: rows[0] as LroSummary, created: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function updateLro({
  op_id,
  status,
  result,
  error,
  progress_summary,
  attempt,
  heartbeat_at,
  dismissed_at,
  dismissed_by,
  if_status,
}: {
  op_id: string;
  status?: LroStatus;
  result?: any;
  error?: string | null;
  progress_summary?: any;
  attempt?: number;
  heartbeat_at?: Date | null;
  dismissed_at?: Date | null;
  dismissed_by?: string | null;
  if_status?: LroStatus[];
}): Promise<LroSummary | undefined> {
  await ensureLroSchema();
  const sets: string[] = [];
  const values: any[] = [op_id];
  let idx = 2;
  if (status !== undefined) {
    sets.push(`status=$${idx++}`);
    values.push(status);
    if (status === "running") {
      sets.push(`started_at=COALESCE(started_at, now())`);
    }
    if (TERMINAL_STATUSES.includes(status)) {
      sets.push(`finished_at=COALESCE(finished_at, now())`);
    }
  }
  if (result !== undefined) {
    sets.push(`result=$${idx++}`);
    values.push(result ?? null);
  }
  if (error !== undefined) {
    sets.push(`error=$${idx++}`);
    values.push(error);
  }
  if (progress_summary !== undefined) {
    sets.push(`progress_summary=$${idx++}`);
    values.push(progress_summary ?? null);
  }
  if (attempt !== undefined) {
    sets.push(`attempt=$${idx++}`);
    values.push(attempt);
  }
  if (heartbeat_at !== undefined) {
    sets.push(`heartbeat_at=$${idx++}`);
    values.push(heartbeat_at);
  }
  if (dismissed_at !== undefined) {
    sets.push(`dismissed_at=$${idx++}`);
    values.push(dismissed_at);
  }
  if (dismissed_by !== undefined) {
    sets.push(`dismissed_by=$${idx++}`);
    values.push(dismissed_by);
  }
  if (!sets.length) {
    const row = await getLro(op_id);
    return row ?? undefined;
  }
  sets.push("updated_at=now()");
  let where = "op_id=$1";
  if (if_status !== undefined) {
    if (if_status.length === 0) return;
    values.push(if_status);
    where += ` AND status=ANY($${values.length}::text[])`;
  }
  const { rows } = await pool().query(
    `UPDATE long_running_operations SET ${sets.join(", ")} WHERE ${where} RETURNING *`,
    values,
  );
  return rows[0] as LroSummary | undefined;
}

export async function mergeLroResult({
  op_id,
  result,
  if_status,
}: {
  op_id: string;
  result: Record<string, unknown>;
  if_status: LroStatus[];
}): Promise<LroSummary | undefined> {
  await ensureLroSchema();
  if (if_status.length === 0) return;
  const { rows } = await pool().query(
    `UPDATE long_running_operations
        SET result = COALESCE(result, '{}'::jsonb) || $2::jsonb,
            updated_at = NOW()
      WHERE op_id=$1
        AND status=ANY($3::text[])
      RETURNING *`,
    [op_id, JSON.stringify(result), if_status],
  );
  return rows[0] as LroSummary | undefined;
}

export async function dismissLro({
  op_id,
  dismissed_by,
}: {
  op_id: string;
  dismissed_by?: string | null;
}): Promise<LroSummary | undefined> {
  return await updateLro({
    op_id,
    dismissed_at: new Date(),
    dismissed_by: dismissed_by ?? null,
  });
}

export async function expireDueLros({
  kind,
  limit = 1000,
}: {
  kind?: string;
  limit?: number;
} = {}): Promise<LroSummary[]> {
  await ensureLroSchema();
  const values: any[] = [["queued", "running"]];
  let kindClause = "";
  if (kind != null && `${kind}`.trim()) {
    values.push(`${kind}`.trim());
    kindClause = `AND kind=$${values.length}`;
  }
  values.push(Math.max(1, Math.min(10_000, Math.floor(limit))));
  const limitParam = `$${values.length}`;
  const { rows } = await pool().query(
    `
      WITH candidates AS (
        SELECT op_id
        FROM long_running_operations
        WHERE status = ANY($1::text[])
          AND dismissed_at IS NULL
          AND expires_at <= now()
          ${kindClause}
        ORDER BY expires_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${limitParam}
      )
      UPDATE long_running_operations
      SET status='expired',
          error=COALESCE(NULLIF(error, ''), 'expired'),
          finished_at=COALESCE(finished_at, now()),
          updated_at=now()
      FROM candidates
      WHERE long_running_operations.op_id = candidates.op_id
      RETURNING *
    `,
    values,
  );
  return rows as LroSummary[];
}

export async function listQueuedProjectBackupLroDeletionCandidates({
  limit = 1000,
  min_age_ms = 10 * 60 * 1000,
}: {
  limit?: number;
  min_age_ms?: number;
} = {}): Promise<LroSummary[]> {
  await ensureLroSchema();
  const boundedLimit = Math.max(1, Math.min(10_000, Math.floor(limit)));
  const boundedMinAge = Math.max(0, Math.floor(min_age_ms));
  const { rows } = await pool().query(
    `
      SELECT *
      FROM long_running_operations
      WHERE kind='project-backup'
        AND scope_type='project'
        AND status='queued'
        AND dismissed_at IS NULL
        AND NULLIF(BTRIM(input ->> 'owning_bay_id'), '') IS NOT NULL
        AND updated_at < NOW() - ($2::text || ' milliseconds')::interval
      ORDER BY updated_at, created_at
      LIMIT $1
    `,
    [boundedLimit, boundedMinAge],
  );
  return rows as LroSummary[];
}

export async function finishProjectBackupLroDeletionChecks({
  checked_op_ids,
  hard_deleted_op_ids,
}: {
  checked_op_ids: string[];
  hard_deleted_op_ids: string[];
}): Promise<LroSummary[]> {
  await ensureLroSchema();
  if (checked_op_ids.length === 0) return [];
  const { rows } = await pool().query(
    `
      WITH checked AS (
        UPDATE long_running_operations
        SET status = CASE
              WHEN op_id = ANY($2::uuid[]) THEN 'expired'
              ELSE status
            END,
            error = CASE
              WHEN op_id = ANY($2::uuid[])
                THEN 'project is authoritatively hard-deleted'
              ELSE error
            END,
            finished_at = CASE
              WHEN op_id = ANY($2::uuid[])
                THEN COALESCE(finished_at, NOW())
              ELSE finished_at
            END,
            updated_at = NOW()
        WHERE op_id = ANY($1::uuid[])
          AND kind='project-backup'
          AND scope_type='project'
          AND status='queued'
          AND dismissed_at IS NULL
        RETURNING *
      )
      SELECT * FROM checked WHERE status='expired'
    `,
    [checked_op_ids, hard_deleted_op_ids],
  );
  return rows as LroSummary[];
}

export async function getLro(op_id: string): Promise<LroSummary | undefined> {
  await ensureLroSchema();
  const { rows } = await pool().query(
    "SELECT * FROM long_running_operations WHERE op_id=$1",
    [op_id],
  );
  return rows[0] as LroSummary | undefined;
}

export async function listLrosByDedupe({
  scope_type,
  scope_id,
  dedupe_key,
}: {
  scope_type: LroScopeType;
  scope_id: string;
  dedupe_key: string;
}): Promise<LroSummary[]> {
  await ensureLroSchema();
  const { rows } = await pool().query(
    `SELECT *
       FROM long_running_operations
      WHERE scope_type=$1
        AND scope_id=$2
        AND dedupe_key=$3
      ORDER BY created_at DESC`,
    [scope_type, scope_id, dedupe_key],
  );
  return rows as LroSummary[];
}

export async function attestReleasedLroDedupeSuccesses({
  scope_type,
  scope_id,
  dedupe_key,
  expected_result_id,
  expected_generation,
}: {
  scope_type: LroScopeType;
  scope_id: string;
  dedupe_key: string;
  expected_result_id: string;
  expected_generation: number;
}): Promise<LroSummary[]> {
  await ensureLroSchema();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `cocalc:lro-dedupe:${scope_type}:${scope_id}:${dedupe_key}`,
    ]);
    const { rows } = await client.query(
      `SELECT *
         FROM long_running_operations
        WHERE scope_type=$1
          AND scope_id=$2
          AND dedupe_key=$3
          AND kind='project-backup'
        ORDER BY created_at DESC
        FOR UPDATE`,
      [scope_type, scope_id, dedupe_key],
    );
    const history = rows as LroSummary[];
    const matchingSuccess = history.some(({ status, result }) => {
      if (status !== "succeeded") return false;
      const id = `${result?.id ?? result?.backup_id ?? ""}`.trim();
      return (
        id === expected_result_id &&
        Number(result?.generation) === expected_generation
      );
    });
    if (!matchingSuccess) {
      throw new Error(
        "released LRO attestation does not match the final backup",
      );
    }
    // A checked host release is volume-wide, so no successful freeze under
    // this lifecycle identity remains eligible for reuse.
    await client.query(
      `UPDATE long_running_operations
          SET result = COALESCE(result, '{}'::jsonb) || $4::jsonb,
              updated_at = NOW()
        WHERE scope_type=$1
          AND scope_id=$2
          AND dedupe_key=$3
          AND kind='project-backup'
          AND status='succeeded'`,
      [
        scope_type,
        scope_id,
        dedupe_key,
        JSON.stringify({ archive_freeze_recovery: "released" }),
      ],
    );
    await client.query("COMMIT");
    return history;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listChildLro({
  parent_id,
}: {
  parent_id: string;
}): Promise<LroSummary[]> {
  await ensureLroSchema();
  const { rows } = await pool().query(
    `
      SELECT *
      FROM long_running_operations
      WHERE parent_id=$1
      ORDER BY created_at
    `,
    [parent_id],
  );
  return rows as LroSummary[];
}

export async function listLro({
  scope_type,
  scope_id,
  include_completed = false,
}: {
  scope_type: LroScopeType;
  scope_id: string;
  include_completed?: boolean;
}): Promise<LroSummary[]> {
  await ensureLroSchema();
  const values: any[] = [scope_type, scope_id];
  let statusClause = "";
  let dismissClause = "AND dismissed_at IS NULL";
  if (!include_completed) {
    values.push(TERMINAL_STATUSES);
    statusClause = "AND status <> ALL($3::text[])";
  }
  const { rows } = await pool().query(
    `
      SELECT *
      FROM long_running_operations
      WHERE scope_type=$1
        AND scope_id=$2
        ${dismissClause}
        ${statusClause}
      ORDER BY created_at DESC
    `,
    values,
  );
  return rows as LroSummary[];
}

export async function claimLroOps({
  kind,
  owner_type,
  owner_id,
  limit = 10,
  lease_ms = 120_000,
  input_not_before_key,
}: {
  kind: string;
  owner_type: "hub" | "host";
  owner_id: string;
  limit?: number;
  lease_ms?: number;
  input_not_before_key?: string;
}): Promise<LroSummary[]> {
  await ensureLroSchema();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `
        WITH candidate AS (
          SELECT op_id
          FROM long_running_operations
          WHERE kind=$1
            AND dismissed_at IS NULL
            AND expires_at > now()
            AND (
              $6::text IS NULL
              OR input ->> $6 IS NULL
              OR (input ->> $6)::timestamptz <= now()
            )
            AND (
              status='queued'
              OR (
                status='running'
                AND (heartbeat_at IS NULL OR heartbeat_at < now() - ($2::text || ' milliseconds')::interval)
              )
            )
          ORDER BY
            CASE WHEN status='queued' THEN 0 ELSE 1 END,
            updated_at
          FOR UPDATE SKIP LOCKED
          LIMIT $3
        )
        UPDATE long_running_operations
        SET owner_type=$4,
            owner_id=$5,
            heartbeat_at=now(),
            status=CASE WHEN status='queued' THEN 'running' ELSE status END,
            started_at=COALESCE(started_at, now()),
            attempt=attempt+1,
            updated_at=now()
        WHERE op_id IN (SELECT op_id FROM candidate)
        RETURNING *
      `,
      [
        kind,
        lease_ms,
        limit,
        owner_type,
        owner_id,
        input_not_before_key ?? null,
      ],
    );
    await client.query("COMMIT");
    return rows as LroSummary[];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function touchLro({
  op_id,
  owner_type,
  owner_id,
}: {
  op_id: string;
  owner_type: "hub" | "host";
  owner_id: string;
}): Promise<void> {
  await ensureLroSchema();
  await pool().query(
    `
      UPDATE long_running_operations
      SET heartbeat_at=now(),
          updated_at=now()
      WHERE op_id=$1
        AND owner_type=$2
        AND owner_id=$3
        AND status <> ALL($4::text[])
    `,
    [op_id, owner_type, owner_id, TERMINAL_STATUSES],
  );
}
