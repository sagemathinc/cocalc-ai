/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type {
  HostRootfsBuildArtifactPaths,
  HostRootfsBuildStatus,
  HostRootfsBuildStatusResponse,
} from "@cocalc/conat/project-host/api";
import type { LroStatus, LroSummary } from "@cocalc/conat/hub/api/lro";
import { createLro, updateLro } from "@cocalc/server/lro/lro-db";
import { publishLroEvent, publishLroSummary } from "@cocalc/server/lro/stream";
import getLogger from "@cocalc/backend/logger";

const log = getLogger("server:rootfs:build-index");

export const PROJECT_ROOTFS_BUILD_LRO_KIND = "project-rootfs-build";

let schemaReady: Promise<void> | undefined;

export type ProjectRootfsBuildRecord = Omit<
  HostRootfsBuildStatusResponse,
  "paths"
> & {
  host_id: string;
  account_id?: string | null;
  op_id?: string | null;
  paths?: HostRootfsBuildArtifactPaths;
  updated?: string;
};

export async function ensureProjectRootfsBuildsSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const pool = getPool("medium");
      await pool.query(`
        CREATE TABLE IF NOT EXISTS project_rootfs_builds (
          build_id TEXT PRIMARY KEY,
          project_id UUID NOT NULL,
          account_id UUID,
          host_id UUID,
          op_id UUID,
          status TEXT NOT NULL,
          recipe_ref TEXT,
          paths JSONB DEFAULT '{}'::jsonb,
          pid INTEGER,
          exit_code INTEGER,
          signal TEXT,
          error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          started_at TIMESTAMPTZ,
          finished_at TIMESTAMPTZ,
          heartbeat_at TIMESTAMPTZ,
          last_output_at TIMESTAMPTZ,
          updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(
        "ALTER TABLE project_rootfs_builds ADD COLUMN IF NOT EXISTS account_id UUID",
      );
      await pool.query(
        "ALTER TABLE project_rootfs_builds ADD COLUMN IF NOT EXISTS op_id UUID",
      );
      await pool.query(
        "ALTER TABLE project_rootfs_builds ADD COLUMN IF NOT EXISTS paths JSONB DEFAULT '{}'::jsonb",
      );
      await pool.query(
        "CREATE INDEX IF NOT EXISTS project_rootfs_builds_project_idx ON project_rootfs_builds(project_id)",
      );
      await pool.query(
        "CREATE INDEX IF NOT EXISTS project_rootfs_builds_account_idx ON project_rootfs_builds(account_id)",
      );
      await pool.query(
        "CREATE INDEX IF NOT EXISTS project_rootfs_builds_host_idx ON project_rootfs_builds(host_id)",
      );
      await pool.query(
        "CREATE INDEX IF NOT EXISTS project_rootfs_builds_op_idx ON project_rootfs_builds(op_id)",
      );
      await pool.query(
        "CREATE INDEX IF NOT EXISTS project_rootfs_builds_status_idx ON project_rootfs_builds(status)",
      );
      await pool.query(
        "CREATE INDEX IF NOT EXISTS project_rootfs_builds_project_created_idx ON project_rootfs_builds(project_id, created_at DESC)",
      );
    })().catch((err) => {
      schemaReady = undefined;
      throw err;
    });
  }
  await schemaReady;
}

export async function createProjectRootfsBuildLro({
  account_id,
  project_id,
  host_id,
  build_id,
  recipe_ref,
}: {
  account_id?: string;
  project_id: string;
  host_id: string;
  build_id: string;
  recipe_ref?: string;
}): Promise<LroSummary> {
  const op = await createLro({
    kind: PROJECT_ROOTFS_BUILD_LRO_KIND,
    scope_type: "project",
    scope_id: project_id,
    created_by: account_id,
    owner_type: "host",
    owner_id: host_id,
    routing: "project-host",
    input: {
      build_id,
      project_id,
      host_id,
      recipe_ref,
    },
    status: "queued",
    expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
  });
  await publishBuildLroSummary(op);
  await publishLroEvent({
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    op_id: op.op_id,
    event: {
      type: "progress",
      ts: Date.now(),
      phase: "queued",
      message: "rootfs build queued",
      progress: 0,
    },
  }).catch((err) => {
    log.warn("unable to publish rootfs build queued event", {
      op_id: op.op_id,
      build_id,
      project_id,
      err,
    });
  });
  return op;
}

export async function upsertProjectRootfsBuildStatus({
  account_id,
  host_id,
  op_id,
  status,
}: {
  account_id?: string | null;
  host_id: string;
  op_id?: string | null;
  status: HostRootfsBuildStatusResponse;
}): Promise<ProjectRootfsBuildRecord> {
  await ensureProjectRootfsBuildsSchema();
  const pool = getPool("medium");
  const created_at = dateOrNull(status.created_at) ?? new Date();
  const values = [
    status.build_id,
    status.project_id,
    account_id ?? null,
    host_id,
    op_id ?? null,
    status.status,
    status.recipe_ref ?? null,
    status.paths ?? {},
    status.pid ?? null,
    status.exit_code ?? null,
    status.signal ?? null,
    status.error ?? null,
    created_at,
    dateOrNull(status.started_at),
    dateOrNull(status.finished_at),
    dateOrNull(status.heartbeat_at),
    dateOrNull(status.last_output_at),
  ];
  const { rows } = await pool.query(
    `
      INSERT INTO project_rootfs_builds
        (build_id, project_id, account_id, host_id, op_id, status, recipe_ref, paths, pid, exit_code, signal, error, created_at, started_at, finished_at, heartbeat_at, last_output_at, updated)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
      ON CONFLICT (build_id) DO UPDATE SET
        project_id=EXCLUDED.project_id,
        account_id=COALESCE(EXCLUDED.account_id, project_rootfs_builds.account_id),
        host_id=COALESCE(EXCLUDED.host_id, project_rootfs_builds.host_id),
        op_id=COALESCE(EXCLUDED.op_id, project_rootfs_builds.op_id),
        status=EXCLUDED.status,
        recipe_ref=COALESCE(EXCLUDED.recipe_ref, project_rootfs_builds.recipe_ref),
        paths=COALESCE(EXCLUDED.paths, project_rootfs_builds.paths),
        pid=COALESCE(EXCLUDED.pid, project_rootfs_builds.pid),
        exit_code=EXCLUDED.exit_code,
        signal=EXCLUDED.signal,
        error=EXCLUDED.error,
        created_at=COALESCE(project_rootfs_builds.created_at, EXCLUDED.created_at),
        started_at=COALESCE(EXCLUDED.started_at, project_rootfs_builds.started_at),
        finished_at=COALESCE(EXCLUDED.finished_at, project_rootfs_builds.finished_at),
        heartbeat_at=COALESCE(EXCLUDED.heartbeat_at, project_rootfs_builds.heartbeat_at),
        last_output_at=COALESCE(EXCLUDED.last_output_at, project_rootfs_builds.last_output_at),
        updated=NOW()
      RETURNING *
    `,
    values,
  );
  return rowToRecord(rows[0]);
}

export async function markProjectRootfsBuildFailed({
  account_id,
  project_id,
  host_id,
  build_id,
  op_id,
  recipe_ref,
  error,
}: {
  account_id?: string | null;
  project_id: string;
  host_id: string;
  build_id: string;
  op_id?: string | null;
  recipe_ref?: string;
  error: unknown;
}): Promise<ProjectRootfsBuildRecord> {
  return await upsertProjectRootfsBuildStatus({
    account_id,
    host_id,
    op_id,
    status: {
      build_id,
      project_id,
      status: "failed",
      recipe_ref,
      created_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      error: `${error}`,
      paths: {
        dir: "",
        script: "",
        log: "",
        status: "",
        events: "",
      },
    },
  });
}

export async function getProjectRootfsBuildRecord({
  project_id,
  build_id,
}: {
  project_id: string;
  build_id: string;
}): Promise<ProjectRootfsBuildRecord | undefined> {
  await ensureProjectRootfsBuildsSchema();
  const { rows } = await getPool("medium").query(
    `
      SELECT *
      FROM project_rootfs_builds
      WHERE project_id=$1 AND build_id=$2
      LIMIT 1
    `,
    [project_id, build_id],
  );
  return rows[0] ? rowToRecord(rows[0]) : undefined;
}

export async function listProjectRootfsBuildRecords({
  project_id,
  limit = 50,
}: {
  project_id: string;
  limit?: number;
}): Promise<ProjectRootfsBuildRecord[]> {
  await ensureProjectRootfsBuildsSchema();
  const { rows } = await getPool("medium").query(
    `
      SELECT *
      FROM project_rootfs_builds
      WHERE project_id=$1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [project_id, Math.max(1, Math.min(500, Math.floor(limit)))],
  );
  return rows.map(rowToRecord);
}

