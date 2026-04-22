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

type Queryable = {
  query: (
    sql: string,
    params?: any[],
  ) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

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
  project_id,
  dest_bay_id,
}: {
  project_id: string;
  dest_bay_id: string;
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

  const project = await loadProjectRowForRehome(normalizedProjectId);
  await getInterBayBridge()
    .projectControl(destBayId, {
      timeout_ms: ACCEPT_REHOME_TIMEOUT_MS,
    })
    .acceptRehome({
      project_id: normalizedProjectId,
      source_bay_id: localBayId,
      dest_bay_id: destBayId,
      project,
      epoch: directOwnership.epoch,
    });

  await getPool().query(
    `
      UPDATE projects
         SET owning_bay_id = $2
       WHERE project_id = $1
    `,
    [normalizedProjectId, destBayId],
  );
  await updateLocalProjectionRows({
    project_id: normalizedProjectId,
    dest_bay_id: destBayId,
  });

  log.info("project rehomed", {
    project_id: normalizedProjectId,
    previous_bay_id: localBayId,
    owning_bay_id: destBayId,
  });

  return {
    project_id: normalizedProjectId,
    previous_bay_id: localBayId,
    owning_bay_id: destBayId,
    status: "rehomed",
  };
}

export async function rehomeProject({
  account_id,
  project_id,
  dest_bay_id,
}: {
  account_id: string;
  project_id: string;
  dest_bay_id: string;
}): Promise<ProjectControlRehomeResponse> {
  await assertAdmin(account_id);
  const normalizedProjectId = normalizeProjectId(project_id);
  const destBayId = normalizeExplicitBayId("dest_bay_id", dest_bay_id);
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
        epoch: ownership.epoch,
      });
  }
  return await rehomeProjectOnOwningBay({
    project_id: normalizedProjectId,
    dest_bay_id: destBayId,
  });
}
