/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { publishLroSummary } from "@cocalc/server/lro/stream";
import { updateLro } from "@cocalc/server/lro/lro-db";
import { getProjectActiveOperation } from "@cocalc/server/projects/active-operation";

const log = getLogger("server:projects:start-lro-cleanup");

const ACTIVE_START_STATUSES = ["queued", "running"] as const;
const ORPHANED_START_LRO_GRACE_MS = 30_000;
const RECENT_STARTING_STATE_MS = 5 * 60_000;

type ProjectStartLroRow = {
  op_id: string;
  scope_type: "project";
  scope_id: string;
  error?: string | null;
  created_at?: Date | string | null;
};

async function cancelProjectStartLro({
  project_id,
  op_id,
  error,
  context,
}: {
  project_id: string;
  op_id: string;
  error?: string | null;
  context: string;
}): Promise<void> {
  try {
    const updated = await updateLro({
      op_id,
      status: "canceled",
      error: error ?? context,
    });
    if (updated) {
      await publishLroSummary({
        scope_type: updated.scope_type,
        scope_id: updated.scope_id,
        summary: updated,
      });
    }
  } catch (err) {
    log.warn("unable to cancel project-start lro", {
      project_id,
      op_id,
      context,
      err: `${err}`,
    });
  }
}

function parseProjectState(rawState: any): { state?: string; timeMs?: number } {
  const parsed =
    typeof rawState === "string" ? JSON.parse(rawState) : (rawState ?? {});
  const state = typeof parsed?.state === "string" ? parsed.state : undefined;
  const timeMs =
    parsed?.time != null ? new Date(parsed.time).getTime() : undefined;
  return {
    state,
    timeMs: Number.isFinite(timeMs) ? timeMs : undefined,
  };
}

export async function cancelStaleProjectStartLros({
  project_id,
  keep_op_id,
  nowMs = Date.now(),
}: {
  project_id: string;
  keep_op_id?: string;
  nowMs?: number;
}): Promise<number> {
  const targetOpId = `${keep_op_id ?? ""}`.trim();
  let rows: ProjectStartLroRow[] = [];
  try {
    const result = await getPool().query<ProjectStartLroRow>(
      `
        SELECT op_id, scope_type, scope_id, error, created_at
        FROM long_running_operations
        WHERE kind='project-start'
          AND scope_type='project'
          AND scope_id=$1
          AND dismissed_at IS NULL
          AND status = ANY($2::text[])
        ORDER BY created_at DESC
      `,
      [project_id, ACTIVE_START_STATUSES],
    );
    rows = result.rows;
  } catch (err) {
    log.warn("unable to list active project-start lros", {
      project_id,
      keep_op_id: targetOpId || undefined,
      err: `${err}`,
    });
    return 0;
  }
  if (!rows.length) {
    return 0;
  }

  const activeOp = await getProjectActiveOperation({ project_id }).catch(
    (err) => {
      log.warn("unable to inspect active project operation", {
        project_id,
        err: `${err}`,
      });
      return null;
    },
  );
  const currentActiveOpId =
    activeOp?.kind === "project-start" && activeOp.status === "running"
      ? `${activeOp.op_id ?? ""}`.trim()
      : "";

  let projectState: string | undefined;
  let projectStateTimeMs: number | undefined;
  try {
    const result = await getPool().query<{ state: any }>(
      "SELECT state FROM projects WHERE project_id=$1",
      [project_id],
    );
    const parsed = parseProjectState(result.rows[0]?.state);
    projectState = parsed.state;
    projectStateTimeMs = parsed.timeMs;
  } catch (err) {
    log.warn("unable to inspect project state while cleaning start lros", {
      project_id,
      err: `${err}`,
    });
  }

  const newestOpId = `${rows[0]?.op_id ?? ""}`.trim();
  const recentStartingState =
    projectState === "starting" &&
    projectStateTimeMs != null &&
    nowMs - projectStateTimeMs <= RECENT_STARTING_STATE_MS;

  let canceled = 0;
  for (const row of rows) {
    const opId = `${row.op_id ?? ""}`.trim();
    if (!opId || opId === targetOpId) {
      continue;
    }
    if (currentActiveOpId) {
      if (opId === currentActiveOpId) {
        continue;
      }
      await cancelProjectStartLro({
        project_id,
        op_id: opId,
        error: row.error,
        context: `superseded by active project start ${currentActiveOpId}`,
      });
      canceled += 1;
      continue;
    }

    const createdAtMs = row.created_at
      ? new Date(row.created_at).getTime()
      : undefined;
    const ageMs =
      createdAtMs != null && Number.isFinite(createdAtMs)
        ? nowMs - createdAtMs
        : undefined;
    if (ageMs == null || ageMs < ORPHANED_START_LRO_GRACE_MS) {
      continue;
    }
    if (recentStartingState && opId === newestOpId) {
      continue;
    }

    await cancelProjectStartLro({
      project_id,
      op_id: opId,
      error: row.error,
      context: "orphaned project start operation",
    });
    canceled += 1;
  }

  return canceled;
}

export async function supersedeOlderProjectStartLros({
  project_id,
  keep_op_id,
}: {
  project_id: string;
  keep_op_id?: string;
}): Promise<void> {
  const targetOpId = `${keep_op_id ?? ""}`.trim();
  if (!targetOpId) {
    return;
  }

  let rows: ProjectStartLroRow[] | undefined;
  try {
    const result = await getPool().query<ProjectStartLroRow>(
      `
        SELECT op_id, scope_type, scope_id, error
        FROM long_running_operations
        WHERE kind='project-start'
          AND scope_type='project'
          AND scope_id=$1
          AND op_id <> $2
          AND dismissed_at IS NULL
          AND status = ANY($3::text[])
        ORDER BY created_at DESC
      `,
      [project_id, targetOpId, ACTIVE_START_STATUSES],
    );
    rows = result.rows;
  } catch (err) {
    log.warn("unable to list older project-start lros", {
      project_id,
      keep_op_id: targetOpId,
      err: `${err}`,
    });
    return;
  }

  for (const row of rows) {
    await cancelProjectStartLro({
      project_id,
      op_id: row.op_id,
      error: row.error,
      context: `superseded by later successful project start ${targetOpId}`,
    });
  }
}
