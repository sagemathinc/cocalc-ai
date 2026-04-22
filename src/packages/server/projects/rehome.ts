/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { drainAccountProjectIndexProjection } from "@cocalc/database/postgres/account-project-index-projector";
import { appendProjectOutboxEventForProject } from "@cocalc/database/postgres/project-events-outbox";
import type { ProjectControlRehomeResponse } from "@cocalc/conat/inter-bay/api";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { assertBayAcceptsProjectOwnership } from "@cocalc/server/bay-registry";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import {
  resolveProjectBay,
  resolveProjectBayDirect,
} from "@cocalc/server/inter-bay/directory";
import { publishProjectAccountFeedEventsBestEffort } from "@cocalc/server/account/project-feed";
import { isValidUUID } from "@cocalc/util/misc";

const log = getLogger("server:projects:rehome");
const ACCEPT_REHOME_TIMEOUT_MS = 60_000;
const PROJECT_REHOME_OPERATIONS_TABLE = "project_rehome_operations";

export type ProjectRehomeOperationStage =
  | "requested"
  | "destination_accepted"
  | "source_flipped"
  | "projected"
  | "complete";

export type ProjectRehomeOperationStatus = "running" | "succeeded" | "failed";

export type ProjectRehomeOperationSummary = {
  op_id: string;
  project_id: string;
  source_bay_id: string;
  dest_bay_id: string;
  requested_by: string | null;
  reason: string | null;
  campaign_id: string | null;
  status: ProjectRehomeOperationStatus;
  stage: ProjectRehomeOperationStage;
  attempt: number;
  last_error: string | null;
  created_at?: Date | string | null;
  updated_at?: Date | string | null;
  finished_at?: Date | string | null;
};

export type ProjectRehomeDrainResult = {
  source_bay_id: string;
  dest_bay_id: string;
  dry_run: boolean;
  limit: number;
  campaign_id: string | null;
  candidate_count: number;
  candidates: string[];
  rehomed: ProjectControlRehomeResponse[];
  errors: Array<{ project_id: string; error: string }>;
};

