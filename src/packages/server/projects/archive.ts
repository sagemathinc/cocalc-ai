/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { conat } from "@cocalc/backend/conat";
import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { appendProjectOutboxEventForProject } from "@cocalc/database/postgres/project-events-outbox";
import {
  assertProjectNotRehoming,
  withProjectRehomeWriteFence,
} from "@cocalc/database/postgres/project-rehome-fence";
import type { BayOwnership } from "@cocalc/conat/inter-bay/api";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import { publishProjectAccountFeedEventsBestEffort } from "@cocalc/server/account/project-feed";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { createBackup } from "@cocalc/server/conat/api/project-backups";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import {
  attestReleasedLroDedupeSuccesses,
  listLrosByDedupe,
} from "@cocalc/server/lro/lro-db";
import { waitForDurableLroCompletion } from "@cocalc/server/lro/wait";
import {
  deleteProjectDataOnHost,
  deleteProjectDataOnHostAfterBackup,
  releaseProjectDataArchiveFreezeOnHost,
} from "@cocalc/server/project-host/control";
import { BACKUP_TIMEOUT_MS } from "@cocalc/server/projects/backup-lro";
import {
  clearProjectArchiveLifecycleFinalBackup,
  createProjectArchiveLifecycleJob,
  getProjectArchiveLifecycleFinalBackup,
  recordProjectArchiveLifecycleFinalBackup,
  type ProjectArchiveLifecycleFinalBackup,
  updateProjectArchiveLifecycleJob,
} from "./archive-lifecycle-db";
import { isArchiveBackupFailureReopenSafe } from "./backup-freeze-recovery";
import { isProjectArchiveBackupCurrent } from "./archive-lifecycle-policy";
import type {
  ArchiveLifecycleProjectSnapshot,
  ProjectArchiveReason,
} from "./archive-lifecycle-types";

const log = getLogger("server:projects:archive");

export type ArchiveProjectStorageOptions = {
  project_id: string;
  mode: "manual" | "automatic";
  actor_account_id?: string | null;
  job_id?: string;
  reason?: ProjectArchiveReason;
  expected_host_id?: string | null;
};

export class ProjectArchiveStorageError extends Error {
  readonly hostCleanupCompleted: boolean;
  readonly reopenSafe: boolean;

  constructor(
    message: string,
    hostCleanupCompleted: boolean,
    reopenSafe: boolean,
  ) {
    super(message);
    this.name = "ProjectArchiveStorageError";
    this.hostCleanupCompleted = hostCleanupCompleted;
    this.reopenSafe = reopenSafe;
  }
}

type ArchiveRow = Omit<
  ArchiveLifecycleProjectSnapshot,
  "active_published_path"
>;

const FINAL_ARCHIVE_BACKUP_TAG = "automatic-project-archive-final";

function finalArchiveBackupDedupeKey(job_id: string): string {
  return `${FINAL_ARCHIVE_BACKUP_TAG}:${job_id}`;
}

class FinalAutomaticArchiveBackupError extends Error {
  readonly reopenSafe: boolean;

  constructor(message: string, reopenSafe: boolean) {
    super(message);
    this.name = "FinalAutomaticArchiveBackupError";
    this.reopenSafe = reopenSafe;
  }
}

async function loadArchiveRow(project_id: string): Promise<ArchiveRow> {
  const { rows } = await getPool().query<ArchiveRow>(
    `SELECT p.project_id,
            COALESCE(p.owning_bay_id, $2) AS owning_bay_id,
            p.host_id,
            h.status AS host_status,
            p.deleted,
            p.provisioned,
            p.deletion_protection,
            p.state,
            p.users,
            p.created,
            p.last_edited,
            p.last_changed,
            p.last_changed_generation,
            p.last_backup,
            p.last_backup_generation,
            p.backup_repo_id,
            p.archive_lifecycle_job_id
       FROM projects p
       LEFT JOIN project_hosts h ON h.id = p.host_id
      WHERE p.project_id = $1
        AND p.deleted IS NULL
      LIMIT 1`,
    [project_id, getConfiguredBayId()],
  );
  if (!rows[0]) throw new Error("project not found");
  return rows[0];
}