export async function syncProjectRootfsBuildLro({
  op_id,
  status,
}: {
  op_id?: string | null;
  status: HostRootfsBuildStatusResponse;
}): Promise<LroSummary | undefined> {
  if (!op_id) return undefined;
  const lroStatus = buildStatusToLroStatus(status.status);
  const summary = await updateLro({
    op_id,
    status: lroStatus,
    error: status.error ?? null,
    heartbeat_at: dateOrNull(status.heartbeat_at) ?? new Date(),
    progress_summary: {
      build_id: status.build_id,
      project_id: status.project_id,
      status: status.status,
      recipe_ref: status.recipe_ref,
      pid: status.pid,
      exit_code: status.exit_code,
      signal: status.signal,
      error: status.error,
      paths: status.paths,
      created_at: status.created_at,
      started_at: status.started_at,
      finished_at: status.finished_at,
      heartbeat_at: status.heartbeat_at,
      last_output_at: status.last_output_at,
    },
    result: isTerminalBuildStatus(status.status)
      ? {
          build_id: status.build_id,
          project_id: status.project_id,
          status: status.status,
          paths: status.paths,
        }
      : undefined,
  });
  if (summary) {
    await publishBuildLroSummary(summary);
  }
  return summary;
}

export function buildStatusToLroStatus(
  status: HostRootfsBuildStatus,
): LroStatus {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    case "running":
    case "canceling":
    case "unknown":
      return "running";
  }
}