type Queryable = {
  query: (
    sql: string,
    params?: any[],
  ) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

type ProjectRehomeOperationRow = ProjectRehomeOperationSummary & {
  project: Record<string, unknown> | null;
};

let projectRehomeSchemaReady: Promise<void> | undefined;

async function ensureProjectRehomeSchema(): Promise<void> {
  projectRehomeSchemaReady ??= (async () => {
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS ${PROJECT_REHOME_OPERATIONS_TABLE} (
        op_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL,
        source_bay_id TEXT NOT NULL,
        dest_bay_id TEXT NOT NULL,
        requested_by UUID,
        reason TEXT,
        campaign_id TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        stage TEXT NOT NULL DEFAULT 'requested',
        attempt INTEGER NOT NULL DEFAULT 0,
        project JSONB,
        last_error TEXT,
        destination_accepted_at TIMESTAMPTZ,
        source_flipped_at TIMESTAMPTZ,
        projected_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS project_rehome_operations_project_idx ON ${PROJECT_REHOME_OPERATIONS_TABLE}(project_id, status)`,
    );
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS project_rehome_operations_source_idx ON ${PROJECT_REHOME_OPERATIONS_TABLE}(source_bay_id, status)`,
    );
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS project_rehome_operations_campaign_idx ON ${PROJECT_REHOME_OPERATIONS_TABLE}(campaign_id)`,
    );
  })();
  await projectRehomeSchemaReady;
}

function normalizeExplicitBayId(name: string, value: unknown): string {
  const bay_id = `${value ?? ""}`.trim();
  if (!bay_id) {
    throw new Error(`${name} is required`);
  }
  return bay_id;
}

function normalizeProjectId(project_id: string): string {
  const value = `${project_id ?? ""}`.trim();
  if (!isValidUUID(value)) {
    throw new Error(`invalid project id '${project_id ?? ""}'`);
  }
  return value;
}

async function assertAdmin(account_id: string): Promise<void> {
  if (!(await isAdmin(account_id))) {
    throw new Error("project rehome requires admin privileges");
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function listWritableProjectColumns(db: Queryable): Promise<string[]> {
  const { rows } = await db.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'projects'
        AND is_generated = 'NEVER'
        AND identity_generation IS NULL
      ORDER BY ordinal_position
    `,
  );
  return rows.map((row) => `${row.column_name}`);
}

async function loadProjectRowForRehome(
  project_id: string,
): Promise<Record<string, unknown>> {
  const { rows } = await getPool().query<{ project: Record<string, unknown> }>(
    `SELECT to_jsonb(projects.*) AS project
       FROM projects
      WHERE project_id = $1
        AND deleted IS NOT TRUE
      LIMIT 1`,
    [project_id],
  );
  const project = rows[0]?.project;
  if (!project) {
    throw new Error(`project ${project_id} not found`);
  }
  return project;
}

async function loadLocalProjectOwningBay(
  project_id: string,
): Promise<string | null> {
  const { rows } = await getPool().query<{ owning_bay_id: string | null }>(
    `
      SELECT owning_bay_id
        FROM projects
       WHERE project_id = $1
       LIMIT 1
    `,
    [project_id],
  );
  return rows[0]?.owning_bay_id ?? null;
}

async function upsertProjectRowForRehome({
  db,
  project,
  dest_bay_id,
}: {
  db: Queryable;
  project: Record<string, unknown>;
  dest_bay_id: string;
}) {
  const project_id = normalizeProjectId(`${project.project_id ?? ""}`);
  const row = { ...project, project_id, owning_bay_id: dest_bay_id };
  const writableColumns = await listWritableProjectColumns(db);
  const columns = writableColumns.filter((column) =>
    Object.prototype.hasOwnProperty.call(row, column),
  );
  if (!columns.includes("project_id")) {
    throw new Error("project rehome payload is missing project_id");
  }
  if (!columns.includes("owning_bay_id")) {
    columns.push("owning_bay_id");
  }
  const values = columns.map((column) => row[column] ?? null);
  const placeholders = columns.map((_, i) => `$${i + 1}`);
  const updateColumns = columns.filter((column) => column !== "project_id");
  await db.query(
    `
      INSERT INTO projects (${columns.map(quoteIdent).join(", ")})
      VALUES (${placeholders.join(", ")})
      ON CONFLICT (project_id) DO UPDATE SET
        ${updateColumns
          .map(
            (column) =>
              `${quoteIdent(column)} = EXCLUDED.${quoteIdent(column)}`,
          )
          .join(", ")}
    `,
    values,
  );
}

async function updateLocalProjectionRows({
  project_id,
  dest_bay_id,
}: {
  project_id: string;
  dest_bay_id: string;
}) {
  await getPool().query(
    `
      UPDATE account_project_index
         SET owning_bay_id = $2,
             updated_at = NOW()
       WHERE project_id = $1
    `,
    [project_id, dest_bay_id],
  );
}

async function createProjectRehomeOperation({
  project_id,
  source_bay_id,
  dest_bay_id,
  account_id,
  reason,
  campaign_id,
}: {
  project_id: string;
  source_bay_id: string;
  dest_bay_id: string;
  account_id: string;
  reason?: string | null;
  campaign_id?: string | null;
}): Promise<ProjectRehomeOperationRow> {
  await ensureProjectRehomeSchema();
  const active = await getPool().query<ProjectRehomeOperationRow>(
    `
      SELECT *
        FROM ${PROJECT_REHOME_OPERATIONS_TABLE}
       WHERE project_id = $1
         AND status = 'running'
       ORDER BY created_at DESC
       LIMIT 1
    `,
    [project_id],
  );
  const existing = active.rows[0];
  if (existing) {
    if (
      existing.source_bay_id === source_bay_id &&
      existing.dest_bay_id === dest_bay_id
    ) {
      return existing;
    }
    throw new Error(
      `project ${project_id} already has running rehome operation ${existing.op_id} from ${existing.source_bay_id} to ${existing.dest_bay_id}`,
    );
  }

  const { rows } = await getPool().query<ProjectRehomeOperationRow>(
    `
      INSERT INTO ${PROJECT_REHOME_OPERATIONS_TABLE}
        (project_id, source_bay_id, dest_bay_id, requested_by, reason, campaign_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `,
    [
      project_id,
      source_bay_id,
      dest_bay_id,
      account_id,
      reason ?? null,
      campaign_id ?? null,
    ],
  );
  return rows[0];
}

export async function getProjectRehomeOperation(
  op_id: string,
): Promise<ProjectRehomeOperationSummary | undefined> {
  await ensureProjectRehomeSchema();
  const { rows } = await getPool().query<ProjectRehomeOperationRow>(
    `SELECT * FROM ${PROJECT_REHOME_OPERATIONS_TABLE} WHERE op_id = $1`,
    [op_id],
  );
  const row = rows[0];
  if (!row) return undefined;
  return summarizeProjectRehomeOperation(row);
}

function summarizeProjectRehomeOperation(
  row: ProjectRehomeOperationRow,
): ProjectRehomeOperationSummary {
  return {
    op_id: row.op_id,
    project_id: row.project_id,
    source_bay_id: row.source_bay_id,
    dest_bay_id: row.dest_bay_id,
    requested_by: row.requested_by ?? null,
    reason: row.reason ?? null,
    campaign_id: row.campaign_id ?? null,
    status: row.status,
    stage: row.stage,
    attempt: row.attempt ?? 0,
    last_error: row.last_error ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    finished_at: row.finished_at ?? null,
  };
}

async function updateProjectRehomeOperation({
  op_id,
  status,
  stage,
  project,
  last_error,
}: {
  op_id: string;
  status?: ProjectRehomeOperationStatus;
  stage?: ProjectRehomeOperationStage;
  project?: Record<string, unknown> | null;
  last_error?: string | null;
}): Promise<ProjectRehomeOperationRow> {
  await ensureProjectRehomeSchema();
  const sets = ["updated_at = NOW()"];
  const values: any[] = [op_id];
  let i = 2;
  if (status !== undefined) {
    sets.push(`status = $${i++}`);
    values.push(status);
    if (status === "succeeded" || status === "failed") {
      sets.push("finished_at = COALESCE(finished_at, NOW())");
    }
    if (status === "running") {
      sets.push("finished_at = NULL");
    }
  }
  if (stage !== undefined) {
    sets.push(`stage = $${i++}`);
    values.push(stage);
    if (stage === "destination_accepted") {
      sets.push(
        "destination_accepted_at = COALESCE(destination_accepted_at, NOW())",
      );
    } else if (stage === "source_flipped") {
      sets.push("source_flipped_at = COALESCE(source_flipped_at, NOW())");
    } else if (stage === "projected") {
      sets.push("projected_at = COALESCE(projected_at, NOW())");
    }
  }
  if (project !== undefined) {
    sets.push(`project = $${i++}`);
    values.push(project);
  }
  if (last_error !== undefined) {
    sets.push(`last_error = $${i++}`);
    values.push(last_error);
  }
  const { rows } = await getPool().query<ProjectRehomeOperationRow>(
    `
      UPDATE ${PROJECT_REHOME_OPERATIONS_TABLE}
         SET ${sets.join(", ")}
       WHERE op_id = $1
       RETURNING *
    `,
    values,
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`project rehome operation ${op_id} not found`);
  }
  return row;
}

async function startProjectRehomeAttempt(
  op_id: string,
): Promise<ProjectRehomeOperationRow> {
  await ensureProjectRehomeSchema();
  const { rows } = await getPool().query<ProjectRehomeOperationRow>(
    `
      UPDATE ${PROJECT_REHOME_OPERATIONS_TABLE}
         SET status = 'running',
             attempt = attempt + 1,
             last_error = NULL,
             finished_at = NULL,
             updated_at = NOW()
       WHERE op_id = $1
       RETURNING *
    `,
    [op_id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`project rehome operation ${op_id} not found`);
  }
  return row;
}

async function markProjectRehomeFailed({
  op_id,
  err,
}: {
  op_id: string;
  err: unknown;
}): Promise<ProjectRehomeOperationRow> {
  return await updateProjectRehomeOperation({
    op_id,
    status: "failed",
    last_error: err instanceof Error ? err.message : `${err}`,
  });
}

async function flipSourceOwnershipIfNeeded({
  project_id,
  dest_bay_id,
}: {
  project_id: string;
  dest_bay_id: string;
}) {
  await getPool().query(
    `
      UPDATE projects
         SET owning_bay_id = $2
       WHERE project_id = $1
         AND owning_bay_id IS DISTINCT FROM $2
    `,
    [project_id, dest_bay_id],
  );
  await updateLocalProjectionRows({
    project_id,
    dest_bay_id,
  });
}

export async function acceptProjectRehome({
  project_id,
  source_bay_id,
  dest_bay_id,
  project,
}: {
  account_id?: string;
  project_id: string;
  source_bay_id: string;
  dest_bay_id: string;
  project: Record<string, unknown>;
}): Promise<ProjectControlRehomeResponse> {
  const normalizedProjectId = normalizeProjectId(project_id);
  const sourceBayId = normalizeExplicitBayId("source_bay_id", source_bay_id);
  const destBayId = normalizeExplicitBayId("dest_bay_id", dest_bay_id);
  const localBayId = getConfiguredBayId();
  if (destBayId !== localBayId) {
    throw new Error(
      `project rehome accept for ${normalizedProjectId} reached ${localBayId}, not destination bay ${destBayId}`,
    );
  }
  const payloadProjectId = normalizeProjectId(`${project.project_id ?? ""}`);
  if (payloadProjectId !== normalizedProjectId) {
    throw new Error(
      `project rehome payload project_id ${payloadProjectId} does not match ${normalizedProjectId}`,
    );
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await upsertProjectRowForRehome({
      db: client,
      project,
      dest_bay_id: destBayId,
    });
    await appendProjectOutboxEventForProject({
      db: client,
      event_type: "project.summary_changed",
      project_id: normalizedProjectId,
      default_bay_id: destBayId,
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  await drainAccountProjectIndexProjection({
    bay_id: destBayId,
    dry_run: false,
    limit: 100,
  }).catch((err) => {
    log.warn("project rehome destination projection drain failed", {
      project_id: normalizedProjectId,
      dest_bay_id: destBayId,
      err: `${err}`,
    });
  });
  await publishProjectAccountFeedEventsBestEffort({
    project_id: normalizedProjectId,
    default_bay_id: destBayId,
  });

  return {
    project_id: normalizedProjectId,
    previous_bay_id: sourceBayId,
    owning_bay_id: destBayId,
    status: sourceBayId === destBayId ? "already-home" : "rehomed",
  };
}

export async function rehomeProjectOnOwningBay({
  account_id,
  project_id,
  dest_bay_id,
  reason,
  campaign_id,
}: {
  account_id: string;
  project_id: string;
  dest_bay_id: string;
  reason?: string | null;
  campaign_id?: string | null;
}): Promise<ProjectControlRehomeResponse> {
  const normalizedProjectId = normalizeProjectId(project_id);
  const destBayId = normalizeExplicitBayId("dest_bay_id", dest_bay_id);
  const localBayId = getConfiguredBayId();
  const directOwnership = await resolveProjectBayDirect(normalizedProjectId);
  if (directOwnership == null || directOwnership.bay_id !== localBayId) {
    throw new Error(
      `project ${normalizedProjectId} is not owned by local bay ${localBayId}`,
    );
  }
  if (destBayId === localBayId) {
    return {
      project_id: normalizedProjectId,
      previous_bay_id: localBayId,
      owning_bay_id: localBayId,
      status: "already-home",
    };
  }
  await assertBayAcceptsProjectOwnership(destBayId);

  const op = await createProjectRehomeOperation({
    project_id: normalizedProjectId,
    source_bay_id: localBayId,
    dest_bay_id: destBayId,
    account_id,
    reason,
    campaign_id,
  });

  return await runProjectRehomeOperation(op.op_id);
}

export async function runProjectRehomeOperation(
  op_id: string,
): Promise<ProjectControlRehomeResponse> {
  let op = await startProjectRehomeAttempt(op_id);
  const localBayId = getConfiguredBayId();
  if (op.source_bay_id !== localBayId) {
    throw new Error(
      `project rehome operation ${op_id} belongs to source bay ${op.source_bay_id}, not local bay ${localBayId}`,
    );
  }

  try {
    if (op.dest_bay_id === op.source_bay_id) {
      op = await updateProjectRehomeOperation({
        op_id,
        status: "succeeded",
        stage: "complete",
      });
      return {
        op_id,
        project_id: op.project_id,
        previous_bay_id: op.source_bay_id,
        owning_bay_id: op.dest_bay_id,
        operation_stage: op.stage,
        operation_status: op.status,
        status: "already-home",
      };
    }

    let project = op.project;
    if (!project) {
      const currentOwningBay = await loadLocalProjectOwningBay(op.project_id);
      if (currentOwningBay === op.dest_bay_id) {
        op = await updateProjectRehomeOperation({
          op_id,
          stage: "source_flipped",
        });
      } else {
        const directOwnership = await resolveProjectBayDirect(op.project_id);
        if (
          directOwnership == null ||
          directOwnership.bay_id !== op.source_bay_id
        ) {
          throw new Error(
            `project ${op.project_id} is not owned by source bay ${op.source_bay_id}`,
          );
        }
        project = await loadProjectRowForRehome(op.project_id);
        op = await updateProjectRehomeOperation({
          op_id,
          project,
        });
      }
    }

    if (op.stage === "requested") {
      await getInterBayBridge()
        .projectControl(op.dest_bay_id, {
          timeout_ms: ACCEPT_REHOME_TIMEOUT_MS,
        })
        .acceptRehome({
          project_id: op.project_id,
          source_bay_id: op.source_bay_id,
          dest_bay_id: op.dest_bay_id,
          project: project ?? op.project ?? {},
        });
      op = await updateProjectRehomeOperation({
        op_id,
        stage: "destination_accepted",
      });
    }

    if (op.stage === "destination_accepted") {
      await flipSourceOwnershipIfNeeded({
        project_id: op.project_id,
        dest_bay_id: op.dest_bay_id,
      });
      op = await updateProjectRehomeOperation({
        op_id,
        stage: "source_flipped",
      });
    }

    if (op.stage === "source_flipped") {
      await updateLocalProjectionRows({
        project_id: op.project_id,
        dest_bay_id: op.dest_bay_id,
      });
      op = await updateProjectRehomeOperation({
        op_id,
        stage: "projected",
      });
    }

    if (op.stage === "projected") {
      op = await updateProjectRehomeOperation({
        op_id,
        status: "succeeded",
        stage: "complete",
      });
    }

    log.info("project rehomed", {
      op_id,
      project_id: op.project_id,
      previous_bay_id: op.source_bay_id,
      owning_bay_id: op.dest_bay_id,
      stage: op.stage,
    });

    return {
      op_id,
      project_id: op.project_id,
      previous_bay_id: op.source_bay_id,
      owning_bay_id: op.dest_bay_id,
      operation_stage: op.stage,
      operation_status: op.status,
      status: "rehomed",
    };
  } catch (err) {
    const failed = await markProjectRehomeFailed({ op_id, err });
    log.warn("project rehome failed", {
      op_id,
      project_id: failed.project_id,
      source_bay_id: failed.source_bay_id,
      dest_bay_id: failed.dest_bay_id,
      stage: failed.stage,
      err: `${err}`,
    });
    throw err;
  }
}

export async function rehomeProject({
  account_id,
  project_id,
  dest_bay_id,
  reason,
  campaign_id,
}: {
  account_id: string;
  project_id: string;
  dest_bay_id: string;
  reason?: string | null;
  campaign_id?: string | null;
}): Promise<ProjectControlRehomeResponse> {
  await assertAdmin(account_id);
  const normalizedProjectId = normalizeProjectId(project_id);
  const destBayId = normalizeExplicitBayId("dest_bay_id", dest_bay_id);
  await assertBayAcceptsProjectOwnership(destBayId);
  const ownership = await resolveProjectBay(normalizedProjectId);
  if (ownership == null) {
    throw new Error(`project ${normalizedProjectId} not found`);
  }
  const localBayId = getConfiguredBayId();
  if (ownership.bay_id !== localBayId) {
    return await getInterBayBridge()
      .projectControl(ownership.bay_id, {
        timeout_ms: ACCEPT_REHOME_TIMEOUT_MS,
      })
      .rehome({
        account_id,
        project_id: normalizedProjectId,
        dest_bay_id: destBayId,
        reason,
        campaign_id,
        epoch: ownership.epoch,
      });
  }
  return await rehomeProjectOnOwningBay({
    account_id,
    project_id: normalizedProjectId,
    dest_bay_id: destBayId,
    reason,
    campaign_id,
  });
}

export async function reconcileProjectRehome({
  account_id,
  op_id,
}: {
  account_id: string;
  op_id: string;
}): Promise<ProjectControlRehomeResponse> {
  await assertAdmin(account_id);
  return await runProjectRehomeOperation(op_id);
}

export async function drainProjectRehome({
  account_id,
  source_bay_id,
  dest_bay_id,
  limit = 25,
  dry_run = true,
  campaign_id,
  reason,
}: {
  account_id: string;
  source_bay_id?: string;
  dest_bay_id: string;
  limit?: number;
  dry_run?: boolean;
  campaign_id?: string | null;
  reason?: string | null;
}): Promise<ProjectRehomeDrainResult> {
  await assertAdmin(account_id);
  const localBayId = getConfiguredBayId();
  const sourceBayId = normalizeExplicitBayId(
    "source_bay_id",
    source_bay_id ?? localBayId,
  );
  const destBayId = normalizeExplicitBayId("dest_bay_id", dest_bay_id);
  if (sourceBayId !== localBayId) {
    throw new Error(
      `project rehome drain must run on the source bay (${sourceBayId}); local bay is ${localBayId}`,
    );
  }
  if (sourceBayId === destBayId) {
    throw new Error("source and destination bay must be different");
  }
  await assertBayAcceptsProjectOwnership(destBayId);
  const normalizedLimit = Math.min(
    500,
    Math.max(1, Number.isInteger(limit) ? limit : 25),
  );
  const { rows } = await getPool().query<{ project_id: string }>(
    `
      SELECT project_id
        FROM projects
       WHERE COALESCE(NULLIF(BTRIM(owning_bay_id), ''), $1) = $1
         AND deleted IS NOT TRUE
       ORDER BY last_edited ASC NULLS FIRST, created ASC NULLS FIRST
       LIMIT $2
    `,
    [sourceBayId, normalizedLimit],
  );
  const candidates = rows.map((row) => row.project_id);
  const result: ProjectRehomeDrainResult = {
    source_bay_id: sourceBayId,
    dest_bay_id: destBayId,
    dry_run,
    limit: normalizedLimit,
    campaign_id: campaign_id ?? null,
    candidate_count: candidates.length,
    candidates,
    rehomed: [],
    errors: [],
  };
  if (dry_run) {
    return result;
  }
  for (const project_id of candidates) {
    try {
      result.rehomed.push(
        await rehomeProjectOnOwningBay({
          account_id,
          project_id,
          dest_bay_id: destBayId,
          campaign_id: campaign_id ?? `drain:${sourceBayId}->${destBayId}`,
          reason: reason ?? `drain ${sourceBayId} to ${destBayId}`,
        }),
      );
    } catch (err) {
      result.errors.push({
        project_id,
        error: err instanceof Error ? err.message : `${err}`,
      });
    }
  }
  return result;
}
