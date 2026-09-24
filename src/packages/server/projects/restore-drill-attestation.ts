/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";

export interface RestoreDrillAttestation {
  op_id: string;
  project_id: string;
  backup_id: string;
  backup_repo_id: string;
  restore_host_id: string;
  restore_finished_at: Date;
  restore_duration_ms: number | null;
  expected_sha256: string;
  observed_sha256: string;
  passed: boolean;
  recorded_by: string;
  recorded_at: Date;
  reason: string;
}

export interface ProjectRestoreDrillShardHealth {
  backup_repo_id: string;
  backed_up_projects: number;
  latest_restore_at: Date | null;
  latest_passed: boolean | null;
  latest_backup_id: string | null;
}

const RESTORE_DRILL_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

export function summarizeProjectRestoreDrills(
  shards: ProjectRestoreDrillShardHealth[],
  now: Date = new Date(),
): {
  level: "healthy" | "warning" | "critical";
  current: number;
  missing: number;
  stale: number;
  failed: number;
  details: string[];
} {
  let current = 0;
  let missing = 0;
  let stale = 0;
  let failed = 0;
  const problems: string[] = [];
  for (const shard of shards) {
    const age = shard.latest_restore_at
      ? now.getTime() - shard.latest_restore_at.getTime()
      : Infinity;
    if (shard.latest_passed === false) {
      failed++;
      problems.push(
        `${shard.backup_repo_id}: latest remote-only restore drill failed at ${shard.latest_restore_at?.toISOString() ?? "unknown time"}`,
      );
    } else if (!shard.latest_restore_at) {
      missing++;
      problems.push(
        `${shard.backup_repo_id}: no attested remote-only restore drill`,
      );
    } else if (
      shard.latest_passed !== true ||
      age > RESTORE_DRILL_MAX_AGE_MS ||
      age < 0
    ) {
      stale++;
      problems.push(
        `${shard.backup_repo_id}: latest passing remote-only restore drill is outside the 30-day window (${shard.latest_restore_at.toISOString()})`,
      );
    } else {
      current++;
    }
  }
  return {
    level: failed ? "critical" : missing || stale ? "warning" : "healthy",
    current,
    missing,
    stale,
    failed,
    details: problems.slice(0, 12),
  };
}

let ensurePromise: Promise<void> | undefined;

export async function ensureRestoreDrillAttestationTable(): Promise<void> {
  ensurePromise ??= getPool()
    .query(
      `
      CREATE TABLE IF NOT EXISTS project_restore_drill_attestations (
        op_id UUID PRIMARY KEY,
        project_id UUID NOT NULL,
        backup_id TEXT NOT NULL,
        backup_repo_id UUID NOT NULL,
        restore_host_id UUID NOT NULL,
        restore_finished_at TIMESTAMPTZ NOT NULL,
        restore_duration_ms INTEGER,
        expected_sha256 TEXT NOT NULL CHECK (expected_sha256 ~ '^[0-9a-f]{64}$'),
        observed_sha256 TEXT NOT NULL CHECK (observed_sha256 ~ '^[0-9a-f]{64}$'),
        passed BOOLEAN NOT NULL,
        recorded_by UUID NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        reason TEXT NOT NULL
      )
    `,
    )
    .then(async () => {
      await getPool().query(`
        CREATE INDEX IF NOT EXISTS project_restore_drill_attestations_recorded_idx
          ON project_restore_drill_attestations(recorded_at DESC)
      `);
      await getPool().query(`
        CREATE INDEX IF NOT EXISTS project_restore_drill_attestations_finished_idx
          ON project_restore_drill_attestations(restore_finished_at DESC)
      `);
      await getPool().query(`
        CREATE INDEX IF NOT EXISTS project_restore_drill_attestations_repo_finished_idx
          ON project_restore_drill_attestations(backup_repo_id, restore_finished_at DESC)
      `);
    })
    .catch((err) => {
      ensurePromise = undefined;
      throw err;
    });
  await ensurePromise;
}

// The owning bay reports its active repository shards. A shard only enters this
// check after a project has a confirmed off-host backup on it.
export async function getProjectRestoreDrillHealth(
  bay_id: string,
): Promise<ProjectRestoreDrillShardHealth[]> {
  await ensureRestoreDrillAttestationTable();
  const { rows } = await getPool().query<ProjectRestoreDrillShardHealth>(
    `WITH active_shards AS (
       SELECT backup_repo_id, COUNT(*)::integer AS backed_up_projects
         FROM projects
        WHERE COALESCE(NULLIF(BTRIM(owning_bay_id), ''), $1) = $1
          AND deleted IS NOT TRUE
          AND provisioned IS TRUE AND last_backup IS NOT NULL
          AND backup_repo_id IS NOT NULL
        GROUP BY backup_repo_id
     )
     SELECT s.backup_repo_id, s.backed_up_projects,
            d.restore_finished_at AS latest_restore_at,
            d.passed AS latest_passed, d.backup_id AS latest_backup_id
       FROM active_shards s
       LEFT JOIN LATERAL (
         SELECT restore_finished_at, passed, backup_id
           FROM project_restore_drill_attestations
          WHERE backup_repo_id = s.backup_repo_id
          ORDER BY restore_finished_at DESC, recorded_at DESC
          LIMIT 1
       ) d ON true
      ORDER BY s.backup_repo_id`,
    [bay_id],
  );
  return rows;
}