function isTerminalBuildStatus(status: HostRootfsBuildStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

async function publishBuildLroSummary(summary: LroSummary): Promise<void> {
  await publishLroSummary({
    scope_type: summary.scope_type,
    scope_id: summary.scope_id,
    summary,
  }).catch((err) => {
    log.warn("unable to publish rootfs build LRO summary", {
      op_id: summary.op_id,
      err,
    });
  });
}

function rowToRecord(row: any): ProjectRootfsBuildRecord {
  return {
    build_id: row.build_id,
    project_id: row.project_id,
    host_id: row.host_id,
    account_id: row.account_id,
    op_id: row.op_id,
    status: row.status,
    recipe_ref: row.recipe_ref ?? undefined,
    paths: row.paths ?? undefined,
    pid: row.pid ?? undefined,
    exit_code: row.exit_code ?? undefined,
    signal: row.signal ?? undefined,
    error: row.error ?? undefined,
    created_at: isoOrUndefined(row.created_at) ?? new Date().toISOString(),
    started_at: isoOrUndefined(row.started_at),
    finished_at: isoOrUndefined(row.finished_at),
    heartbeat_at: isoOrUndefined(row.heartbeat_at),
    last_output_at: isoOrUndefined(row.last_output_at),
    updated: isoOrUndefined(row.updated),
  };
}

function dateOrNull(value?: string | Date | null): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function isoOrUndefined(value?: string | Date | null): string | undefined {
  const date = dateOrNull(value);
  return date?.toISOString();
}