async function publishState(project_id: string): Promise<void> {
  await publishProjectAccountFeedEventsBestEffort({
    project_id,
    default_bay_id: getConfiguredBayId(),
  });
}

function assertAutomaticArchiveClaimCurrent({
  row,
  job_id,
  expected_host_id,
}: {
  row: ArchiveRow;
  job_id: string;
  expected_host_id?: string | null;
}): void {
  const state = `${row.state?.state ?? ""}`.trim();
  if (state !== "archiving" || row.archive_lifecycle_job_id !== job_id) {
    throw new Error("automatic archive project claim is no longer current");
  }
  if (expected_host_id && row.host_id !== expected_host_id) {
    throw new Error("automatic archive placement changed before cleanup");
  }
}

async function assertAutomaticArchiveOwnershipCurrent({
  project_id,
  expected,
}: {
  project_id: string;
  expected: BayOwnership;
}): Promise<void> {
  const current = await resolveProjectBay(project_id);
  const localBayId = getConfiguredBayId();
  if (
    expected.bay_id !== localBayId ||
    current == null ||
    current.bay_id !== expected.bay_id ||
    current.epoch !== expected.epoch
  ) {
    throw new Error(
      `automatic archive ownership changed for project ${project_id}: expected bay=${expected.bay_id}, epoch=${expected.epoch}; current bay=${current?.bay_id ?? "missing"}, epoch=${current?.epoch ?? "missing"}`,
    );
  }
}

async function lockCurrentAutomaticArchiveClaim({
  db,
  project_id,
  job_id,
  expected_host_id,
}: {
  db: {
    query: (
      sql: string,
      params?: any[],
    ) => Promise<{ rows: any[]; rowCount?: number | null }>;
  };
  project_id: string;
  job_id: string;
  expected_host_id: string | null;
}): Promise<void> {
  const localBayId = getConfiguredBayId();
  const result = await db.query(
    `SELECT 1
       FROM projects
      WHERE project_id = $1
        AND deleted IS NULL
        AND COALESCE(NULLIF(BTRIM(owning_bay_id), ''), $4) = $4
        AND state ->> 'state' = 'archiving'
        AND archive_lifecycle_job_id = $2
        AND host_id IS NOT DISTINCT FROM $3::uuid
      FOR UPDATE`,
    [project_id, job_id, expected_host_id, localBayId],
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new Error(
      "automatic archive ownership, claim, or placement changed before cleanup",
    );
  }
}

async function recordFinalAutomaticArchiveBackup({
  project_id,
  job_id,
  expected_host_id,
  expected_ownership,
  backup,
  expected_previous_backup_id,
}: {
  project_id: string;
  job_id: string;
  expected_host_id: string | null;
  expected_ownership: BayOwnership;
  backup: ProjectArchiveLifecycleFinalBackup;
  expected_previous_backup_id: string | null;
}): Promise<void> {
  // Catch a completed rehome first, then hold the source bay's rehome fence
  // while persisting the marker so an in-progress move cannot pass unnoticed.
  await assertAutomaticArchiveOwnershipCurrent({
    project_id,
    expected: expected_ownership,
  });
  await withProjectRehomeWriteFence({
    project_id,
    action: "record final automatic archive backup",
    fn: async (db) => {
      await lockCurrentAutomaticArchiveClaim({
        db,
        project_id,
        job_id,
        expected_host_id,
      });
      await recordProjectArchiveLifecycleFinalBackup({
        job_id,
        backup_id: backup.id,
        backup_generation: Number(backup.generation),
        backup_time: backup.time,
        expected_previous_backup_id,
      });
    },
  });
}