function sha256(value: string, label: string): string {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a 64-character SHA-256 hex digest`);
  }
  return normalized;
}

export async function recordRestoreDrillAttestation({
  op_id,
  expected_sha256,
  observed_sha256,
  recorded_by,
  reason,
  bay_id,
}: {
  op_id: string;
  expected_sha256: string;
  observed_sha256: string;
  recorded_by: string;
  reason: string;
  bay_id: string;
}): Promise<{ attestation: RestoreDrillAttestation; created: boolean }> {
  if (!isValidUUID(op_id)) throw new Error("invalid restore operation id");
  if (!isValidUUID(recorded_by)) throw new Error("invalid operator account id");
  const expected = sha256(expected_sha256, "expected_sha256");
  const observed = sha256(observed_sha256, "observed_sha256");
  const normalizedReason = `${reason ?? ""}`.trim();
  if (!normalizedReason || normalizedReason.length > 500) {
    throw new Error("reason must contain 1 to 500 characters");
  }
  await ensureRestoreDrillAttestationTable();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      project_id: string;
      backup_id: string;
      backup_repo_id: string | null;
      restore_host_id: string | null;
      owning_bay_id: string | null;
      restore_finished_at: Date | null;
      restore_duration_ms: string | null;
      status: string;
      result_remote_only: string | null;
    }>(
      `SELECT o.scope_id AS project_id, o.input->>'id' AS backup_id,
              p.backup_repo_id, p.host_id AS restore_host_id,
              p.owning_bay_id, o.finished_at AS restore_finished_at,
              o.result->>'duration_ms' AS restore_duration_ms,
              o.status, o.result->>'remote_only' AS result_remote_only
         FROM long_running_operations o
         JOIN projects p ON p.project_id = o.scope_id
        WHERE o.op_id = $1 AND o.kind = 'project-restore'
          AND o.scope_type = 'project'
          AND o.input->>'remote_only' = 'true'
        FOR UPDATE OF o`,
      [op_id],
    );
    const restore = rows[0];
    if (
      !restore ||
      restore.status !== "succeeded" ||
      restore.result_remote_only !== "true" ||
      !restore.restore_finished_at ||
      !restore.backup_id
    ) {
      throw new Error(
        "operation is not a successful remote-only project restore",
      );
    }
    if (restore.owning_bay_id !== bay_id) {
      throw new Error("restore project is not owned by this bay");
    }
    if (!restore.backup_repo_id || !restore.restore_host_id) {
      throw new Error(
        "restore project has no current repository or host assignment",
      );
    }
    const duration =
      restore.restore_duration_ms == null
        ? null
        : Number(restore.restore_duration_ms);
    if (duration != null && (!Number.isSafeInteger(duration) || duration < 0)) {
      throw new Error("invalid restore duration in operation result");
    }
    const inserted = await client.query<RestoreDrillAttestation>(
      `INSERT INTO project_restore_drill_attestations
         (op_id, project_id, backup_id, backup_repo_id, restore_host_id,
          restore_finished_at, restore_duration_ms, expected_sha256,
          observed_sha256, passed, recorded_by, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (op_id) DO NOTHING
       RETURNING *`,
      [
        op_id,
        restore.project_id,
        restore.backup_id,
        restore.backup_repo_id,
        restore.restore_host_id,
        restore.restore_finished_at,
        duration,
        expected,
        observed,
        expected === observed,
        recorded_by,
        normalizedReason,
      ],
    );
    const existing =
      inserted.rows[0] ??
      (
        await client.query<RestoreDrillAttestation>(
          "SELECT * FROM project_restore_drill_attestations WHERE op_id = $1",
          [op_id],
        )
      ).rows[0];
    if (
      !existing ||
      existing.expected_sha256 !== expected ||
      existing.observed_sha256 !== observed
    ) {
      throw new Error(
        "restore drill already has a different immutable attestation",
      );
    }
    await client.query("COMMIT");
    return { attestation: existing, created: inserted.rows.length > 0 };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
