import { envToInt } from "@cocalc/backend/misc/env-to-number";
import getPool from "@cocalc/database/pool";

const pool = () => getPool();
const GLOBAL_SCOPE_ID = "";
const CACHE_TTL_MS = 5000;
const DEBUG_CAP_ENV = "COCALC_PARALLEL_OPS_DEBUG_CAP";
type EffectiveParallelOpsLimitSource =
  | "default"
  | "db-override"
  | "env-debug-cap";

export type ParallelOpsLimitScopeType = "global" | "provider" | "project_host";

export interface ParallelOpsLimitOverride {
  worker_kind: string;
  scope_type: ParallelOpsLimitScopeType;
  scope_id: string;
  limit_value: number;
  enabled: boolean;
  updated_at: Date;
  updated_by: string | null;
  note: string | null;
}

const cache = new Map<
  string,
  {
    expires_at: number;
    value: number;
    source: EffectiveParallelOpsLimitSource;
  }
>();

function cacheKey(worker_kind: string, scope_type: string, scope_id: string) {
  return `${worker_kind}:${scope_type}:${scope_id}`;
}

function normalizeScopeId(
  scope_type: ParallelOpsLimitScopeType,
  scope_id?: string,
): string {
  if (scope_type === "global") return GLOBAL_SCOPE_ID;
  return `${scope_id ?? ""}`.trim();
}

function getParallelOpsDebugCap(): number | null {
  const cap = envToInt(DEBUG_CAP_ENV, 0);
  if (!Number.isFinite(cap) || cap <= 0) return null;
  return Math.max(1, cap);
}

function applyDebugCap({
  value,
  source,
}: {
  value: number;
  source: "default" | "db-override";
}): { value: number; source: EffectiveParallelOpsLimitSource } {
  const cap = getParallelOpsDebugCap();
  if (cap == null) {
    return { value, source };
  }
  return { value: Math.min(value, cap), source: "env-debug-cap" };
}

export async function ensureParallelOpsLimitSchema(): Promise<void> {
  await pool().query(`
    CREATE TABLE IF NOT EXISTS parallel_ops_limits (
      worker_kind TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL DEFAULT '',
      limit_value INTEGER NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by UUID,
      note TEXT,
      PRIMARY KEY (worker_kind, scope_type, scope_id)
    )
  `);
  await pool().query(
    "CREATE INDEX IF NOT EXISTS parallel_ops_limits_scope_idx ON parallel_ops_limits(scope_type, scope_id)",
  );
}

export async function listParallelOpsLimitOverrides(): Promise<
  ParallelOpsLimitOverride[]
> {
  await ensureParallelOpsLimitSchema();
  const { rows } = await pool().query<ParallelOpsLimitOverride>(
    `
      SELECT worker_kind, scope_type, scope_id, limit_value, enabled, updated_at, updated_by, note
      FROM parallel_ops_limits
      ORDER BY worker_kind, scope_type, scope_id
    `,
  );
  return rows;
}

export async function getParallelOpsLimitOverride({
  worker_kind,
  scope_type = "global",
  scope_id,
}: {
  worker_kind: string;
  scope_type?: ParallelOpsLimitScopeType;
  scope_id?: string;
}): Promise<ParallelOpsLimitOverride | undefined> {
  await ensureParallelOpsLimitSchema();
  const normalizedScopeId = normalizeScopeId(scope_type, scope_id);
  const { rows } = await pool().query<ParallelOpsLimitOverride>(
    `
      SELECT worker_kind, scope_type, scope_id, limit_value, enabled, updated_at, updated_by, note
      FROM parallel_ops_limits
      WHERE worker_kind=$1 AND scope_type=$2 AND scope_id=$3
      LIMIT 1
    `,
    [worker_kind, scope_type, normalizedScopeId],
  );
  return rows[0];
}

