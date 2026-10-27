/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";

import getLogger from "@cocalc/backend/logger";
import getPool, {
  type PoolClient,
  withSessionAdvisoryLock,
} from "@cocalc/database/pool";
import { appendProjectOutboxEventForProject } from "@cocalc/database/postgres/project-events-outbox";
import { assertProjectNotRehoming } from "@cocalc/database/postgres/project-rehome-fence";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { publishProjectAccountFeedEventsBestEffort } from "@cocalc/server/account/project-feed";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveProjectBayDirect } from "@cocalc/server/inter-bay/directory";
import { isOversizedFilesMessage } from "@cocalc/util/consts/backups";
import { releaseProjectDataArchiveFreezeOnHost } from "@cocalc/server/project-host/control";
import {
  archiveProjectStorage,
  FinalArchiveBackupPendingError,
  ProjectArchiveStorageError,
} from "./archive";
import { resolveArchiveLifecycleAccountStatuses } from "./archive-lifecycle-accounts";
import {
  claimProjectArchiveLifecycleJob,
  claimRetainedProjectArchiveLifecycleJob,
  countRecentAutomaticArchives,
  countRunningArchivesByHost,
  createProjectArchiveLifecycleJob,
  listQueuedProjectArchiveLifecycleJobs,
  listRecoverableProjectArchiveLifecycleJobs,
  type ProjectArchiveLifecycleJob,
  updateProjectArchiveLifecycleJob,
} from "./archive-lifecycle-db";
import {
  archiveLifecycleCollaboratorIds,
  evaluateProjectArchiveEligibility,
} from "./archive-lifecycle-policy";
import { ensureProjectArchiveLifecycleSchema } from "./archive-lifecycle-schema";
import {
  PROJECT_ARCHIVE_POLICY_VERSION,
  type ArchiveLifecycleProjectSnapshot,
  type ProjectArchiveEligibilityDecision,
  type ProjectArchiveLifecycleConfig,
  type ProjectArchiveLifecycleMaintenanceStatus,
  type ProjectArchiveLifecycleRunSummary,
} from "./archive-lifecycle-types";

const logger = getLogger("server:projects:archive-lifecycle-maintenance");
const LOCK_KEY = "project_archive_lifecycle_maintenance";
const CHECK_INTERVAL_MS = Math.max(
  30_000,
  Number(
    process.env.COCALC_PROJECT_ARCHIVE_MAINTENANCE_INTERVAL_MS ?? 5 * 60_000,
  ),
);

type SettingsRecord = Record<string, unknown>;
type ArchiveLifecycleCandidateSnapshot = ArchiveLifecycleProjectSnapshot & {
  candidate_order_at: Date | string;
  candidate_cursor_at: string;
};

let candidateCursor:
  | { candidate_order_at: Date | string; project_id: string }
  | undefined;

const status: ProjectArchiveLifecycleMaintenanceStatus = {
  running: false,
  started: false,
  last_started_at: null,
  last_completed_at: null,
  last_error: null,
  last_result: null,
};

function positiveInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonnegativeInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function booleanSetting(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  if (!normalized) return fallback;
  return ["1", "true", "yes", "on"].includes(normalized);
}

function stringList(value: unknown): string[] {
  return [...new Set(`${value ?? ""}`.split(",").map((item) => item.trim()))]
    .filter(Boolean)
    .sort();
}

export async function loadProjectArchiveLifecycleConfig(): Promise<ProjectArchiveLifecycleConfig> {
  const settings = (await getServerSettings()) as SettingsRecord;
  return {
    enabled: booleanSetting(
      settings.automatic_project_archiving_enabled,
      false,
    ),
    reportOnly: booleanSetting(
      settings.automatic_project_archiving_report_only,
      true,
    ),
    freeAfterDays: positiveInteger(
      settings.free_project_archive_after_days,
      30,
    ),
    bannedAfterDays: nonnegativeInteger(
      settings.banned_project_archive_after_days,
      7,
    ),
    batchLimit: Math.min(
      500,
      positiveInteger(settings.automatic_project_archiving_batch_limit, 25),
    ),
    globalPerHour: positiveInteger(
      settings.automatic_project_archiving_global_per_hour,
      10,
    ),
    perHostConcurrency: positiveInteger(
      settings.automatic_project_archiving_per_host_concurrency,
      1,
    ),
    canaryBays: stringList(settings.automatic_project_archiving_canary_bays),
    canaryHosts: stringList(settings.automatic_project_archiving_canary_hosts),
  };
}

const SNAPSHOT_SELECT = `
  SELECT p.project_id,
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
         p.archive_lifecycle_job_id,
         EXISTS (
           SELECT 1
             FROM public_project_paths share
            WHERE share.project_id = p.project_id
              AND share.disabled IS FALSE
              AND share.visibility <> 'disabled'
         ) AS active_published_path,
         COALESCE(
           p.last_edited,
           p.created,
           make_timestamp(1970, 1, 1, 0, 0, 0)
         )
           AS candidate_order_at
    FROM projects p
    LEFT JOIN project_hosts h ON h.id = p.host_id`;