function assertAutomaticArchiveCanCreateBackup(row: ArchiveRow): void {
  const hostStatus = `${row.host_status ?? ""}`.trim().toLowerCase();
  if (!row.host_id || !["active", "running"].includes(hostStatus)) {
    throw new Error("automatic archive requires a reachable live host");
  }
  if (
    !isProjectArchiveBackupCurrent({
      ...row,
      active_published_path: false,
    })
  ) {
    throw new Error("automatic archive backup is missing or stale");
  }
}

async function createFinalAutomaticArchiveBackup({
  project_id,
  job_id,
  beforeCreateNew,
  onBackupBarrierMayExist,
}: {
  project_id: string;
  job_id: string;
  beforeCreateNew: () => Promise<void>;
  onBackupBarrierMayExist?: () => void;
}): Promise<ProjectArchiveLifecycleFinalBackup> {
  const dedupeKey = finalArchiveBackupDedupeKey(job_id);
  let history: LroSummary[];
  try {
    history = await listLrosByDedupe({
      scope_type: "project",
      scope_id: project_id,
      dedupe_key: dedupeKey,
    });
  } catch (err) {
    // A lifecycle retry cannot reopen while it cannot rule out a prior
    // succeeded-but-unrecorded freeze for this durable job identity.
    onBackupBarrierMayExist?.();
    throw err;
  }

  let summary: LroSummary;
  const active = history.find(({ status }) =>
    ["queued", "running"].includes(status),
  );
  // An unresolved newer attempt may have replaced and pruned an older backup.
  const succeeded = history.find(
    ({ status, result }, index) =>
      status === "succeeded" &&
      !isArchiveBackupFailureReopenSafe(result) &&
      history
        .slice(0, index)
        .every(
          ({ status, result }) =>
            status !== "succeeded" && isArchiveBackupFailureReopenSafe(result),
        ),
  );
  const unresolvedHistoricalBarrier = history.some(
    (entry) =>
      entry !== active && !isArchiveBackupFailureReopenSafe(entry.result),
  );
  if (active) {
    onBackupBarrierMayExist?.();
    summary = await waitForDurableLroCompletion({
      op_id: active.op_id,
      scope_type: active.scope_type,
      scope_id: active.scope_id,
      client: conat(),
      timeout_ms: BACKUP_TIMEOUT_MS + 60_000,
    });
  } else if (succeeded) {
    onBackupBarrierMayExist?.();
    summary = succeeded;
  } else {
    if (
      history.some(({ result }) => !isArchiveBackupFailureReopenSafe(result))
    ) {
      onBackupBarrierMayExist?.();
    }
    await beforeCreateNew();
    const op = await createBackup(
      {
        project_id,
        tags: [FINAL_ARCHIVE_BACKUP_TAG],
      },
      {
        skip_collab_check: true,
        skip_rootfs_portability_check: true,
        replace_oldest_at_limit: true,
        freeze_source: true,
        dedupe_key: dedupeKey,
        on_lro_create_started: onBackupBarrierMayExist,
      },
    );
    onBackupBarrierMayExist?.();
    summary = await waitForDurableLroCompletion({
      op_id: op.op_id,
      scope_type: op.scope_type,
      scope_id: op.scope_id,
      client: conat(),
      timeout_ms: BACKUP_TIMEOUT_MS + 60_000,
    });
  }
  if (summary.status !== "succeeded") {
    throw new FinalAutomaticArchiveBackupError(
      `final automatic archive backup failed: ${summary.error ?? summary.status}`,
      !unresolvedHistoricalBarrier &&
        isArchiveBackupFailureReopenSafe(summary.result),
    );
  }
  const result = summary.result ?? {};
  const id = `${result.id ?? result.backup_id ?? ""}`.trim();
  if (!id) {
    throw new Error(
      "final automatic archive backup completed without a snapshot id",
    );
  }
  const generation = Number(result.generation);
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error(
      "final automatic archive backup completed without a filesystem generation",
    );
  }
  return {
    id,
    generation,
    time: result.time ?? result.backup_time ?? null,
  };
}