export async function setParallelOpsLimitOverride({
  worker_kind,
  scope_type = "global",
  scope_id,
  limit_value,
  updated_by,
  note,
}: {
  worker_kind: string;
  scope_type?: ParallelOpsLimitScopeType;
  scope_id?: string;
  limit_value: number;
  updated_by?: string;
  note?: string;
}): Promise<ParallelOpsLimitOverride> {
  await ensureParallelOpsLimitSchema();
  const normalizedScopeId = normalizeScopeId(scope_type, scope_id);
  const { rows } = await pool().query<ParallelOpsLimitOverride>(
    `
      INSERT INTO parallel_ops_limits
        (worker_kind, scope_type, scope_id, limit_value, enabled, updated_at, updated_by, note)
      VALUES ($1,$2,$3,$4,TRUE,now(),$5,$6)
      ON CONFLICT (worker_kind, scope_type, scope_id)
      DO UPDATE SET
        limit_value=EXCLUDED.limit_value,
        enabled=TRUE,
        updated_at=now(),
        updated_by=EXCLUDED.updated_by,
        note=EXCLUDED.note
      RETURNING worker_kind, scope_type, scope_id, limit_value, enabled, updated_at, updated_by, note
    `,
    [
      worker_kind,
      scope_type,
      normalizedScopeId,
      limit_value,
      updated_by ?? null,
      note ?? null,
    ],
  );
  clearParallelOpsLimitCache();
  return rows[0];
}

export async function clearParallelOpsLimitOverride({
  worker_kind,
  scope_type = "global",
  scope_id,
}: {
  worker_kind: string;
  scope_type?: ParallelOpsLimitScopeType;
  scope_id?: string;
}): Promise<void> {
  await ensureParallelOpsLimitSchema();
  const normalizedScopeId = normalizeScopeId(scope_type, scope_id);
  await pool().query(
    `
      DELETE FROM parallel_ops_limits
      WHERE worker_kind=$1 AND scope_type=$2 AND scope_id=$3
    `,
    [worker_kind, scope_type, normalizedScopeId],
  );
  clearParallelOpsLimitCache();
}

export function clearParallelOpsLimitCache(): void {
  cache.clear();
}

export async function getEffectiveParallelOpsLimit({
  worker_kind,
  default_limit,
  scope_type = "global",
  scope_id,
}: {
  worker_kind: string;
  default_limit: number;
  scope_type?: ParallelOpsLimitScopeType;
  scope_id?: string;
}): Promise<{ value: number; source: EffectiveParallelOpsLimitSource }> {
  const normalizedScopeId = normalizeScopeId(scope_type, scope_id);
  const key = cacheKey(worker_kind, scope_type, normalizedScopeId);
  const cached = cache.get(key);
  if (cached && cached.expires_at > Date.now()) {
    return { value: cached.value, source: cached.source };
  }
  const row = await getParallelOpsLimitOverride({
    worker_kind,
    scope_type,
    scope_id: normalizedScopeId,
  });
  const capped = applyDebugCap({
    value: row?.enabled ? row.limit_value : default_limit,
    source: row?.enabled ? "db-override" : "default",
  });
  cache.set(key, {
    expires_at: Date.now() + CACHE_TTL_MS,
    value: capped.value,
    source: capped.source,
  });
  return capped;
}

export async function getEffectiveParallelOpsLimits({
  worker_kind,
  default_limit,
  scope_type,
  scope_ids,
}: {
  worker_kind: string;
  default_limit: number;
  scope_type: Exclude<ParallelOpsLimitScopeType, "global">;
  scope_ids: string[];
}): Promise<
  Map<string, { value: number; source: EffectiveParallelOpsLimitSource }>
> {
  const normalizedIds = Array.from(
    new Set(
      scope_ids.map((id) => normalizeScopeId(scope_type, id)).filter(Boolean),
    ),
  );
  const result = new Map<
    string,
    { value: number; source: EffectiveParallelOpsLimitSource }
  >();
  if (normalizedIds.length === 0) {
    return result;
  }
  await ensureParallelOpsLimitSchema();
  const { rows } = await pool().query<ParallelOpsLimitOverride>(
    `
      SELECT worker_kind, scope_type, scope_id, limit_value, enabled, updated_at, updated_by, note
      FROM parallel_ops_limits
      WHERE worker_kind=$1
        AND scope_type=$2
        AND scope_id = ANY($3::text[])
    `,
    [worker_kind, scope_type, normalizedIds],
  );
  const overrideByScopeId = new Map(
    rows.map((row) => [row.scope_id, row] as const),
  );
  for (const scope_id of normalizedIds) {
    const row = overrideByScopeId.get(scope_id);
    result.set(
      scope_id,
      applyDebugCap({
        value: row?.enabled ? row.limit_value : default_limit,
        source: row?.enabled ? "db-override" : "default",
      }),
    );
  }
  return result;
}
