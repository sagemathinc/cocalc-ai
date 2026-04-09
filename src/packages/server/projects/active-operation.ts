/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type { LroStatus } from "@cocalc/conat/hub/api/lro";
import type { ProjectActiveOperationSummary } from "@cocalc/conat/hub/api/projects";
import { publishProjectDetailInvalidationBestEffort } from "@cocalc/server/account/project-detail-feed";

const ACTIVE_STATUSES = new Set<LroStatus>(["queued", "running"]);
const STALE_ACTIVE_OP_MS = 20 * 60_000;

export async function ensureProjectActiveOperationSchema(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS project_active_operations (
      project_id UUID PRIMARY KEY,
      op_id UUID,
      kind TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      started_by_account_id UUID,
      source_bay_id TEXT,
      phase TEXT,
      message TEXT,
      progress DOUBLE PRECISION,
      detail JSONB,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await getPool().query(
    "CREATE INDEX IF NOT EXISTS project_active_operations_updated_idx ON project_active_operations(updated_at)",
  );
}

async function invalidateProjectActiveOperation(
  project_id: string,
): Promise<void> {
  await publishProjectDetailInvalidationBestEffort({
    project_id,
    fields: ["active_op"],
  });
}

export async function upsertProjectActiveOperation(opts: {
  project_id: string;
  op_id?: string | null;
  kind: string;
  action: "start" | "restart" | "stop";
  status: LroStatus;
  started_by_account_id?: string | null;
  source_bay_id?: string | null;
  phase?: string | null;
  message?: string | null;
  progress?: number | null;
  detail?: any;
}): Promise<void> {
  await ensureProjectActiveOperationSchema();
  await getPool().query(
    `
      INSERT INTO project_active_operations
        (project_id, op_id, kind, action, status, started_by_account_id, source_bay_id, phase, message, progress, detail, started_at, updated_at)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), now())
      ON CONFLICT (project_id) DO UPDATE SET
        op_id = EXCLUDED.op_id,
        kind = EXCLUDED.kind,
        action = EXCLUDED.action,
        status = EXCLUDED.status,
        started_by_account_id = EXCLUDED.started_by_account_id,
        source_bay_id = EXCLUDED.source_bay_id,
        phase = EXCLUDED.phase,
        message = EXCLUDED.message,
        progress = EXCLUDED.progress,
        detail = EXCLUDED.detail,
        started_at = COALESCE(project_active_operations.started_at, EXCLUDED.started_at),
        updated_at = now()
    `,
    [
      opts.project_id,
      opts.op_id ?? null,
      opts.kind,
      opts.action,
      opts.status,
      opts.started_by_account_id ?? null,
      opts.source_bay_id ?? null,
      opts.phase ?? null,
      opts.message ?? null,
      opts.progress ?? null,
      opts.detail ?? null,
    ],
  );
  await invalidateProjectActiveOperation(opts.project_id);
}

export async function updateProjectActiveOperationProgress(opts: {
  project_id: string;
  op_id?: string | null;
  phase?: string | null;
  message?: string | null;
  progress?: number | null;
  detail?: any;
}): Promise<void> {
  await ensureProjectActiveOperationSchema();
  const values: any[] = [opts.project_id];
  let opIdClause = "";
  if (opts.op_id) {
    values.push(opts.op_id);
    opIdClause = ` AND op_id = $${values.length}`;
  }
  await getPool().query(
    `
      UPDATE project_active_operations
         SET phase = COALESCE($${values.length + 1}, phase),
             message = COALESCE($${values.length + 2}, message),
             progress = COALESCE($${values.length + 3}, progress),
             detail = COALESCE($${values.length + 4}, detail),
             updated_at = now()
       WHERE project_id = $1${opIdClause}
    `,
    [
      ...values,
      opts.phase ?? null,
      opts.message ?? null,
      opts.progress ?? null,
      opts.detail ?? null,
    ],
  );
}

export async function clearProjectActiveOperation(opts: {
  project_id: string;
  op_id?: string | null;
}): Promise<void> {
  await ensureProjectActiveOperationSchema();
  const values: any[] = [opts.project_id];
  let opIdClause = "";
  if (opts.op_id) {
    values.push(opts.op_id);
    opIdClause = ` AND op_id = $2`;
  }
  await getPool().query(
    `DELETE FROM project_active_operations WHERE project_id = $1${opIdClause}`,
    values,
  );
  await invalidateProjectActiveOperation(opts.project_id);
}

export async function getProjectActiveOperation(opts: {
  project_id: string;
}): Promise<ProjectActiveOperationSummary | null> {
  await ensureProjectActiveOperationSchema();
  const { rows } = await getPool().query<ProjectActiveOperationSummary>(
    `
      SELECT project_id, op_id, kind, action, status, started_by_account_id,
             source_bay_id, phase, message, progress, detail, started_at, updated_at
        FROM project_active_operations
       WHERE project_id = $1
       LIMIT 1
    `,
    [opts.project_id],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  if (!ACTIVE_STATUSES.has(row.status)) {
    await clearProjectActiveOperation({ project_id: opts.project_id });
    return null;
  }
  const updatedAt = new Date(row.updated_at as any).getTime();
  if (
    !Number.isFinite(updatedAt) ||
    Date.now() - updatedAt > STALE_ACTIVE_OP_MS
  ) {
    await clearProjectActiveOperation({ project_id: opts.project_id });
    return null;
  }
  return row;
}