export interface ProjectArchiveHostCoverage {
  /** False when automatic archiving is off, or covers every host (no
   * canary host list). */
  applies: boolean;
  /** Why the check doesn't apply, when it doesn't. */
  not_applicable?:
    | "archiving_disabled"
    | "bay_not_in_canary"
    | "no_canary_list";
  free_after_days: number;
  /** Shared pool hosts with projects on disk that the canary host list
   * leaves out: automatic archiving never runs there. */
  missing: Array<{
    host_id: string;
    name: string | null;
    status: string | null;
    on_disk: number;
    idle: number;
  }>;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A shared pool host (tier set) left out of a non-empty canary host list
// never archives its idle projects; personal and dedicated hosts (no tier)
// are left out on purpose and are not reported.
export async function getProjectArchiveHostCoverage(): Promise<ProjectArchiveHostCoverage> {
  const config = await loadProjectArchiveLifecycleConfig();
  // runProjectArchiveLifecycleOnce selects nothing on a bay a bay canary
  // list leaves out, so host coverage doesn't apply there either.
  const bayExcluded =
    config.canaryBays.length > 0 &&
    !config.canaryBays.includes(getConfiguredBayId());
  const notApplicable = !config.enabled
    ? ("archiving_disabled" as const)
    : bayExcluded
      ? ("bay_not_in_canary" as const)
      : config.canaryHosts.length === 0
        ? ("no_canary_list" as const)
        : undefined;
  const coverage: ProjectArchiveHostCoverage = {
    applies: notApplicable == null,
    ...(notApplicable ? { not_applicable: notApplicable } : {}),
    free_after_days: config.freeAfterDays,
    missing: [],
  };
  if (!coverage.applies) return coverage;
  // Exactly as the policy matches them (evaluateProjectArchiveEligibility):
  // an id listed in another case is left out there too, so it is reported.
  const listed = config.canaryHosts.filter((id) => UUID_PATTERN.test(id));
  const { rows } = await getPool().query<{
    host_id: string;
    name: string | null;
    status: string | null;
    on_disk: string;
    idle: string;
  }>(
    `SELECT h.id::text AS host_id, h.name, h.status,
            COUNT(*)::text AS on_disk,
            COUNT(*) FILTER (
              WHERE COALESCE(p.last_edited, p.created) <=
                    NOW() - make_interval(days => $3::int)
            )::text AS idle
       FROM project_hosts h
       JOIN projects p ON p.host_id = h.id
      WHERE h.deleted IS NULL
        AND h.tier IS NOT NULL
        AND COALESCE(h.status, '') <> 'deprovisioned'
        AND COALESCE(NULLIF(BTRIM(h.bay_id), ''), $1) = $1
        AND NOT (h.id::text = ANY($2::text[]))
        AND p.deleted IS NULL
        AND p.provisioned IS TRUE
        AND COALESCE(p.owning_bay_id, $1) = $1
        AND COALESCE(p.state ->> 'state', '') <> 'archived'
      GROUP BY h.id, h.name, h.status
      ORDER BY COUNT(*) DESC, h.id`,
    [getConfiguredBayId(), listed, config.freeAfterDays],
  );
  coverage.missing = rows.map((row) => ({
    host_id: row.host_id,
    name: row.name,
    status: row.status,
    on_disk: Number(row.on_disk) || 0,
    idle: Number(row.idle) || 0,
  }));
  return coverage;
}

export function projectArchiveHostCoverageHealth(
  coverage: ProjectArchiveHostCoverage,
): { level: "healthy" | "warning"; summary: string; details: string[] } {
  if (!coverage.applies) {
    return {
      level: "healthy",
      summary:
        coverage.not_applicable === "archiving_disabled"
          ? "Automatic archiving is disabled, so there is no host coverage to check."
          : coverage.not_applicable === "bay_not_in_canary"
            ? "This bay is not in automatic_project_archiving_canary_bays, so automatic archiving does not run here."
            : "Automatic archiving has no canary host list, so it covers every host.",
      details: [],
    };
  }
  if (!coverage.missing.length) {
    return {
      level: "healthy",
      summary:
        "Every shared host with projects on disk is in automatic_project_archiving_canary_hosts.",
      details: [],
    };
  }
  const count = coverage.missing.length;
  return {
    level: "warning",
    summary: `${count} shared host${count === 1 ? " is" : "s are"} missing from automatic_project_archiving_canary_hosts, so ${count === 1 ? "its" : "their"} idle projects are never archived automatically.`,
    details: coverage.missing.map(
      (host) =>
        `${host.name ?? host.host_id} (${host.host_id}, ${host.status ?? "unknown"}): ${host.on_disk} projects on disk, ${host.idle} idle over ${coverage.free_after_days} days`,
    ),
  };
}

async function listCandidateSnapshots({
  config,
}: {
  config: ProjectArchiveLifecycleConfig;
}): Promise<ArchiveLifecycleProjectSnapshot[]> {
  const bayId = getConfiguredBayId();
  const { rows } = await getPool().query<ArchiveLifecycleCandidateSnapshot>(
    `WITH banned_account_ids AS MATERIALIZED (
       SELECT account_id::text AS account_id
         FROM accounts
        WHERE banned IS TRUE
       UNION
       SELECT account_id::text AS account_id
         FROM cluster_account_directory
        WHERE banned IS TRUE
     ),
     candidate_ids AS MATERIALIZED (
       (
         SELECT p.project_id,
                COALESCE(
                  p.last_edited,
                  p.created,
                  make_timestamp(1970, 1, 1, 0, 0, 0)
                ) AS candidate_order_at
           FROM projects p
          WHERE p.deleted IS NULL
            AND p.provisioned IS TRUE
            AND COALESCE(p.deletion_protection, FALSE) IS FALSE
            AND p.state ->> 'state' = 'opened'
            AND COALESCE(p.owning_bay_id, $2) = $2
            AND COALESCE(
                  p.last_edited,
                  p.created,
                  make_timestamp(1970, 1, 1, 0, 0, 0)
                ) <= NOW() - make_interval(days => $3::int)
            AND (
              $4::timestamp IS NULL
              OR (
                COALESCE(
                  p.last_edited,
                  p.created,
                  make_timestamp(1970, 1, 1, 0, 0, 0)
                ),
                p.project_id
              ) > ($4::timestamp, $5::uuid)
            )
          ORDER BY candidate_order_at ASC, p.project_id ASC
          LIMIT $1
       )
       UNION
       (
         SELECT p.project_id,
                COALESCE(
                  p.last_edited,
                  p.created,
                  make_timestamp(1970, 1, 1, 0, 0, 0)
                ) AS candidate_order_at
           FROM projects p
          WHERE p.deleted IS NULL
            AND p.provisioned IS TRUE
            AND COALESCE(p.deletion_protection, FALSE) IS FALSE
            AND p.state ->> 'state' = 'opened'
            AND COALESCE(p.owning_bay_id, $2) = $2
            AND p.users ?| COALESCE(
                  (SELECT array_agg(account_id) FROM banned_account_ids),
                  ARRAY[]::text[]
                )
            AND (
              $4::timestamp IS NULL
              OR (
                COALESCE(
                  p.last_edited,
                  p.created,
                  make_timestamp(1970, 1, 1, 0, 0, 0)
                ),
                p.project_id
              ) > ($4::timestamp, $5::uuid)
            )
          ORDER BY candidate_order_at ASC, p.project_id ASC
          LIMIT $1
       )
     ),
     limited_candidates AS MATERIALIZED (
       SELECT project_id, candidate_order_at
         FROM candidate_ids
        ORDER BY candidate_order_at ASC, project_id ASC
        LIMIT $1
     )
     SELECT snapshot.*,
            snapshot.candidate_order_at::text AS candidate_cursor_at
       FROM (
         ${SNAPSHOT_SELECT}
         JOIN limited_candidates candidate
           ON candidate.project_id = p.project_id
       ) snapshot
      ORDER BY snapshot.candidate_order_at ASC, snapshot.project_id ASC`,
    [
      config.batchLimit,
      bayId,
      config.freeAfterDays,
      candidateCursor?.candidate_order_at ?? null,
      candidateCursor?.project_id ?? null,
    ],
  );
  const last = rows.at(-1);
  candidateCursor =
    rows.length >= config.batchLimit && last
      ? {
          // node-postgres parses timestamps as millisecond-precision Date
          // objects. Keep the database text value so pagination does not
          // revisit rows whose timestamp has nonzero microseconds.
          candidate_order_at: last.candidate_cursor_at,
          project_id: last.project_id,
        }
      : undefined;
  return rows;
}

async function loadSnapshot(
  project_id: string,
  client: PoolClient | ReturnType<typeof getPool> = getPool(),
  forUpdate = false,
): Promise<ArchiveLifecycleProjectSnapshot | undefined> {
  const bayId = getConfiguredBayId();
  const { rows } = await client.query<ArchiveLifecycleProjectSnapshot>(
    `${SNAPSHOT_SELECT}
     WHERE p.project_id = $1
     ${forUpdate ? "FOR UPDATE OF p" : ""}`,
    [project_id, bayId],
  );
  const project = rows[0];
  if (!project) return;
  const ownership = await resolveProjectBayDirect(project_id);
  if (ownership) {
    project.owning_bay_id = ownership.bay_id;
    project.ownership_epoch = ownership.epoch;
  } else {
    project.owning_bay_id = null;
  }
  return project;
}

async function evaluateSnapshot({
  project,
  config,
}: {
  project: ArchiveLifecycleProjectSnapshot;
  config: ProjectArchiveLifecycleConfig;
}): Promise<ProjectArchiveEligibilityDecision> {
  const collaboratorIds = archiveLifecycleCollaboratorIds(project.users);
  const accounts =
    await resolveArchiveLifecycleAccountStatuses(collaboratorIds);
  return evaluateProjectArchiveEligibility({
    project,
    accounts,
    config,
    currentBayId: getConfiguredBayId(),
  });
}

async function clearAutomaticClaim({
  project_id,
  job_id,
  reopen,
}: {
  project_id: string;
  job_id: string;
  reopen: boolean;
}): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE projects
        SET state = CASE
              WHEN $3::boolean AND state ->> 'state' = 'archiving'
                THEN jsonb_build_object('state', 'opened', 'time', NOW())
              ELSE state
            END,
            archive_lifecycle_job_id = NULL
      WHERE project_id = $1
        AND archive_lifecycle_job_id = $2
        AND state ->> 'state' <> 'archived'`,
      [project_id, job_id, reopen],
    );
    if ((result.rowCount ?? 0) > 0) {
      await appendProjectOutboxEventForProject({
        db: client,
        event_type: "project.state_changed",
        project_id,
        default_bay_id: getConfiguredBayId(),
      });
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  await publishProjectAccountFeedEventsBestEffort({
    project_id,
    default_bay_id: getConfiguredBayId(),
  });
}

async function claimAutomaticProject({
  job,
  config,
}: {
  job: ProjectArchiveLifecycleJob;
  config: ProjectArchiveLifecycleConfig;
}): Promise<ArchiveLifecycleProjectSnapshot | undefined> {
  const before = await loadSnapshot(job.project_id);
  if (!before) return;
  const decision = await evaluateSnapshot({ project: before, config });
  if (!decision.eligible || decision.reason !== job.reason) return;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await loadSnapshot(job.project_id, client, true);
    if (!current) {
      await client.query("ROLLBACK");
      return;
    }
    const collaboratorIds = archiveLifecycleCollaboratorIds(current.users);
    if (
      collaboratorIds.join(",") !== decision.collaborator_ids.join(",") ||
      current.host_id !== before.host_id ||
      current.ownership_epoch !== before.ownership_epoch
    ) {
      await client.query("ROLLBACK");
      return;
    }
    const claimed = await client.query(
      `UPDATE projects
          SET archive_lifecycle_job_id = $2
        WHERE project_id = $1
          AND state ->> 'state' = 'opened'
          AND provisioned IS TRUE
          AND deleted IS NULL
          AND COALESCE(deletion_protection, FALSE) IS FALSE`,
      [job.project_id, job.id],
    );
    if ((claimed.rowCount ?? 0) !== 1) {
      await client.query("ROLLBACK");
      return;
    }
    await client.query("COMMIT");
    return current;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function transitionClaimToArchiving({
  job,
  config,
}: {
  job: ProjectArchiveLifecycleJob;
  config: ProjectArchiveLifecycleConfig;
}): Promise<ArchiveLifecycleProjectSnapshot | undefined> {
  const latest = await loadSnapshot(job.project_id);
  if (!latest) return;
  const decision = await evaluateSnapshot({ project: latest, config });
  if (!decision.eligible || decision.reason !== job.reason) return;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Prevent a publish write from entering between the final publication
    // check and the project state transition.
    await client.query("LOCK TABLE public_project_paths IN SHARE MODE");
    const current = await loadSnapshot(job.project_id, client, true);
    if (!current) {
      await client.query("ROLLBACK");
      return;
    }
    const currentDecision = await evaluateSnapshot({
      project: current,
      config,
    });
    if (
      !currentDecision.eligible ||
      currentDecision.reason !== job.reason ||
      current.archive_lifecycle_job_id !== job.id ||
      current.state?.state !== "opened" ||
      current.host_id !== latest.host_id ||
      current.ownership_epoch !== latest.ownership_epoch ||
      archiveLifecycleCollaboratorIds(current.users).join(",") !==
        currentDecision.collaborator_ids.join(",")
    ) {
      await client.query("ROLLBACK");
      return;
    }
    const changed = await client.query(
      `UPDATE projects
          SET state = jsonb_build_object('state', 'archiving', 'time', NOW())
        WHERE project_id = $1
          AND archive_lifecycle_job_id = $2
          AND state ->> 'state' = 'opened'`,
      [job.project_id, job.id],
    );
    if ((changed.rowCount ?? 0) !== 1) {
      await client.query("ROLLBACK");
      return;
    }
    await appendProjectOutboxEventForProject({
      db: client,
      event_type: "project.state_changed",
      project_id: job.project_id,
      default_bay_id: getConfiguredBayId(),
    });
    await client.query("COMMIT");
    await publishProjectAccountFeedEventsBestEffort({
      project_id: job.project_id,
      default_bay_id: getConfiguredBayId(),
    });
    return { ...current, state: { state: "archiving" } };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// A final backup that has to leave out files over the backup file size limit
// fails the same way on every retry: the archive would delete their only
// copy. Such a job is terminal: the project is reopened when that is safe
// (canceled), and otherwise stays archiving for an admin reopen
// (reopenStuckProjectArchive) without hourly retries. Admin health lists both
// so support can contact the owner.
export const ARCHIVE_OVERSIZED_FILES_FAILURE = "oversized-files";
// A job reserved for (and then reopened by) reopenStuckProjectArchive.
export const ARCHIVE_ADMIN_REOPEN = "admin-reopen";
// A reservation older than this was left by an attempt that never finished
// (a lost bay process, a failed undo); a new admin attempt may take it over.
const ADMIN_REOPEN_RESERVATION_LEASE_MS = 15 * 60_000;

async function recordArchiveFailure(
  job: ProjectArchiveLifecycleJob,
  err: unknown,
): Promise<"failed"> {
  const cleanupCompleted =
    err instanceof ProjectArchiveStorageError && err.hostCleanupCompleted;
  const reopenSafe =
    !(err instanceof ProjectArchiveStorageError) || err.reopenSafe;
  const reopen = !cleanupCompleted && reopenSafe;
  if (reopen) {
    await clearAutomaticClaim({
      project_id: job.project_id,
      job_id: job.id,
      reopen: true,
    });
  }
  const oversized =
    !cleanupCompleted &&
    isOversizedFilesMessage(
      `${(err as { message?: unknown })?.message ?? ""} ${err}`,
    );
  if (oversized) {
    logger.warn("automatic archive stopped: files over the backup limit", {
      job_id: job.id,
      project_id: job.project_id,
      reopened: reopen,
    });
  }
  await updateProjectArchiveLifecycleJob({
    job_id: job.id,
    status: oversized && reopen ? "canceled" : "failed",
    failure_category: oversized
      ? ARCHIVE_OVERSIZED_FILES_FAILURE
      : cleanupCompleted
        ? "post-cleanup-finalization"
        : "archive-storage",
    error: err,
  });
  return "failed";
}

export interface ReopenStuckProjectArchiveResult {
  job_id: string;
  freeze_status: "already-writable" | "released";
}

async function assertNoResumableProjectRehome({
  db,
  project_id,
}: {
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
  project_id: string;
}): Promise<void> {
  const { rows: table } = await db.query(
    `SELECT to_regclass('project_rehome_operations') IS NOT NULL AS present`,
  );
  if (table[0]?.present !== true) return;
  const { rows } = await db.query(
    `SELECT op_id, status
       FROM project_rehome_operations
      WHERE project_id = $1
        AND status IN ('running', 'failed')
      ORDER BY created_at DESC
      LIMIT 1`,
    [project_id],
  );
  const op = rows[0];
  if (op) {
    throw new Error(
      `refusing to reopen: project rehome ${op.op_id} is ${op.status}; finish or resolve it first`,
    );
  }
}

export interface StuckArchiveJobReservation {
  job_id: string;
  host_id: string | null;
  project_host_id: string | null;
  previous_status: string;
  previous_failure_category: string | null;
  backup_generation: string | number | null;
}

/** Reserve the automatic archive job that holds a project in state
 * "archiving" for an admin reopen, with this attempt's token: one conditional
 * update, refused while the job runs, while another attempt's reservation is
 * live, and for a job whose reopen already finished. Both the job and the
 * project row are locked, so after waiting on a finishing attempt the update
 * rechecks the committed project state and reserves nothing. */
export async function reserveStuckArchiveJob({
  db,
  project_id,
  actor_account_id,
  token,
}: {
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
  project_id: string;
  actor_account_id: string;
  token: string;
}): Promise<StuckArchiveJobReservation[]> {
  const { rows } = await db.query(
    `WITH target AS (
       SELECT job.id, job.status, job.failure_category,
              p.host_id AS project_host_id
         FROM projects p
         JOIN project_archive_lifecycle_jobs job
           ON job.id = p.archive_lifecycle_job_id
        WHERE p.project_id = $1
          AND p.state ->> 'state' = 'archiving'
          AND COALESCE(p.owning_bay_id, $2) = $2
          AND job.reason <> 'manual'
        FOR UPDATE OF job, p
     )
     UPDATE project_archive_lifecycle_jobs job
        SET failure_category = $3,
            -- the reservation and the category it replaces; updated_at is
            -- left alone, so health keeps the job's own age
            evidence = COALESCE(job.evidence, '{}'::jsonb) || jsonb_build_object(
              'admin_reopen_reservation', jsonb_build_object(
                'at', NOW(),
                'token', $6::text,
                'actor_account_id', $4::text,
                'previous_failure_category',
                CASE WHEN COALESCE(job.failure_category, '') = $3
                  THEN job.evidence -> 'admin_reopen_reservation'
                       ->> 'previous_failure_category'
                  ELSE job.failure_category END
              )
            )
       FROM target
      WHERE job.id = target.id
        -- the job's current values, not the snapshot's
        AND job.status <> 'running'
        AND NOT (COALESCE(job.evidence, '{}'::jsonb) ? 'admin_reopen')
        AND (
          COALESCE(job.failure_category, '') <> $3
          -- a reservation left by a lost attempt expires
          OR (job.evidence -> 'admin_reopen_reservation' ->> 'at')::timestamptz
             < NOW() - make_interval(secs => $5::int)
        )
      RETURNING job.id AS job_id, job.host_id, target.project_host_id,
                target.status AS previous_status,
                job.evidence -> 'admin_reopen_reservation'
                  ->> 'previous_failure_category' AS previous_failure_category,
                job.backup_generation`,
    [
      project_id,
      getConfiguredBayId(),
      ARCHIVE_ADMIN_REOPEN,
      actor_account_id,
      Math.floor(ADMIN_REOPEN_RESERVATION_LEASE_MS / 1000),
      token,
    ],
  );
  return rows;
}

/** An admin's reopen of a project left in state "archiving" by an automatic
 * archive job that cannot finish (such as one stopped by files over the
 * backup file size limit). Refuses unless the job is not running, no backup
 * of the project is running, and the host confirms the volume is writable or
 * releases the freeze at the job's own backup generation; then reopens the
 * project as the job runner would and records who and why on the job. */
export async function reopenStuckProjectArchive({
  project_id,
  actor_account_id,
  reason,
  releaseArchiveFreeze = releaseProjectDataArchiveFreezeOnHost,
}: {
  project_id: string;
  actor_account_id: string;
  reason: string;
  releaseArchiveFreeze?: typeof releaseProjectDataArchiveFreezeOnHost;
}): Promise<ReopenStuckProjectArchiveResult> {
  const why = `${reason ?? ""}`.trim();
  if (!why) throw new Error("a reason is required to reopen a stuck archive");
  await ensureProjectArchiveLifecycleSchema();
  const bayId = getConfiguredBayId();
  // The fence, the reservation, the host release and the reopen all happen in
  // one transaction, as archiving holds the fence and the project row across
  // its host cleanup: no rehome can start between reserving and reopening,
  // and a refusal at any step rolls the reservation back with the rest.
  const token = randomUUID();
  let job: StuckArchiveJobReservation | undefined;
  let freeze_status: "already-writable" | "released";
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Serialized with project rehome, as archiving is: a rehome running now
    // refuses this reopen instead of racing its ownership flip.
    await assertProjectNotRehoming({
      db: client,
      project_id,
      action: "reopen a stuck archive",
    });
    // assertProjectNotRehoming refuses a running rehome. A failed one can be
    // retried (startProjectRehomeAttempt) without the fence and resume from
    // its snapshot of the still-archiving project, so refuse that too; a new
    // rehome takes the fence held here and starts after this commit.
    await assertNoResumableProjectRehome({ db: client, project_id });
    // Reserve the job: one conditional update, refused while it runs; it
    // locks the job and project rows until this transaction ends.
    [job] = await reserveStuckArchiveJob({
      db: client,
      project_id,
      actor_account_id,
      token,
    });
    if (!job) {
      throw new Error(
        "refusing to reopen: the project is not in state archiving under an automatic archive job on this bay, or that job is running or already being reopened",
      );
    }
    // The fence stays held across the host call below, as in archiving, so
    // no rehome can start and copy the still-archiving project meanwhile.
    const { rows: active } = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM long_running_operations
        WHERE kind = 'project-backup'
          AND scope_id::text = $1
          AND (
            (status IN ('queued', 'running') AND dismissed_at IS NULL)
            -- a freeze-capable backup that isn't proven harmless: still
            -- queued or running even if dismissed, marked uncertain because
            -- its worker lost track of it, or started and then canceled,
            -- expired or failed without a durable not-started or released
            -- recovery (isArchiveBackupFailureReopenSafe). Its host request
            -- may still freeze the volume after this reopen, at any later
            -- time; only a checked release or host attestation (#1419)
            -- clears it.
            OR (input ->> 'freeze_source' = 'true'
                AND status <> 'succeeded'
                AND (status IN ('queued', 'running')
                     OR result ->> 'archive_freeze_recovery' = 'uncertain'
                     OR (started_at IS NOT NULL
                         AND COALESCE(result ->> 'archive_freeze_recovery', '')
                             NOT IN ('not-started', 'released'))))
          )`,
      [project_id],
    );
    if (Number(active[0]?.count ?? 0) > 0) {
      throw new Error(
        "a backup of this project is running, or one that could still freeze it has no proven-safe outcome (uncertain, or canceled or failed after it started); try again after it is resolved",
      );
    }
    const host_id = job.host_id ?? job.project_host_id;
    if (!host_id) throw new Error("the archive job has no project host");
    // A frozen volume is only released at the generation this job's final
    // backup froze; any other freeze makes the host refuse, and so do we.
    const generation = Number(job.backup_generation ?? 0);
    const released = await releaseArchiveFreeze({
      project_id,
      host_id,
      expected_generation:
        Number.isSafeInteger(generation) && generation > 0 ? generation : -1,
    });
    if (
      released.status !== "already-writable" &&
      released.status !== "released"
    ) {
      throw new Error(
        `refusing to reopen: the project volume is ${released.status} on its host`,
      );
    }
    freeze_status = released.status;
    const finalized = await client.query(
      `UPDATE project_archive_lifecycle_jobs
          SET status = 'canceled',
              completed_at = NOW(),
              next_attempt_at = NULL,
              actor_account_id = $2::uuid,
              evidence = (COALESCE(evidence, '{}'::jsonb) - 'admin_reopen_reservation') || jsonb_build_object(
                'admin_reopen', jsonb_build_object(
                  'actor_account_id', $2::uuid::text,
                  'reason', $3::text,
                  'freeze_status', $4::text,
                  'previous_status', $5::text,
                  'previous_failure_category', $6::text,
                  'at', NOW()
                )
              ),
              updated_at = NOW()
        WHERE id = $1
          AND failure_category = $7
          AND evidence -> 'admin_reopen_reservation' ->> 'token' = $8`,
      [
        job.job_id,
        actor_account_id,
        why.slice(0, 1000),
        freeze_status,
        job.previous_status,
        job.previous_failure_category,
        ARCHIVE_ADMIN_REOPEN,
        token,
      ],
    );
    if ((finalized.rowCount ?? 0) !== 1) {
      throw new Error(
        "refusing to reopen: this attempt's reservation expired and was taken over",
      );
    }
    const reopened = await client.query(
      `UPDATE projects
          SET state = jsonb_build_object('state', 'opened', 'time', NOW()),
              archive_lifecycle_job_id = NULL
        WHERE project_id = $1
          AND archive_lifecycle_job_id = $2
          AND state ->> 'state' = 'archiving'
          -- still owned here: never reopen on a bay that lost ownership
          AND COALESCE(owning_bay_id, $3) = $3`,
      [project_id, job.job_id, bayId],
    );
    if ((reopened.rowCount ?? 0) !== 1) {
      throw new Error("refusing to reopen: the project changed meanwhile");
    }
    await appendProjectOutboxEventForProject({
      db: client,
      event_type: "project.state_changed",
      project_id,
      default_bay_id: bayId,
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  await publishProjectAccountFeedEventsBestEffort({
    project_id,
    default_bay_id: bayId,
  });
  const job_id = job!.job_id;
  logger.warn("admin reopened a stuck automatic archive", {
    project_id,
    job_id,
    actor_account_id,
    freeze_status,
  });
  return { job_id, freeze_status };
}

export interface ProjectArchiveBlockedSummary {
  /** Stopped by files over the backup limit and still in state archiving:
   * an admin reopen is needed. */
  stuck: Array<{ project_id: string; host_id: string | null; since: string }>;
  /** All stuck projects; `stuck` lists the oldest of them. */
  stuck_total: number;
  /** Stopped by files over the backup limit and reopened automatically in
   * the last 30 days: support may contact the owner. */
  reopened: number;
}

export async function getProjectArchiveBlockedSummary(): Promise<ProjectArchiveBlockedSummary> {
  await ensureProjectArchiveLifecycleSchema();
  const bayId = getConfiguredBayId();
  // Stuck projects on their own, so no number of past reopens can crowd them
  // out of the (capped) list; the total is counted without the cap.
  const { rows: stuck } = await getPool().query<{
    project_id: string;
    host_id: string | null;
    since: Date;
    total: string;
  }>(
    `SELECT job.project_id::text AS project_id, job.host_id::text AS host_id,
            job.updated_at AS since, COUNT(*) OVER ()::text AS total
       FROM project_archive_lifecycle_jobs job
       JOIN projects p ON p.project_id = job.project_id
      WHERE (
          job.failure_category = $1
          -- reserved for an admin reopen that hasn't finished: still stuck
          OR (job.failure_category = $3
              AND job.evidence -> 'admin_reopen_reservation'
                  ->> 'previous_failure_category' = $1)
        )
        AND COALESCE(p.owning_bay_id, $2) = $2
        AND p.state ->> 'state' = 'archiving'
        AND p.archive_lifecycle_job_id = job.id
      ORDER BY job.updated_at ASC
      LIMIT 200`,
    [ARCHIVE_OVERSIZED_FILES_FAILURE, bayId, ARCHIVE_ADMIN_REOPEN],
  );
  // Reopened by recordArchiveFailure in the last 30 days (an admin reopen
  // changes the category to admin-reopen).
  const { rows: reopened } = await getPool().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM project_archive_lifecycle_jobs job
       JOIN projects p ON p.project_id = job.project_id
      WHERE job.failure_category = $1
        AND job.status = 'canceled'
        AND job.updated_at >= NOW() - INTERVAL '30 days'
        AND COALESCE(p.owning_bay_id, $2) = $2`,
    [ARCHIVE_OVERSIZED_FILES_FAILURE, bayId],
  );
  return {
    stuck: stuck.map((row) => ({
      project_id: row.project_id,
      host_id: row.host_id,
      since: new Date(row.since).toISOString(),
    })),
    stuck_total: Number(stuck[0]?.total ?? 0) || 0,
    reopened: Number(reopened[0]?.count ?? 0) || 0,
  };
}

export function projectArchiveBlockedHealth(
  summary: ProjectArchiveBlockedSummary,
): { level: "healthy" | "warning"; summary: string; details: string[] } {
  if (!summary.stuck_total && !summary.reopened) {
    return {
      level: "healthy",
      summary:
        "No automatic archive is stopped by files over the backup limit.",
      details: [],
    };
  }
  return {
    level: summary.stuck_total ? "warning" : "healthy",
    summary: `${summary.stuck_total} project${summary.stuck_total === 1 ? " is" : "s are"} stuck archiving because of files over the backup file size limit (an admin reopen is needed); ${summary.reopened} reopened automatically in the last 30 days (support may contact the owner).`,
    details: summary.stuck.map(
      ({ project_id, host_id, since }) =>
        `Project ${project_id} on ${host_id ?? "unknown host"}: archiving, stopped since ${since}`,
    ),
  };
}

async function executeJob({
  job,
  config,
}: {
  job: ProjectArchiveLifecycleJob;
  config: ProjectArchiveLifecycleConfig;
}): Promise<JobResult> {
  const existing = await loadSnapshot(job.project_id);
  if (
    existing?.state?.state === "archiving" &&
    existing.archive_lifecycle_job_id === job.id
  ) {
    if (!job.host_id) {
      await updateProjectArchiveLifecycleJob({
        job_id: job.id,
        status: "failed",
        failure_category: "archive-recovery-missing-host",
        error: "claimed automatic archive job has no recorded project host",
      });
      return "failed";
    }
    if (!(await claimRetainedProjectArchiveLifecycleJob(job.id))) {
      return "stale";
    }
    try {
      await archiveProjectStorage({
        final_backup_wait_ms: finalBackupWaitMs(),
        project_id: job.project_id,
        mode: "automatic",
        job_id: job.id,
        reason: job.reason,
        expected_host_id: job.host_id,
      });
      return "completed";
    } catch (err) {
      if (err instanceof FinalArchiveBackupPendingError) return "pending";
      return await recordArchiveFailure(job, err);
    }
  }

  const thresholds = job.thresholds ?? {};
  const jobPolicyMatches =
    Number(thresholds.free_after_days) === config.freeAfterDays &&
    Number(thresholds.banned_after_days) === config.bannedAfterDays &&
    JSON.stringify(thresholds.canary_bays ?? []) ===
      JSON.stringify(config.canaryBays) &&
    JSON.stringify(thresholds.canary_hosts ?? []) ===
      JSON.stringify(config.canaryHosts);
  if (
    job.policy_version !== PROJECT_ARCHIVE_POLICY_VERSION ||
    !jobPolicyMatches
  ) {
    await updateProjectArchiveLifecycleJob({ job_id: job.id, status: "stale" });
    return "stale";
  }
  if (!job.host_id) {
    await updateProjectArchiveLifecycleJob({ job_id: job.id, status: "stale" });
    return "stale";
  }
  // One admission at a time, so concurrent workers can't all pass the hourly
  // limit on the same count before any of them claims (a claim is counted).
  const admitted = await withArchiveAdmission(async () => {
    const [recent, onHost] = await Promise.all([
      countRecentAutomaticArchives(),
      countRunningArchivesByHost(job.host_id!),
    ]);
    if (recent >= config.globalPerHour) return "rate-limited" as const;
    // Another archive is running on this host: try this job next pass, but
    // let jobs on other hosts go ahead.
    if (onHost >= config.perHostConcurrency) return "host-busy" as const;
    if (!(await claimProjectArchiveLifecycleJob(job.id))) {
      return "stale" as const;
    }
    return "claimed" as const;
  });
  if (admitted !== "claimed") return admitted;

  const claimed = await claimAutomaticProject({ job, config });
  if (!claimed) {
    await updateProjectArchiveLifecycleJob({ job_id: job.id, status: "stale" });
    await clearAutomaticClaim({
      project_id: job.project_id,
      job_id: job.id,
      reopen: false,
    });
    return "stale";
  }
  // Leave an event-loop turn in which a concurrent project start can change
  // the canonical state and win before the destructive transition.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const archiving = await transitionClaimToArchiving({ job, config });
  if (!archiving) {
    await clearAutomaticClaim({
      project_id: job.project_id,
      job_id: job.id,
      reopen: false,
    });
    await updateProjectArchiveLifecycleJob({ job_id: job.id, status: "stale" });
    return "stale";
  }

  // Re-resolve remote authority after the visible state transition and before
  // touching host storage. This cannot create a distributed transaction, but
  // it closes the meaningful selected/queued/claimed race windows.
  const finalSnapshot = await loadSnapshot(job.project_id);
  const finalDecision = finalSnapshot
    ? await evaluateSnapshot({
        project: { ...finalSnapshot, state: { state: "opened" } },
        config,
      })
    : undefined;
  if (!finalDecision?.eligible || finalDecision.reason !== job.reason) {
    await clearAutomaticClaim({
      project_id: job.project_id,
      job_id: job.id,
      reopen: true,
    });
    await updateProjectArchiveLifecycleJob({ job_id: job.id, status: "stale" });
    return "stale";
  }

  try {
    await archiveProjectStorage({
      final_backup_wait_ms: finalBackupWaitMs(),
      project_id: job.project_id,
      mode: "automatic",
      job_id: job.id,
      reason: job.reason,
      expected_host_id: job.host_id,
    });
    return "completed";
  } catch (err) {
    if (err instanceof FinalArchiveBackupPendingError) return "pending";
    return await recordArchiveFailure(job, err);
  }
}

function emptySummary(
  config: ProjectArchiveLifecycleConfig,
): ProjectArchiveLifecycleRunSummary {
  return {
    checked_at: new Date().toISOString(),
    enabled: config.enabled,
    report_only: config.reportOnly,
    selected: 0,
    eligible: 0,
    recorded: 0,
    completed: 0,
    stale: 0,
    failed: 0,
    rate_limited: 0,
    pending: 0,
    exclusions: {},
    job_ids: [],
  };
}

let archiveAdmission: Promise<unknown> = Promise.resolve();

// Serializes the hourly-limit check with the claim it admits. The lifecycle
// worker runs in one process at a time (advisory lock), so this suffices.
async function withArchiveAdmission<T>(fn: () => Promise<T>): Promise<T> {
  const run = archiveAdmission.then(fn, fn);
  archiveAdmission = run.catch(() => undefined);
  return await run;
}

type JobResult =
  | "completed"
  | "stale"
  | "failed"
  | "rate-limited"
  | "host-busy"
  | "pending";

function envMs(name: string, fallback: number, min = 0): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > min ? value : fallback;
}

// How long one job waits for its final backup before it is queued to resume
// waiting next pass (archive.ts FinalArchiveBackupPendingError). Below the
// 10 minute threshold at which a running job counts as stale.
export function finalBackupWaitMs(): number {
  return envMs("COCALC_PROJECT_ARCHIVE_FINAL_BACKUP_WAIT_MS", 8 * 60_000, 1000);
}

// Archive jobs run at once across hosts, still one per host.
export function archiveJobConcurrency(): number {
  return Math.floor(envMs("COCALC_PROJECT_ARCHIVE_CONCURRENCY", 4, 0.5));
}

// A pass starts no new job after this long, so candidate selection (which
// starts each pass) keeps running while one host has a long backlog.
export function archivePassBudgetMs(): number {
  return envMs("COCALC_PROJECT_ARCHIVE_PASS_BUDGET_MS", 15 * 60_000, 1000);
}

// Run jobs in order, up to archiveJobConcurrency() at once and one per host,
// so one slow final backup never stalls the fleet. A job whose host already
// has one running in this pass waits for it; the global hourly limit stops
// starting new jobs.
async function runArchiveJobs({
  jobs,
  config,
  summary,
  startedAt,
}: {
  jobs: ProjectArchiveLifecycleJob[];
  config: ProjectArchiveLifecycleConfig;
  summary: ProjectArchiveLifecycleRunSummary;
  startedAt: number;
}): Promise<void> {
  const remaining = [...jobs];
  const hostsInFlight = new Set<string>();
  let stopped = false;
  const next = (): ProjectArchiveLifecycleJob | undefined => {
    const index = remaining.findIndex(
      ({ host_id }) => !host_id || !hostsInFlight.has(host_id),
    );
    return index < 0 ? undefined : remaining.splice(index, 1)[0];
  };
  const worker = async () => {
    while (!stopped && Date.now() - startedAt < archivePassBudgetMs()) {
      const job = next();
      if (!job) return;
      if (job.host_id) hostsInFlight.add(job.host_id);
      let result: JobResult;
      try {
        result = await executeJob({ job, config });
      } catch (err) {
        logger.warn("automatic archive job failed unexpectedly", {
          job_id: job.id,
          err: `${err}`,
        });
        result = "failed";
      }
      // A pending job's final backup is still running on its host: the host
      // stays busy for the rest of this pass (and countRunningArchivesByHost
      // counts it for later passes).
      if (job.host_id && result !== "pending") {
        hostsInFlight.delete(job.host_id);
      }
      if (result === "rate-limited" || result === "host-busy") {
        summary.rate_limited += 1;
        if (result === "rate-limited") stopped = true;
      } else {
        summary[result] += 1;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, archiveJobConcurrency()) }, worker),
  );
}

export async function runProjectArchiveLifecycleOnce(): Promise<ProjectArchiveLifecycleRunSummary> {
  await ensureProjectArchiveLifecycleSchema();
  const config = await loadProjectArchiveLifecycleConfig();
  const summary = emptySummary(config);
  const startedAt = Date.now();
  const recoverable = await listRecoverableProjectArchiveLifecycleJobs(
    config.batchLimit,
  );
  await runArchiveJobs({ jobs: recoverable, config, summary, startedAt });
  if (!config.enabled) return summary;
  if (
    config.canaryBays.length > 0 &&
    !config.canaryBays.includes(getConfiguredBayId())
  ) {
    return summary;
  }

  const projects = await listCandidateSnapshots({ config });
  summary.selected = projects.length;
  const collaboratorIds = projects.flatMap((project) =>
    archiveLifecycleCollaboratorIds(project.users),
  );
  const accounts =
    await resolveArchiveLifecycleAccountStatuses(collaboratorIds);
  for (const project of projects) {
    const decision = evaluateProjectArchiveEligibility({
      project,
      accounts,
      config,
      currentBayId: getConfiguredBayId(),
    });
    if (!decision.eligible) {
      summary.exclusions[decision.exclusion] =
        (summary.exclusions[decision.exclusion] ?? 0) + 1;
      continue;
    }
    summary.eligible += 1;
    const job = await createProjectArchiveLifecycleJob({
      project,
      reason: decision.reason,
      reportOnly: config.reportOnly,
      config,
      decision,
    });
    if (job) {
      summary.recorded += 1;
      summary.job_ids.push(job.id);
    }
  }

  if (config.reportOnly) return summary;
  const queued = await listQueuedProjectArchiveLifecycleJobs(config.batchLimit);
  const recoveredIds = new Set(recoverable.map(({ id }) => id));
  await runArchiveJobs({
    jobs: queued.filter(({ id }) => !recoveredIds.has(id)),
    config,
    summary,
    startedAt,
  });
  return summary;
}

async function runWithStatus(): Promise<ProjectArchiveLifecycleRunSummary> {
  if (status.running) {
    return (
      status.last_result ??
      emptySummary(await loadProjectArchiveLifecycleConfig())
    );
  }
  status.running = true;
  status.last_started_at = new Date().toISOString();
  try {
    const result = await runProjectArchiveLifecycleOnce();
    status.last_result = result;
    status.last_error = null;
    return result;
  } catch (err) {
    status.last_error = `${err}`;
    throw err;
  } finally {
    status.running = false;
    status.last_completed_at = new Date().toISOString();
  }
}

export async function runProjectArchiveLifecycleMaintenance(): Promise<
  ProjectArchiveLifecycleRunSummary | undefined
> {
  return await withSessionAdvisoryLock({
    lockKey: LOCK_KEY,
    fn: runWithStatus,
  });
}

export function getProjectArchiveLifecycleMaintenanceStatus(): ProjectArchiveLifecycleMaintenanceStatus {
  return structuredClone(status);
}

export async function getProjectArchiveLifecycleOperationalStatus(): Promise<
  ProjectArchiveLifecycleMaintenanceStatus & {
    queue: {
      oldest_queued_age_ms: number | null;
      cleanup_debt: number;
      by_reason_status: Array<{
        reason: string;
        status: string;
        count: number;
      }>;
    };
  }
> {
  try {
    await ensureProjectArchiveLifecycleSchema();
    const [groups, queue] = await Promise.all([
      getPool().query<{ reason: string; status: string; count: string }>(
        `SELECT reason, status, COUNT(*)::text AS count
           FROM project_archive_lifecycle_jobs
          WHERE created_at >= NOW() - INTERVAL '30 days'
          GROUP BY reason, status
          ORDER BY reason, status`,
      ),
      getPool().query<{
        oldest_queued_age_ms: string | null;
        cleanup_debt: string;
      }>(
        `SELECT
           EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) * 1000 AS oldest_queued_age_ms,
           COUNT(*) FILTER (
             WHERE status = 'failed'
               AND failure_category = 'post-cleanup-finalization'
           )::text AS cleanup_debt
         FROM project_archive_lifecycle_jobs
         WHERE status IN ('queued', 'running', 'failed')`,
      ),
    ]);
    const queueRow = queue.rows[0];
    return {
      ...getProjectArchiveLifecycleMaintenanceStatus(),
      queue: {
        oldest_queued_age_ms:
          queueRow?.oldest_queued_age_ms == null
            ? null
            : Math.max(0, Number(queueRow.oldest_queued_age_ms) || 0),
        cleanup_debt: Math.max(0, Number(queueRow?.cleanup_debt ?? 0) || 0),
        by_reason_status: groups.rows.map((row) => ({
          reason: row.reason,
          status: row.status,
          count: Math.max(0, Number(row.count) || 0),
        })),
      },
    };
  } catch (err) {
    const current = getProjectArchiveLifecycleMaintenanceStatus();
    return {
      ...current,
      last_error: current.last_error ?? `loading lifecycle metrics: ${err}`,
      queue: {
        oldest_queued_age_ms: null,
        cleanup_debt: 0,
        by_reason_status: [],
      },
    };
  }
}

export function startProjectArchiveLifecycleMaintenance(): void {
  if (status.started) return;
  status.started = true;
  const run = async () => {
    try {
      const result = await runProjectArchiveLifecycleMaintenance();
      if (result && (result.recorded > 0 || result.failed > 0)) {
        logger.info("project archive lifecycle tick completed", result);
      }
    } catch (err) {
      logger.error("project archive lifecycle tick failed", err);
    }
  };
  void run();
  const timer = setInterval(() => void run(), CHECK_INTERVAL_MS);
  timer.unref?.();
}

export const __test__ = {
  booleanSetting,
  listCandidateSnapshots,
  nonnegativeInteger,
  positiveInteger,
  resetCandidateCursor: () => {
    candidateCursor = undefined;
  },
  stringList,
};
