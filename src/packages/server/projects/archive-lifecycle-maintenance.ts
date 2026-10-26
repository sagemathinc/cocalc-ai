/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool, {
  type PoolClient,
  withSessionAdvisoryLock,
} from "@cocalc/database/pool";
import { appendProjectOutboxEventForProject } from "@cocalc/database/postgres/project-events-outbox";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { publishProjectAccountFeedEventsBestEffort } from "@cocalc/server/account/project-feed";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveProjectBayDirect } from "@cocalc/server/inter-bay/directory";
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
      const cleanupCompleted =
        err instanceof ProjectArchiveStorageError && err.hostCleanupCompleted;
      const reopenSafe =
        !(err instanceof ProjectArchiveStorageError) || err.reopenSafe;
      if (!cleanupCompleted && reopenSafe) {
        await clearAutomaticClaim({
          project_id: job.project_id,
          job_id: job.id,
          reopen: true,
        });
      }
      await updateProjectArchiveLifecycleJob({
        job_id: job.id,
        status: "failed",
        failure_category: cleanupCompleted
          ? "post-cleanup-finalization"
          : "archive-storage",
        error: err,
      });
      return "failed";
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
    const cleanupCompleted =
      err instanceof ProjectArchiveStorageError && err.hostCleanupCompleted;
    const reopenSafe =
      !(err instanceof ProjectArchiveStorageError) || err.reopenSafe;
    if (!cleanupCompleted && reopenSafe) {
      await clearAutomaticClaim({
        project_id: job.project_id,
        job_id: job.id,
        reopen: true,
      });
    }
    await updateProjectArchiveLifecycleJob({
      job_id: job.id,
      status: "failed",
      failure_category: cleanupCompleted
        ? "post-cleanup-finalization"
        : "archive-storage",
      error: err,
    });
    return "failed";
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
