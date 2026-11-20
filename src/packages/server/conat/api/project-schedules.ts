/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A project's automatic snapshot and backup schedules (projects.snapshots and
// projects.backups). The web app's schedule dialogs change them through a
// user query; these methods make the same change for scripts and the CLI,
// with fresh auth and the dialogs' permission rule and project limit checked
// on the server. Routed to the project's owning bay (see
// @cocalc/conat/hub/api/routes); fresh auth runs on the caller's home bay.

import getPool from "@cocalc/database/pool";
import { publishProjectDetailInvalidationBestEffort } from "@cocalc/server/account/project-detail-feed";
import { assertProjectRuntimeCapability } from "@cocalc/server/launchpad/project-runtime";
import {
  getProjectBackupLimit,
  getProjectSnapshotLimit,
} from "@cocalc/server/membership/project-limits";
import { assertCanPerformDestructiveStorageAction } from "@cocalc/server/projects/destructive-storage-actions";
import {
  DEFAULT_BACKUP_COUNTS,
  DEFAULT_SNAPSHOT_COUNTS,
  type SnapshotSchedule,
} from "@cocalc/util/consts/snapshots";
import { isValidUUID } from "@cocalc/util/misc";
import { requireDangerousProjectMutationAuth } from "./project-dangerous-auth";

export type ProjectScheduleKind = "snapshots" | "backups";
export type ProjectScheduleUpdate = Partial<SnapshotSchedule>;

const COUNT_FIELDS = ["frequent", "daily", "weekly", "monthly"] as const;

const LABEL: Record<ProjectScheduleKind, string> = {
  snapshots: "snapshot",
  backups: "backup",
};

// The stored schedule after applying `update`: defaults, then the stored
// counts, then the update. Backups have no frequent tier (the dialog always
// stores frequent: 0). Unknown fields and non-integer counts are refused.
export function mergeProjectScheduleUpdate({
  kind,
  stored,
  update,
}: {
  kind: ProjectScheduleKind;
  stored: Partial<SnapshotSchedule> | null | undefined;
  update: ProjectScheduleUpdate;
}): SnapshotSchedule {
  if (update == null || typeof update !== "object" || Array.isArray(update)) {
    throw new Error("schedule must be an object");
  }
  for (const key of Object.keys(update)) {
    if (
      key !== "disabled" &&
      !(COUNT_FIELDS as readonly string[]).includes(key)
    ) {
      throw new Error(`unknown ${LABEL[kind]} schedule field: ${key}`);
    }
  }
  if (update.disabled !== undefined && typeof update.disabled !== "boolean") {
    throw new Error("disabled must be a boolean");
  }
  for (const field of COUNT_FIELDS) {
    const value = update[field];
    if (value !== undefined && !(Number.isSafeInteger(value) && value >= 0)) {
      throw new Error(`${field} must be a non-negative integer`);
    }
  }
  if (
    kind === "backups" &&
    update.frequent !== undefined &&
    update.frequent !== 0
  ) {
    throw new Error("backups have no frequent tier; frequent must be 0");
  }
  const defaults =
    kind === "snapshots" ? DEFAULT_SNAPSHOT_COUNTS : DEFAULT_BACKUP_COUNTS;
  const next: SnapshotSchedule = { ...defaults, disabled: false };
  for (const field of COUNT_FIELDS) {
    const value = stored?.[field];
    if (Number.isSafeInteger(value) && (value as number) >= 0) {
      next[field] = value as number;
    }
  }
  if (stored?.disabled === true) next.disabled = true;
  for (const field of COUNT_FIELDS) {
    if (update[field] !== undefined) next[field] = update[field] as number;
  }
  if (update.disabled !== undefined) next.disabled = update.disabled;
  if (kind === "backups") next.frequent = 0;
  return next;
}

// What counts against the project's limit, as in the schedule dialogs.
export function projectScheduleTotal(
  kind: ProjectScheduleKind,
  schedule: SnapshotSchedule,
): number {
  if (schedule.disabled) return 0;
  return (
    (kind === "snapshots" ? schedule.frequent : 0) +
    schedule.daily +
    schedule.weekly +
    schedule.monthly
  );
}

async function setProjectSchedule({
  kind,
  account_id,
  browser_id,
  session_hash,
  project_id,
  schedule,
}: {
  kind: ProjectScheduleKind;
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  project_id: string;
  schedule: ProjectScheduleUpdate;
}): Promise<SnapshotSchedule> {
  if (!account_id) {
    throw new Error("must be signed in");
  }
  if (!isValidUUID(project_id)) {
    throw new Error("invalid project_id");
  }
  assertProjectRuntimeCapability(kind);
  await requireDangerousProjectMutationAuth({
    account_id,
    browser_id,
    session_hash,
  });
  await assertCanPerformDestructiveStorageAction({
    account_id,
    project_id,
    action: `change ${LABEL[kind]} schedules`,
  });
  // Validate the update before touching the database.
  mergeProjectScheduleUpdate({ kind, stored: null, update: schedule });
  const limit =
    kind === "snapshots"
      ? await getProjectSnapshotLimit({ project_id })
      : await getProjectBackupLimit({ project_id });

  const client = await getPool().connect();
  let stored: SnapshotSchedule;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      schedule: Partial<SnapshotSchedule> | null;
    }>(
      `SELECT ${kind} AS schedule FROM projects
       WHERE project_id = $1 AND deleted IS NOT TRUE
       FOR UPDATE`,
      [project_id],
    );
    if (rows.length === 0) {
      throw new Error("project not found");
    }
    const next = mergeProjectScheduleUpdate({
      kind,
      stored: rows[0].schedule,
      update: schedule,
    });
    const total = projectScheduleTotal(kind, next);
    if (limit != null && total > limit) {
      throw new Error(
        `automatic ${kind} total ${total} exceeds project limit ${limit}`,
      );
    }
    const updated = await client.query<{ schedule: SnapshotSchedule }>(
      `UPDATE projects SET ${kind} = $2::JSONB
       WHERE project_id = $1
       RETURNING ${kind} AS schedule`,
      [project_id, JSON.stringify(next)],
    );
    stored = updated.rows[0].schedule;
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  await publishProjectDetailInvalidationBestEffort({
    project_id,
    fields: [kind],
  });
  return stored;
}

export async function setProjectSnapshotSchedule(opts: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  project_id: string;
  schedule: ProjectScheduleUpdate;
}): Promise<SnapshotSchedule> {
  return await setProjectSchedule({ ...opts, kind: "snapshots" });
}

export async function setProjectBackupSchedule(opts: {
  account_id?: string;
  browser_id?: string | null;
  session_hash?: string | null;
  project_id: string;
  schedule: ProjectScheduleUpdate;
}): Promise<SnapshotSchedule> {
  return await setProjectSchedule({ ...opts, kind: "backups" });
}