// A Btrfs generation identifies a volume state only within one filesystem.
// Project moves and restores can therefore produce a valid final generation
// below the monotonic generation retained by control-plane change tracking.
// Destructive safety comes from the host checking this marker against both the
// frozen source volume and the exact Rustic snapshot immediately before delete.
function finalBackupMarkerIsValid(
  backup: ProjectArchiveLifecycleFinalBackup,
): boolean {
  const backupGeneration = Number(backup.generation);
  return (
    `${backup.id ?? ""}`.trim().length > 0 &&
    Number.isSafeInteger(backupGeneration) &&
    backupGeneration > 0
  );
}

function assertFinalBackupMarkerIsValid(
  backup: ProjectArchiveLifecycleFinalBackup,
): void {
  if (!finalBackupMarkerIsValid(backup)) {
    throw new Error(
      "final automatic archive backup marker is missing a valid snapshot id or filesystem generation",
    );
  }
}

async function setArchivedState({
  project_id,
  reason,
  job_id,
  automatic,
  expected_host_id,
  cleanupHostData,
}: {
  project_id: string;
  reason: ProjectArchiveReason;
  job_id: string;
  automatic: boolean;
  expected_host_id?: string | null;
  cleanupHostData?: () => Promise<void>;
}): Promise<void> {
  const checkedAt = new Date();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await assertProjectNotRehoming({
      db: client,
      project_id,
      action: "archive project",
    });
    if (automatic) {
      await lockCurrentAutomaticArchiveClaim({
        db: client,
        project_id,
        job_id,
        expected_host_id: expected_host_id ?? null,
      });
    }
    // The advisory rehome fence remains held until the archived state commits,
    // closing the authority-check-to-host-deletion race.
    await cleanupHostData?.();
    const result = await client.query(
      `UPDATE projects
          SET state = $2::jsonb,
              provisioned = FALSE,
              provisioned_checked_at = $3,
              archive_reason = $4,
              archived_at = $3,
              archive_lifecycle_job_id = $5
        WHERE project_id = $1
          AND deleted IS NULL
          AND ($6::boolean IS FALSE OR (
            state ->> 'state' = 'archiving'
            AND archive_lifecycle_job_id = $5
            AND host_id IS NOT DISTINCT FROM $7::uuid
          ))`,
      [
        project_id,
        { state: "archived", time: checkedAt.toISOString() },
        checkedAt,
        reason,
        job_id,
        automatic,
        expected_host_id ?? null,
      ],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new Error("project archive claim became stale after host cleanup");
    }
    await appendProjectOutboxEventForProject({
      db: client,
      event_type: "project.state_changed",
      project_id,
      default_bay_id: getConfiguredBayId(),
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  await publishState(project_id);
}

export async function archiveProjectStorage({
  project_id,
  mode,
  actor_account_id,
  job_id: providedJobId,
  reason: providedReason,
  expected_host_id,
}: ArchiveProjectStorageOptions): Promise<void> {
  let row = await loadArchiveRow(project_id);
  const currentState = `${row.state?.state ?? ""}`.trim();
  if (currentState === "archived" && row.provisioned === false) return;

  const automatic = mode === "automatic";
  const reason = automatic ? providedReason : (providedReason ?? "manual");
  if (!reason) throw new Error("automatic archive reason is required");

  let jobId = providedJobId;
  if (!automatic) {
    const job = await createProjectArchiveLifecycleJob({
      project: { ...row, active_published_path: false },
      reason,
      reportOnly: false,
      actorAccountId: actor_account_id,
    });
    jobId = job?.id;
  }
  if (!jobId) throw new Error("archive lifecycle job is required");

  let hostCleanupCompleted = false;
  let expectedArchiveGeneration: number | undefined;
  let expectedArchiveBackupId: string | undefined;
  let finalBackupBarrierMayExist = false;
  let finalBackup: ProjectArchiveLifecycleFinalBackup | undefined;
  try {
    if (!row.backup_repo_id) {
      throw new Error(
        "project must have a configured backup repository before it can be archived",
      );
    }
    let hostStatus = `${row.host_status ?? ""}`.trim().toLowerCase();
    const hostDeprovisioned = hostStatus === "deprovisioned";
    const hostCanRunMutations =
      !hostStatus || hostStatus === "active" || hostStatus === "running";

    if (automatic) {
      assertAutomaticArchiveClaimCurrent({
        row,
        job_id: jobId,
        expected_host_id,
      });
      finalBackup = await getProjectArchiveLifecycleFinalBackup(jobId);
      const finalBackupCurrent =
        !!finalBackup && finalBackupMarkerIsValid(finalBackup);
      if (finalBackup && finalBackupCurrent) {
        expectedArchiveGeneration = Number(finalBackup.generation);
        expectedArchiveBackupId = finalBackup.id;
      }
    } else if (!hostDeprovisioned && row.last_backup == null) {
      throw new Error(
        "project must have at least one backup before it can be archived",
      );
    }

    const ownership = await resolveProjectBay(project_id);
    if (!ownership) throw new Error(`project ${project_id} not found`);
    if (automatic) {
      await assertAutomaticArchiveOwnershipCurrent({
        project_id,
        expected: ownership,
      });
    }
    if (
      !automatic &&
      hostCanRunMutations &&
      ["running", "starting", "pending", "stopping"].includes(currentState)
    ) {
      await getInterBayBridge().projectControl(ownership.bay_id).stop({
        project_id,
        epoch: ownership.epoch,
      });
    }

    if (automatic) {
      if (
        row.provisioned !== false &&
        (!finalBackup || !finalBackupMarkerIsValid(finalBackup))
      ) {
        const previousFinalBackupId = finalBackup?.id ?? null;
        finalBackup = await createFinalAutomaticArchiveBackup({
          project_id,
          job_id: jobId,
          beforeCreateNew: async () => {
            row = await loadArchiveRow(project_id);
            assertAutomaticArchiveClaimCurrent({
              row,
              job_id: jobId,
              expected_host_id,
            });
            assertAutomaticArchiveCanCreateBackup(row);
            await assertAutomaticArchiveOwnershipCurrent({
              project_id,
              expected: ownership,
            });
          },
          onBackupBarrierMayExist: () => {
            finalBackupBarrierMayExist = true;
          },
        });
        expectedArchiveGeneration = Number(finalBackup.generation);
        expectedArchiveBackupId = finalBackup.id;
        row = await loadArchiveRow(project_id);
        hostStatus = `${row.host_status ?? ""}`.trim().toLowerCase();
        if (!row.backup_repo_id) {
          throw new Error(
            "project backup repository disappeared during automatic archive",
          );
        }
        assertAutomaticArchiveClaimCurrent({
          row,
          job_id: jobId,
          expected_host_id,
        });
        assertFinalBackupMarkerIsValid(finalBackup);
        await recordFinalAutomaticArchiveBackup({
          project_id,
          job_id: jobId,
          expected_host_id: expected_host_id ?? row.host_id,
          expected_ownership: ownership,
          backup: finalBackup,
          expected_previous_backup_id: previousFinalBackupId,
        });
      }
      if (row.provisioned === false) {
        // Host cleanup was already reported even if database finalization was
        // interrupted. Never reopen a project whose local volume is absent.
        hostCleanupCompleted = true;
      } else {
        if (!finalBackup) {
          throw new Error("automatic archive final backup is missing");
        }
        assertFinalBackupMarkerIsValid(finalBackup);
        expectedArchiveGeneration = Number(finalBackup.generation);
        expectedArchiveBackupId = finalBackup.id;
      }
    }

    const refreshedHostCanRunMutations =
      !hostStatus || hostStatus === "active" || hostStatus === "running";

    let cleanupHostData: (() => Promise<void>) | undefined;
    if (row.provisioned !== false && refreshedHostCanRunMutations) {
      if (!row.host_id) {
        throw new Error("project has no assigned host to archive from");
      }
      const cleanupHostId = row.host_id;
      if (automatic) {
        if (!expectedArchiveGeneration) {
          throw new Error("automatic archive backup generation is missing");
        }
        if (!expectedArchiveBackupId) {
          throw new Error("automatic archive backup snapshot id is missing");
        }
        const cleanupGeneration = expectedArchiveGeneration;
        const cleanupBackupId = expectedArchiveBackupId;
        cleanupHostData = async () => {
          await deleteProjectDataOnHostAfterBackup({
            project_id,
            host_id: cleanupHostId,
            expected_backup_id: cleanupBackupId,
            expected_generation: cleanupGeneration,
          });
          hostCleanupCompleted = true;
        };
      } else {
        cleanupHostData = async () => {
          await deleteProjectDataOnHost({
            project_id,
            host_id: cleanupHostId,
          });
          hostCleanupCompleted = true;
        };
      }
    } else if (row.provisioned !== false) {
      log.info("archive finalized from backup without host mutation", {
        project_id,
        host_id: row.host_id,
        host_status: hostStatus || undefined,
        automatic,
      });
    }

    await setArchivedState({
      project_id,
      reason,
      job_id: jobId,
      automatic,
      expected_host_id: expected_host_id ?? row.host_id,
      cleanupHostData,
    });
    await updateProjectArchiveLifecycleJob({
      job_id: jobId,
      status: "completed",
    });
  } catch (err) {
    // A prior or current freeze-capable backup can continue on the project
    // host when the worker times out or loses its response. Without a returned
    // generation, keep the claim so a lifecycle retry can recover the barrier.
    let reopenSafe =
      !finalBackupBarrierMayExist ||
      (err instanceof FinalAutomaticArchiveBackupError && err.reopenSafe);
    if (
      automatic &&
      !hostCleanupCompleted &&
      expectedArchiveGeneration &&
      row.host_id
    ) {
      reopenSafe = false;
      try {
        const release = await releaseProjectDataArchiveFreezeOnHost({
          project_id,
          host_id: row.host_id,
          expected_generation: expectedArchiveGeneration,
        });
        if (release.status === "absent") {
          // The checked deletion completed but its response was lost. Retain
          // the durable marker and retry only database finalization.
          hostCleanupCompleted = true;
        } else {
          if (expectedArchiveBackupId) {
            const history = await attestReleasedLroDedupeSuccesses({
              scope_type: "project",
              scope_id: project_id,
              dedupe_key: finalArchiveBackupDedupeKey(jobId),
              expected_result_id: expectedArchiveBackupId,
              expected_generation: expectedArchiveGeneration,
            });
            await clearProjectArchiveLifecycleFinalBackup({
              job_id: jobId,
              backup_id: expectedArchiveBackupId,
              backup_generation: expectedArchiveGeneration,
            });
            reopenSafe = !history.some(
              ({ status, result }) =>
                status !== "succeeded" &&
                !isArchiveBackupFailureReopenSafe(result),
            );
          }
          // Reopen only after the checked host release, durable LRO
          // attestation, marker rollback, and historical safety check agree.
        }
      } catch (releaseErr) {
        log.warn("unable to release automatic archive volume freeze", {
          project_id,
          host_id: row.host_id,
          expected_generation: expectedArchiveGeneration,
          err: `${releaseErr}`,
        });
      }
    }
    await updateProjectArchiveLifecycleJob({
      job_id: jobId,
      status: "failed",
      failure_category: "archive-storage",
      error: err,
    }).catch(() => undefined);
    if (automatic) {
      throw new ProjectArchiveStorageError(
        `${err}`,
        hostCleanupCompleted,
        reopenSafe,
      );
    }
    throw err;
  }
}
