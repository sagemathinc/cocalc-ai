import { randomUUID } from "node:crypto";
import { delay } from "awaiting";
import getLogger from "@cocalc/backend/logger";
import { conat } from "@cocalc/backend/conat";
import getPool from "@cocalc/database/pool";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import type { HostBackupAllResult } from "@cocalc/conat/hub/api/hosts";
import {
  claimLroOps,
  createLro,
  getLro,
  touchLro,
  updateLro,
} from "@cocalc/server/lro/lro-db";
import { waitForDurableLroCompletion } from "@cocalc/server/lro/wait";
import { getEffectiveParallelOpsLimit } from "@cocalc/server/lro/worker-config";
import { publishLroEvent, publishLroSummary } from "@cocalc/server/lro/stream";
import {
  deleteHostInternal,
  drainHostInternal,
  forceDeprovisionHostInternal,
  isProjectHostLocalRollbackError,
  rollbackHostRuntimeDeploymentsInternal,
  rollbackProjectHostOverSshInternal,
  reconcileHostRuntimeDeploymentsInternal,
  reconcileHostSoftwareInternal,
  removeSelfHostConnectorInternal,
  restartHostInternal,
  rolloutComponentsForUpgradeResults,
  rolloutHostManagedComponentsInternal,
  startHostInternal,
  stopHostInternal,
  upgradeHostSoftwareInternal,
} from "@cocalc/server/conat/api/hosts";
import {
  startProjectOnHost,
  stopProjectOnHost,
} from "@cocalc/server/project-host/control";
import { DEDICATED_HOST_BILLING_DISK_GRACE_HOURS } from "@cocalc/server/project-host/spend-enforcement";
import { getProject } from "@cocalc/server/projects/control/base";
import { loadProjectRuntimeSponsor } from "@cocalc/server/projects/runtime-sponsor-db";
import {
  heartbeatProjectRuntimeSlot,
  releaseProjectRuntimeSlot,
  reserveProjectRuntimeSlot,
} from "@cocalc/server/projects/runtime-slots";
import { stopSelfHostReverseTunnel } from "@cocalc/server/self-host/ssh-target";

const logger = getLogger("server:hosts:ops-worker");

const OWNER_TYPE = "hub" as const;
const LEASE_MS = 120_000;
const HEARTBEAT_MS = 15_000;
const TICK_MS = 5_000;
const DEFAULT_MAX_PARALLEL = 2;
const MAX_WAIT_MS = 2 * 60 * 60 * 1000;
const POLL_MS = 5_000;
const BACKUP_PARALLEL = 6;
const BACKUP_WAIT_MS = 6 * 60 * 60 * 1000;
const BACKUP_PROGRESS_MAX = 60;
const BACKUP_LRO_KIND = "project-backup";
const PROJECT_HOST_UPGRADE_CONVERGENCE_TIMEOUT_MS = 60_000;
const PROJECT_HOST_UPGRADE_CONVERGENCE_POLL_MS = 5_000;
const HOST_PROJECTS_RUNTIME_SLOT_TTL_MS = 30 * 60 * 1000;

const HOST_OP_KINDS = [
  "host-start",
  "host-stop",
  "host-restart",
  "host-drain",
  "host-backup-all",
  "host-stop-projects",
  "host-restart-projects",
  "host-reconcile-software",
  "host-reconcile-runtime-deployments",
  "host-rollback-runtime-deployments",
  "host-upgrade-software",
  "host-rollout-managed-components",
  "host-deprovision",
  "host-delete",
  "host-force-deprovision",
  "host-remove-connector",
] as const;

type HostOpKind = (typeof HOST_OP_KINDS)[number];

const WORKER_ID = randomUUID();

const progressSteps: Record<string, number> = {
  backups: 20,
  requesting: 35,
  draining: 60,
  waiting: 75,
  done: 100,
  canceled: 100,
};

type HostProjectRow = {
  project_id: string;
  last_edited: Date | null;
  last_changed: Date | null;
  last_backup: Date | null;
  state: { state?: string } | null;
  provisioned?: boolean | null;
};

type BackupCandidate = {
  project_id: string;
  reason: "running" | "dirty";
};

type HostBackupProjectRow = {
  project_id?: string;
  state?: string;
  provisioned?: boolean | null;
  last_edited?: Date | string | null;
  last_changed?: Date | string | null;
  last_backup?: Date | string | null;
  needs_backup?: boolean | null;
};

type HostProjectsActionResultRow = {
  project_id: string;
  status: "succeeded" | "failed" | "skipped";
  state?: string;
  error?: string;
};

class HostOpCanceledError extends Error {
  code = "host-op-canceled";

  constructor(message = "host op canceled") {
    super(message);
  }
}

let running = false;
let inFlight = 0;

function publishSummary(summary: LroSummary) {
  return publishLroSummary({
    scope_type: summary.scope_type,
    scope_id: summary.scope_id,
    summary,
  });
}

function resolveProgress(step: string, progress?: number): number | undefined {
  return progress ?? progressSteps[step];
}

function progressEvent({
  op,
  step,
  message,
  detail,
  progress,
}: {
  op: LroSummary;
  step: string;
  message: string;
  detail?: any;
  progress?: number;
}) {
  void publishLroEvent({
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    op_id: op.op_id,
    event: {
      type: "progress",
      ts: Date.now(),
      phase: step,
      message,
      progress: resolveProgress(step, progress),
      detail,
    },
  });
}

async function updateProgressSummary(
  op: LroSummary,
  update: {
    step: string;
    message: string;
    detail?: any;
    progress?: number;
  },
) {
  const progress = resolveProgress(update.step, update.progress);
  const updated = await updateLro({
    op_id: op.op_id,
    progress_summary: {
      phase: update.step,
      message: update.message,
      ...(progress != null ? { progress } : {}),
      ...(update.detail ?? {}),
    },
  });
  if (updated) {
    await publishSummary(updated);
  }
}

async function loadHostStatus(id: string) {
  const { rows } = await getPool().query(
    "SELECT id, status, metadata, deleted, last_seen FROM project_hosts WHERE id=$1",
    [id],
  );
  return rows[0];
}

function parseTimestampMs(value?: string): number | undefined {
  const text = `${value ?? ""}`.trim();
  if (!text) return undefined;
  const ms = new Date(text).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function currentBootstrapFailure({
  row,
  since,
}: {
  row: any;
  since?: number;
}): string | undefined {
  if (!since) return undefined;
  const metadata = row?.metadata ?? {};
  const bootstrap = metadata.bootstrap ?? {};
  const bootstrapStatus = `${bootstrap.status ?? ""}`.trim().toLowerCase();
  const bootstrapUpdatedMs = parseTimestampMs(bootstrap.updated_at);
  const bootstrapMessage = `${bootstrap.message ?? ""}`.trim() || undefined;
  if (
    bootstrapStatus === "error" &&
    (bootstrapUpdatedMs == null || bootstrapUpdatedMs >= since)
  ) {
    return bootstrapMessage ?? "host bootstrap failed";
  }
  const lifecycle = metadata.bootstrap_lifecycle ?? {};
  const lifecycleStatus = `${lifecycle.summary_status ?? ""}`
    .trim()
    .toLowerCase();
  const lifecycleStartedMs = parseTimestampMs(
    lifecycle.last_reconcile_started_at,
  );
  const lifecycleFinishedMs = parseTimestampMs(
    lifecycle.last_reconcile_finished_at,
  );
  if (
    lifecycleStatus === "error" &&
    [
      lifecycleStartedMs,
      lifecycleFinishedMs,
      bootstrapUpdatedMs,
      parseTimestampMs(metadata.last_action_at),
    ].some((value) => value != null && value >= since)
  ) {
    return (
      `${lifecycle.last_error ?? ""}`.trim() ||
      `${lifecycle.summary_message ?? ""}`.trim() ||
      bootstrapMessage ||
      "host bootstrap failed"
    );
  }
  return undefined;
}

function projectHostLastKnownGoodVersion(row: any): string | undefined {
  return (
    `${row?.metadata?.host_agent?.project_host?.last_known_good_version ?? row?.metadata?.observed_host_agent?.project_host?.last_known_good_version ?? ""}`.trim() ||
    undefined
  );
}

function completedProjectHostUpgradeVersion({
  row,
  targetVersion,
  previousVersion,
}: {
  row: any;
  targetVersion?: string;
  previousVersion?: string;
}): string | undefined {
  const target = `${targetVersion ?? ""}`.trim();
  const previous = `${previousVersion ?? ""}`.trim();
  const installedVersion =
    `${row?.metadata?.software?.project_host ?? row?.version ?? ""}`.trim() ||
    undefined;
  const lastKnownGoodVersion = projectHostLastKnownGoodVersion(row);
  if (!installedVersion || !lastKnownGoodVersion) {
    return undefined;
  }
  if (target) {
    return installedVersion === target && lastKnownGoodVersion === target
      ? target
      : undefined;
  }
  if (installedVersion !== lastKnownGoodVersion) {
    return undefined;
  }
  if (previous && installedVersion === previous) {
    return undefined;
  }
  return installedVersion;
}

async function waitForCompletedProjectHostUpgrade({
  host_id,
  targetVersion,
  previousVersion,
  timeoutMs = PROJECT_HOST_UPGRADE_CONVERGENCE_TIMEOUT_MS,
  pollMs = PROJECT_HOST_UPGRADE_CONVERGENCE_POLL_MS,
}: {
  host_id: string;
  targetVersion?: string;
  previousVersion?: string;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<string | undefined> {
  const target = `${targetVersion ?? ""}`.trim();
  const previous = `${previousVersion ?? ""}`.trim();
  if (!target && !previous) return undefined;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const row = await loadHostStatus(host_id);
    const converged = completedProjectHostUpgradeVersion({
      row,
      targetVersion: target,
      previousVersion: previous,
    });
    if (converged) {
      return converged;
    }
    await delay(pollMs);
  }
  const finalRow = await loadHostStatus(host_id);
  return completedProjectHostUpgradeVersion({
    row: finalRow,
    targetVersion: target,
    previousVersion: previous,
  });
}

async function waitForHostStatus({
  host_id,
  desired,
  failOn,
  allowDeleted,
  onUpdate,
  bootstrapFailureSince,
  shouldCancel,
  loadStatus = loadHostStatus,
  delayFn = delay,
  pollMs = POLL_MS,
}: {
  host_id: string;
  desired: string[];
  failOn?: string[];
  allowDeleted?: boolean;
  onUpdate: (status: string, metadata?: any) => Promise<void>;
  bootstrapFailureSince?: number;
  shouldCancel?: () => Promise<boolean>;
  loadStatus?: typeof loadHostStatus;
  delayFn?: (ms: number) => Promise<void>;
  pollMs?: number;
}) {
  const startedAt = Date.now();
  let lastStatus = "";
  while (Date.now() - startedAt < MAX_WAIT_MS) {
    if ((await shouldCancel?.()) === true) {
      throw new HostOpCanceledError();
    }
    const row = await loadStatus(host_id);
    if (!row) {
      throw new Error("host not found");
    }
    if (row.deleted) {
      if (allowDeleted) {
        return {
          status: "deleted",
          metadata: row.metadata ?? {},
          deleted: true,
        };
      }
      throw new Error("host deleted");
    }
    const status = String(row.status ?? "");
    if (status && status !== lastStatus) {
      lastStatus = status;
      await onUpdate(status, row.metadata ?? {});
    }
    if (desired.includes(status)) {
      return { status, metadata: row.metadata ?? {} };
    }
    const bootstrapFailure = currentBootstrapFailure({
      row,
      since: bootstrapFailureSince,
    });
    if (bootstrapFailure) {
      throw new Error(bootstrapFailure);
    }
    if (failOn && failOn.includes(status)) {
      const lastError = row.metadata?.last_error;
      throw new Error(
        lastError ? `host ${status}: ${lastError}` : `host ${status}`,
      );
    }
    await delayFn(pollMs);
  }
  throw new Error(`timeout waiting for host: ${desired.join(", ")}`);
}

async function waitForHostHeartbeat({
  host_id,
  since,
}: {
  host_id: string;
  since: number;
}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < MAX_WAIT_MS) {
    const row = await loadHostStatus(host_id);
    if (!row || row.deleted) {
      throw new Error("host not found");
    }
    const lastSeen = row.last_seen
      ? new Date(row.last_seen as any).getTime()
      : 0;
    if (lastSeen && lastSeen >= since) {
      return { last_seen: row.last_seen };
    }
    await delay(POLL_MS);
  }
  throw new Error("timeout waiting for host heartbeat");
}

async function loadHostProjects(host_id: string): Promise<HostProjectRow[]> {
  const { rows } = await getPool().query<HostProjectRow>(
    `
      SELECT
        project_id,
        last_edited,
        (to_jsonb(projects)->>'last_changed')::TIMESTAMP AS last_changed,
        last_backup,
        state,
        provisioned
      FROM projects
      WHERE host_id=$1
        AND deleted IS NOT true
    `,
    [host_id],
  );
  return rows;
}

async function loadProjectState(project_id: string): Promise<string> {
  const { rows } = await getPool().query<{ state: { state?: string } | null }>(
    "SELECT state FROM projects WHERE project_id=$1",
    [project_id],
  );
  const rawState = rows[0]?.state ?? null;
  if (rawState && typeof rawState === "object") {
    return `${rawState.state ?? ""}`.trim();
  }
  return "";
}

async function waitForProjectStopped(project_id: string): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < MAX_WAIT_MS) {
    const state = await loadProjectState(project_id);
    if (!isProjectRunning(state)) {
      return state || "stopped";
    }
    await delay(POLL_MS);
  }
  throw new Error(`timeout waiting for project ${project_id} to stop`);
}

async function releaseProjectRuntimeSlotAfterHostStop({
  host_id,
  project_id,
}: {
  host_id: string;
  project_id: string;
}) {
  const sponsor = await loadProjectRuntimeSponsor(project_id);
  const released = await releaseProjectRuntimeSlot({
    sponsor_account_id: sponsor.sponsor_account_id,
    project_id,
  });
  if (!released) {
    logger.warn("host project stop found no active runtime slot to release", {
      host_id,
      project_id,
      sponsor_account_id: sponsor.sponsor_account_id,
    });
  }
}

async function restartProjectWithRuntimeSlot({
  actor_account_id,
  host_id,
  project_id,
}: {
  actor_account_id?: string;
  host_id: string;
  project_id: string;
}) {
  const sponsor = await loadProjectRuntimeSponsor(project_id);
  let reserved = false;
  try {
    await reserveProjectRuntimeSlot({
      ...sponsor,
      project_id,
      actor_account_id,
      reason: "host-restart-projects",
      state: "starting",
      ttl_ms: HOST_PROJECTS_RUNTIME_SLOT_TTL_MS,
      metadata: { host_id, restarted_by: "host-restart-projects" },
    });
    reserved = true;
    await stopProjectOnHost(project_id);
    await waitForProjectStopped(project_id);
    await getProject(project_id).computeQuota();
    await startProjectOnHost(project_id, {
      ...(actor_account_id ? { account_id: actor_account_id } : {}),
    });
    await heartbeatProjectRuntimeSlot({
      sponsor_account_id: sponsor.sponsor_account_id,
      project_id,
      host_id: sponsor.host_id ?? host_id,
      state: "running",
      ttl_ms: HOST_PROJECTS_RUNTIME_SLOT_TTL_MS,
      metadata: { host_id, restarted_by: "host-restart-projects" },
    });
  } catch (err) {
    if (reserved) {
      await releaseProjectRuntimeSlot({
        sponsor_account_id: sponsor.sponsor_account_id,
        project_id,
        state: "failed",
      }).catch((releaseErr) => {
        logger.warn(
          "failed to release runtime slot after host project restart failure",
          {
            host_id,
            project_id,
            sponsor_account_id: sponsor.sponsor_account_id,
            err: `${releaseErr}`,
          },
        );
      });
    }
    throw err;
  }
}

async function runHostProjectsAction({
  action,
  host_id,
  input,
  shouldCancel,
  progressStep,
}: {
  action: "stop" | "restart";
  host_id: string;
  input: any;
  shouldCancel: () => Promise<boolean>;
  progressStep: (
    step: string,
    message: string,
    detail?: any,
    progress?: number,
  ) => Promise<void>;
}) {
  const requestedProjects = Array.isArray(input?.projects)
    ? input.projects
    : [];
  const total = requestedProjects.length;
  const parallel = Math.max(1, Math.min(32, Number(input?.parallel ?? 4) || 4));
  const actor_account_id = `${input?.account_id ?? ""}`.trim() || undefined;
  const results: HostProjectsActionResultRow[] = [];
  let completed = 0;
  let failed = 0;
  let skipped = 0;

  const updateProgress = async (message: string) => {
    const done = completed + failed + skipped;
    const progress = total ? Math.round((done / total) * 100) : 100;
    await progressStep(
      "projects",
      message,
      {
        host_id,
        action,
        total,
        completed,
        failed,
        skipped,
      },
      progress,
    );
  };

  await updateProgress(
    total
      ? `${action} queued for ${total} project${total === 1 ? "" : "s"}`
      : `no projects matched ${action} target set`,
  );

  if (!total) {
    return {
      host_id,
      action,
      state_filter: `${input?.state_filter ?? "running"}`,
      project_state: `${input?.project_state ?? ""}`.trim() || undefined,
      risk_only: !!input?.risk_only,
      total,
      succeeded: completed,
      failed,
      skipped,
      projects: results,
    };
  }

  const queue = [...requestedProjects];
  const worker = async () => {
    while (queue.length > 0) {
      if (await shouldCancel()) {
        throw new HostOpCanceledError();
      }
      const next = queue.shift();
      if (!next) return;
      const project_id = `${next.project_id ?? ""}`.trim();
      const state = `${next.state ?? ""}`.trim();
      if (!project_id) continue;
      try {
        await progressStep("projects", `${action} ${project_id}`, {
          host_id,
          action,
          project_id,
          state,
        });
        if (action === "stop") {
          // The host operation has already authorized the operator against the
          // host and captured projects assigned to that host. Do not require
          // the host operator to also be a collaborator on every project.
          await stopProjectOnHost(project_id);
          await waitForProjectStopped(project_id);
          await releaseProjectRuntimeSlotAfterHostStop({ host_id, project_id });
        } else {
          if (!isProjectRunning(state)) {
            skipped += 1;
            results.push({
              project_id,
              status: "skipped",
              state,
              error: "restart is limited to running projects",
            });
            continue;
          }
          await restartProjectWithRuntimeSlot({
            actor_account_id,
            host_id,
            project_id,
          });
        }
        completed += 1;
        results.push({ project_id, status: "succeeded", state });
      } catch (err) {
        failed += 1;
        results.push({
          project_id,
          status: "failed",
          state,
          error: `${err}`,
        });
      } finally {
        await updateProgress(
          `${action} ${completed + failed + skipped}/${total} project${total === 1 ? "" : "s"}`,
        );
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(parallel, total) }, () => worker()),
  );

  return {
    host_id,
    action,
    state_filter: `${input?.state_filter ?? "running"}`,
    project_state: `${input?.project_state ?? ""}`.trim() || undefined,
    risk_only: !!input?.risk_only,
    total,
    succeeded: completed,
    failed,
    skipped,
    projects: results,
  };
}

function isProjectRunning(state?: string | null): boolean {
  return state === "running" || state === "starting";
}

function needsBackup(row: HostProjectRow): BackupCandidate | undefined {
  const state = row.state?.state ?? null;
  if (isProjectRunning(state)) {
    return { project_id: row.project_id, reason: "running" };
  }
  if (!row.provisioned) {
    return undefined;
  }
  const lastChanged = row.last_changed
    ? new Date(row.last_changed).getTime()
    : row.last_edited
      ? new Date(row.last_edited).getTime()
      : 0;
  const lastBackup = row.last_backup ? new Date(row.last_backup).getTime() : 0;
  if (!lastChanged) {
    return { project_id: row.project_id, reason: "dirty" };
  }
  if (!lastBackup || lastChanged > lastBackup) {
    return { project_id: row.project_id, reason: "dirty" };
  }
  return undefined;
}

function isMissingProjectVolumeError(err: unknown): boolean {
  const text = `${(err as any)?.message ?? err ?? ""}`.toLowerCase();
  return (
    text.includes("project volume does not exist") ||
    text.includes("no such btrfs subvolume")
  );
}

async function markProjectMissingVolume({
  project_id,
  host_id,
}: {
  project_id: string;
  host_id: string;
}) {
  await getPool().query(
    `
      UPDATE projects
      SET provisioned=FALSE,
          provisioned_checked_at=NOW()
      WHERE project_id=$1
        AND host_id=$2
        AND deleted IS NOT TRUE
        AND provisioned IS DISTINCT FROM FALSE
    `,
    [project_id, host_id],
  );
}

async function createProjectBackupOp({
  project_id,
  account_id,
}: {
  project_id: string;
  account_id: string;
}): Promise<LroSummary> {
  const op = await createLro({
    kind: BACKUP_LRO_KIND,
    scope_type: "project",
    scope_id: project_id,
    created_by: account_id,
    routing: "hub",
    input: { project_id },
    status: "queued",
  });
  await publishLroSummary({
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    summary: op,
  });
  publishLroEvent({
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    op_id: op.op_id,
    event: {
      type: "progress",
      ts: Date.now(),
      phase: "queued",
      message: "queued",
      progress: 0,
    },
  }).catch(() => {});
  return op;
}

async function ensureHostBackups({
  host_id,
  account_id,
  skip_backups,
  progressStep,
  shouldCancel,
}: {
  host_id: string;
  account_id: string;
  skip_backups: boolean;
  progressStep: (
    step: string,
    message: string,
    detail?: any,
    progress?: number,
  ) => Promise<void>;
  shouldCancel: () => Promise<boolean>;
}): Promise<void> {
  if (await shouldCancel()) {
    throw new HostOpCanceledError();
  }
  const projects = await loadHostProjects(host_id);
  const assigned = projects.length;
  const provisioned = projects.filter((row) => row.provisioned).length;
  const running = projects.filter((row) =>
    isProjectRunning(row.state?.state ?? null),
  ).length;
  const skippedUnprovisioned = projects.filter(
    (row) => !row.provisioned && !isProjectRunning(row.state?.state ?? null),
  ).length;
  const candidates = projects
    .map((row) => needsBackup(row))
    .filter((row): row is BackupCandidate => !!row);
  if (!candidates.length) {
    if (assigned) {
      await progressStep("backups", "backups not needed", {
        host_id,
        assigned,
        provisioned,
        running,
        skipped_unprovisioned: skippedUnprovisioned,
      });
    }
    return;
  }

  if (skip_backups) {
    await progressStep("backups", "backups skipped", {
      host_id,
      assigned,
      provisioned,
      running,
      skipped_unprovisioned: skippedUnprovisioned,
      total: candidates.length,
      skipped: candidates.length,
    });
    return;
  }

  const statusRow = await loadHostStatus(host_id);
  const status = String(statusRow?.status ?? "");
  if (!["running", "starting", "restarting", "error"].includes(status)) {
    throw new Error("host is not running; use force to skip backups");
  }

  const total = candidates.length;
  let completed = 0;
  let failed = 0;
  let skippedMissingVolume = 0;

  const updateProgress = async () => {
    const done = completed + failed + skippedMissingVolume;
    const progress = total
      ? Math.round((done / total) * BACKUP_PROGRESS_MAX)
      : 0;
    const skippedTotal = skippedUnprovisioned + skippedMissingVolume;
    const skippedNote = skippedTotal ? ` (skipped ${skippedTotal})` : "";
    await progressStep(
      "backups",
      `backups ${done}/${total}${skippedNote}`,
      {
        host_id,
        assigned,
        provisioned,
        running,
        total,
        completed,
        failed,
        skipped_missing_volume: skippedMissingVolume,
        skipped_unprovisioned: skippedUnprovisioned,
      },
      progress,
    );
  };

  await updateProgress();

  const queue = [...candidates];
  let abortError: Error | null = null;
  const worker = async () => {
    while (queue.length && !abortError) {
      if (await shouldCancel()) {
        abortError = new HostOpCanceledError();
        throw abortError;
      }
      const next = queue.shift();
      if (!next) return;
      try {
        const backupOp = await createProjectBackupOp({
          project_id: next.project_id,
          account_id,
        });
        const summary = await waitForDurableLroCompletion({
          op_id: backupOp.op_id,
          scope_type: backupOp.scope_type,
          scope_id: backupOp.scope_id,
          client: conat(),
          timeout_ms: BACKUP_WAIT_MS,
        });
        if (summary.status !== "succeeded") {
          throw new Error(
            summary.error ?? `backup ${summary.status} for ${next.project_id}`,
          );
        }
        completed += 1;
      } catch (err) {
        if (isMissingProjectVolumeError(err)) {
          await markProjectMissingVolume({
            project_id: next.project_id,
            host_id,
          });
          skippedMissingVolume += 1;
          logger.warn("skipping backup due to missing project volume", {
            host_id,
            project_id: next.project_id,
            err: `${err}`,
          });
          continue;
        }
        failed += 1;
        abortError = err as Error;
        throw err;
      } finally {
        await updateProgress();
      }
    }
  };

  const workers = Array.from({ length: Math.min(BACKUP_PARALLEL, total) }, () =>
    worker(),
  );

  await Promise.all(workers);
}

function hostBackupSkipReason(
  row: HostBackupProjectRow,
): "unprovisioned" | "up-to-date" | undefined {
  const state = `${row.state ?? ""}`.trim();
  if (!row.provisioned && !isProjectRunning(state)) {
    return "unprovisioned";
  }
  if (row.needs_backup === false) {
    return "up-to-date";
  }
  if (row.needs_backup === true) {
    return undefined;
  }
  const lastChanged = row.last_changed
    ? new Date(row.last_changed).getTime()
    : row.last_edited
      ? new Date(row.last_edited).getTime()
      : 0;
  const lastBackup = row.last_backup ? new Date(row.last_backup).getTime() : 0;
  if (lastBackup && (!lastChanged || lastChanged <= lastBackup)) {
    return "up-to-date";
  }
  return undefined;
}

function normalizeHostBackupProjectRows(input: any): HostBackupProjectRow[] {
  if (Array.isArray(input?.projects)) {
    return input.projects;
  }
  return [];
}

async function runHostBackupAll({
  host_id,
  account_id,
  input,
  shouldCancel,
  progressStep,
}: {
  host_id: string;
  account_id: string;
  input: any;
  shouldCancel: () => Promise<boolean>;
  progressStep: (
    step: string,
    message: string,
    detail?: any,
    progress?: number,
  ) => Promise<void>;
}): Promise<HostBackupAllResult> {
  const requestedProjects = normalizeHostBackupProjectRows(input);
  const total = requestedProjects.length;
  const parallel = Math.max(1, Math.min(32, Number(input?.parallel ?? 6) || 6));
  const results: HostBackupAllResult["projects"] = [];
  let completed = 0;
  let failed = 0;
  let skipped = 0;

  const currentProgress = () => {
    const done = completed + failed + skipped;
    return total ? Math.round((done / total) * 100) : 100;
  };

  const updateProgress = async (message: string) => {
    await progressStep(
      "backups",
      message,
      {
        host_id,
        total,
        completed,
        failed,
        skipped,
      },
      currentProgress(),
    );
  };

  await updateProgress(
    total
      ? `backup queued for ${total} project${total === 1 ? "" : "s"}`
      : "no assigned projects to backup",
  );

  if (!total) {
    return {
      host_id,
      total,
      backup_total: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      projects: results,
    };
  }

  const statusRow = await loadHostStatus(host_id);
  const status = String(statusRow?.status ?? "");
  if (!["running", "starting", "restarting", "error"].includes(status)) {
    throw new Error("host is not running; start it before backing up projects");
  }

  const queue = [...requestedProjects];
  const worker = async () => {
    while (queue.length > 0) {
      if (await shouldCancel()) {
        throw new HostOpCanceledError();
      }
      const next = queue.shift();
      if (!next) return;
      const project_id = `${next.project_id ?? ""}`.trim();
      if (!project_id) {
        skipped += 1;
        await updateProgress(`backup ${completed + failed + skipped}/${total}`);
        continue;
      }
      const state = `${next.state ?? ""}`.trim();
      const skipReason = hostBackupSkipReason(next);
      if (skipReason) {
        skipped += 1;
        results.push({
          project_id,
          status: "skipped",
          state,
          reason: skipReason,
        });
        await updateProgress(`backup ${completed + failed + skipped}/${total}`);
        continue;
      }

      try {
        await progressStep(
          "backups",
          `backup ${project_id}`,
          {
            host_id,
            project_id,
            state,
            total,
            completed,
            failed,
            skipped,
          },
          currentProgress(),
        );
        const backupOp = await createProjectBackupOp({
          project_id,
          account_id,
        });
        const summary = await waitForDurableLroCompletion({
          op_id: backupOp.op_id,
          scope_type: backupOp.scope_type,
          scope_id: backupOp.scope_id,
          client: conat(),
          timeout_ms: BACKUP_WAIT_MS,
        });
        if (summary.status !== "succeeded") {
          throw new Error(
            summary.error ?? `backup ${summary.status} for ${project_id}`,
          );
        }
        completed += 1;
        results.push({
          project_id,
          status: "succeeded",
          state,
          backup_op_id: backupOp.op_id,
        });
      } catch (err) {
        if (isMissingProjectVolumeError(err)) {
          await markProjectMissingVolume({ project_id, host_id });
          skipped += 1;
          results.push({
            project_id,
            status: "skipped",
            state,
            reason: "missing-volume",
            error: `${err}`,
          });
          logger.warn("skipping backup due to missing project volume", {
            host_id,
            project_id,
            err: `${err}`,
          });
          continue;
        }
        failed += 1;
        results.push({
          project_id,
          status: "failed",
          state,
          error: `${err}`,
        });
      } finally {
        await updateProgress(`backup ${completed + failed + skipped}/${total}`);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(parallel, total) }, () => worker()),
  );

  return {
    host_id,
    total,
    backup_total: completed + failed,
    succeeded: completed,
    failed,
    skipped,
    projects: results,
  };
}

function opLabel(kind: HostOpKind, input: any): string {
  switch (kind) {
    case "host-start":
      return "Start";
    case "host-stop":
      return "Stop";
    case "host-restart":
      return input?.mode === "hard" ? "Hard restart" : "Restart";
    case "host-drain":
      return input?.force ? "Force drain" : "Drain";
    case "host-backup-all":
      return "Backup host projects";
    case "host-stop-projects":
      return "Stop host projects";
    case "host-restart-projects":
      return "Restart host projects";
    case "host-reconcile-software":
      return "Reconcile";
    case "host-reconcile-runtime-deployments":
      return "Reconcile runtime deployments";
    case "host-rollback-runtime-deployments":
      return "Rollback runtime deployment";
    case "host-upgrade-software":
      return "Upgrade";
    case "host-rollout-managed-components":
      return "Rollout managed components";
    case "host-deprovision":
      return "Deprovision";
    case "host-delete":
      return "Delete";
    case "host-force-deprovision":
      return "Force deprovision";
    case "host-remove-connector":
      return "Remove connector";
    default:
      return "Host op";
  }
}

function waitConfig(kind: HostOpKind) {
  switch (kind) {
    case "host-start":
      return {
        desired: ["running"],
        failOn: ["error", "off", "stopped", "deprovisioned"],
        message: "waiting for host to be running",
      };
    case "host-stop":
      return {
        desired: ["off", "deprovisioned"],
        failOn: ["error"],
        message: "waiting for host to stop",
      };
    case "host-restart":
      return {
        desired: ["running"],
        failOn: ["error", "deprovisioned"],
        message: "waiting for host to restart",
      };
    case "host-drain":
      return {
        desired: [
          "running",
          "starting",
          "restarting",
          "draining",
          "stopping",
          "off",
          "deprovisioning",
          "deprovisioned",
          "error",
        ],
        failOn: [],
        message: "finalizing host drain",
      };
    case "host-reconcile-software":
      return {
        desired: ["running"],
        failOn: ["error", "off", "deprovisioned"],
        message: "waiting for host to reconnect",
      };
    case "host-stop-projects":
    case "host-restart-projects":
    case "host-backup-all":
      return {
        desired: ["running"],
        failOn: ["error", "off", "deprovisioned"],
        message: "waiting for host to remain running",
      };
    case "host-reconcile-runtime-deployments":
      return {
        desired: ["running"],
        failOn: ["error", "off", "deprovisioned"],
        message: "waiting for host to remain running",
      };
    case "host-deprovision":
      return {
        desired: ["deprovisioned"],
        failOn: ["error"],
        message: "waiting for deprovision",
      };
    case "host-delete":
      return {
        desired: ["deprovisioned"],
        failOn: ["error"],
        allowDeleted: true,
        message: "waiting for host deletion",
      };
    case "host-force-deprovision":
      return {
        desired: ["deprovisioned"],
        failOn: ["error"],
        message: "waiting for force deprovision",
      };
    case "host-remove-connector":
      return {
        desired: ["deprovisioned"],
        failOn: ["error"],
        message: "waiting for connector removal",
      };
    default:
      return {
        desired: ["running"],
        failOn: ["error"],
        message: "waiting for host",
      };
  }
}

function shouldStopTunnel(kind: HostOpKind): boolean {
  return [
    "host-stop",
    "host-deprovision",
    "host-delete",
    "host-force-deprovision",
    "host-remove-connector",
  ].includes(kind);
}

async function markBillingEnforcementDrainComplete({
  host_id,
}: {
  host_id: string;
}) {
  const { rows } = await getPool().query<{ metadata: any }>(
    "SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
    [host_id],
  );
  const metadata = rows[0]?.metadata ?? {};
  await getPool().query(
    `
      UPDATE project_hosts
      SET metadata=$2, updated=NOW()
      WHERE id=$1 AND deleted IS NULL
    `,
    [host_id, billingEnforcementDrainCompleteMetadata(metadata)],
  );
}

function billingEnforcementDrainCompleteMetadata(
  metadata: any,
  now: Date = new Date(),
) {
  const billing = metadata.billing ?? {};
  const enforcement = billing.enforcement ?? {};
  const nowIso = now.toISOString();
  const graceUntil =
    typeof enforcement.grace_until === "string" && enforcement.grace_until
      ? enforcement.grace_until
      : new Date(
          now.valueOf() + DEDICATED_HOST_BILLING_DISK_GRACE_HOURS * 3600_000,
        ).toISOString();
  const reason =
    typeof enforcement.reason === "string" && enforcement.reason
      ? enforcement.reason
      : "billing enforcement drain complete";
  return {
    ...metadata,
    desired_state: "stopped",
    billing: {
      ...billing,
      enforcement: {
        ...enforcement,
        state: "stopped_billing_blocked",
        reason,
        stopped_at: enforcement.stopped_at ?? nowIso,
        grace_until: graceUntil,
        deprovision_after: enforcement.deprovision_after ?? graceUntil,
        final_backup_status: "succeeded",
        final_backup_completed_at:
          enforcement.final_backup_completed_at ?? nowIso,
        recovery_actions: enforcement.recovery_actions ?? [
          "add_funds",
          "fix_payment",
          "support_limit_increase",
        ],
      },
      stop_reason: reason,
      stop_requested_at: billing.stop_requested_at ?? nowIso,
    },
  };
}

async function runHostAction(
  kind: HostOpKind,
  host_id: string,
  account_id: string,
  input: any,
  helpers?: {
    shouldCancel?: () => Promise<boolean>;
    progressStep?: (
      step: string,
      message: string,
      detail?: any,
      progress?: number,
    ) => Promise<void>;
  },
) {
  switch (kind) {
    case "host-start":
      await startHostInternal({ account_id, id: host_id });
      return undefined;
    case "host-stop":
      await stopHostInternal({ account_id, id: host_id });
      return undefined;
    case "host-restart":
      await restartHostInternal({
        account_id,
        id: host_id,
        mode: input?.mode === "hard" ? "hard" : "reboot",
      });
      return undefined;
    case "host-drain":
      const drain = await drainHostInternal({
        account_id,
        id: host_id,
        dest_host_id: input?.dest_host_id,
        force: !!input?.force,
        allow_offline: !!input?.allow_offline,
        parallel: input?.parallel,
        managed_egress_override:
          input?.managed_egress_override === "admin-host-drain"
            ? "admin-host-drain"
            : undefined,
        shouldCancel: helpers?.shouldCancel,
        onProgress: async (update) => {
          await helpers?.progressStep?.(
            "draining",
            update.message,
            update.detail,
            update.progress,
          );
        },
      });
      if (input?.billing_enforcement === true) {
        await helpers?.progressStep?.(
          "stopping",
          "stopping drained host for billing enforcement",
          { host_id },
          70,
        );
        await markBillingEnforcementDrainComplete({ host_id });
        await stopHostInternal({ account_id, id: host_id });
      }
      return drain;
    case "host-reconcile-software":
      await reconcileHostSoftwareInternal({ account_id, id: host_id });
      return undefined;
    case "host-deprovision":
    case "host-delete":
      await deleteHostInternal({ account_id, id: host_id });
      return undefined;
    case "host-force-deprovision":
      await forceDeprovisionHostInternal({ account_id, id: host_id });
      return undefined;
    case "host-remove-connector":
      await removeSelfHostConnectorInternal({ account_id, id: host_id });
      return undefined;
    default:
      throw new Error(`unsupported host op: ${kind}`);
  }
}

async function handleOp(op: LroSummary): Promise<void> {
  const { op_id } = op;
  const input = op.input ?? {};
  const host_id = op.scope_id ?? input.id;
  const account_id = op.created_by ?? input.account_id;
  const kind = op.kind as HostOpKind;

  if (!HOST_OP_KINDS.includes(kind)) {
    const updated = await updateLro({
      op_id,
      status: "failed",
      error: `unsupported host op kind: ${op.kind}`,
    });
    if (updated) {
      await publishSummary(updated);
    }
    return;
  }

  if (!host_id || !account_id) {
    const updated = await updateLro({
      op_id,
      status: "failed",
      error: `${kind} op missing host or account`,
    });
    if (updated) {
      await publishSummary(updated);
    }
    return;
  }

  const heartbeat = setInterval(() => {
    touchLro({ op_id, owner_type: OWNER_TYPE, owner_id: WORKER_ID }).catch(
      (err) => logger.debug("host op heartbeat failed", { op_id, err }),
    );
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  let lastProgressKey: string | null = null;
  const progressStep = async (
    step: string,
    message: string,
    detail?: any,
    progress?: number,
  ) => {
    let detailKey = "";
    if (detail !== undefined) {
      try {
        detailKey = JSON.stringify(detail);
      } catch {
        detailKey = String(detail);
      }
    }
    const progressKey = `${step}|${message}|${detailKey}|${progress ?? ""}`;
    if (progressKey === lastProgressKey) {
      return;
    }
    lastProgressKey = progressKey;
    logger.info("host op step", { op_id, kind, step, message, detail });
    progressEvent({ op, step, message, detail, progress });
    touchLro({ op_id, owner_type: OWNER_TYPE, owner_id: WORKER_ID }).catch(
      () => {},
    );
    await updateProgressSummary(op, { step, message, detail, progress }).catch(
      () => {},
    );
  };

  const cancelState = {
    lastCheck: 0,
    canceled: false,
  };

  const shouldCancel = async () => {
    if (cancelState.canceled) return true;
    const now = Date.now();
    if (now - cancelState.lastCheck < 2_000) {
      return cancelState.canceled;
    }
    cancelState.lastCheck = now;
    const latest = await getLro(op_id);
    cancelState.canceled = latest?.status === "canceled";
    return cancelState.canceled;
  };

  try {
    const running = await updateLro({
      op_id,
      status: "running",
      error: null,
    });
    if (running) {
      await publishSummary(running);
    }

    const actionLabel = opLabel(kind, input);
    const actionLower = actionLabel.toLowerCase();

    if (await shouldCancel()) {
      throw new HostOpCanceledError();
    }

    const skipBackups = !!input?.skip_backups;
    const needsBackupPhase =
      kind === "host-stop" || kind === "host-deprovision";
    if (needsBackupPhase) {
      await ensureHostBackups({
        host_id,
        account_id,
        skip_backups: skipBackups,
        progressStep,
        shouldCancel,
      });
    }

    await progressStep("requesting", `requesting ${actionLower}`, {
      host_id,
      action: actionLower,
    });

    if (kind === "host-upgrade-software") {
      const preUpgradeRow = await loadHostStatus(host_id);
      const knownGoodProjectHostVersion =
        `${preUpgradeRow?.metadata?.software?.project_host ?? preUpgradeRow?.version ?? ""}`.trim() ||
        undefined;
      const requestedProjectHostUpgrade = (input?.targets ?? []).some(
        (target: any) => target?.artifact === "project-host",
      );
      let response;
      let rolloutResponse;
      const phase_timings_ms: Record<string, number> = {};
      const timePhase = async <T>(
        name: string,
        run: () => Promise<T>,
      ): Promise<T> => {
        const started = Date.now();
        try {
          return await run();
        } finally {
          phase_timings_ms[name] =
            (phase_timings_ms[name] ?? 0) + (Date.now() - started);
        }
      };
      const timingSummary = () =>
        Object.keys(phase_timings_ms).length > 0 ? { phase_timings_ms } : {};
      try {
        await progressStep("waiting", "running upgrade", {
          host_id,
          targets: input?.targets,
        });
        response = await timePhase(
          "host_control_upgrade_ms",
          async () =>
            await upgradeHostSoftwareInternal({
              account_id,
              id: host_id,
              targets: input?.targets ?? [],
              base_url: input?.base_url,
              align_runtime_stack: input?.align_runtime_stack,
              record_runtime_deployments:
                input?.record_runtime_deployments !== false,
              onProgress: async (update) => {
                await progressStep("waiting", update.rollout_phase_label, {
                  host_id,
                  targets: input?.targets,
                  ...update,
                  ...timingSummary(),
                });
              },
            }),
        );
        const rolloutComponents = rolloutComponentsForUpgradeResults(
          response.results ?? [],
          {
            targets: input?.targets ?? [],
            alignRuntimeStack: !!input?.align_runtime_stack,
          },
        );
        if (rolloutComponents.length > 0) {
          await progressStep(
            "waiting",
            "rolling out upgraded managed components",
            {
              host_id,
              components: rolloutComponents,
              ...timingSummary(),
            },
          );
          rolloutResponse = await timePhase(
            "managed_component_rollout_ms",
            async () =>
              await rolloutHostManagedComponentsInternal({
                account_id,
                id: host_id,
                components: rolloutComponents,
                base_url: input?.base_url,
                reason: "host_software_upgrade",
                record_runtime_deployments:
                  input?.record_runtime_deployments !== false,
                onProgress: async (update) => {
                  await progressStep("waiting", update.rollout_phase_label, {
                    host_id,
                    components: rolloutComponents,
                    ...update,
                    ...timingSummary(),
                  });
                },
              }),
          );
        }
      } catch (err) {
        const targetProjectHostVersion =
          `${(response?.results ?? []).find((result: any) => result?.artifact === "project-host")?.version ?? ""}`.trim() ||
          undefined;
        if (isProjectHostLocalRollbackError(err)) {
          const automaticRollback = err.automaticRollback;
          const updated = await updateLro({
            op_id,
            status: "failed",
            progress_summary: {
              phase: "done",
              host_id,
              results: response?.results ?? [],
              automatic_rollback: automaticRollback,
              ...timingSummary(),
            },
            result: {
              host_id,
              ...(response ? response : {}),
              automatic_rollback: automaticRollback,
              ...timingSummary(),
            },
            error: `project-host upgrade failed and was automatically rolled back locally: ${err.message}`,
          });
          if (updated) {
            await publishSummary(updated);
          }
          await progressStep(
            "done",
            "project-host upgrade failed; host-agent completed automatic rollback",
            {
              host_id,
              automatic_rollback: automaticRollback,
              ...timingSummary(),
            },
          );
          return;
        }
        if (
          requestedProjectHostUpgrade &&
          (targetProjectHostVersion || knownGoodProjectHostVersion)
        ) {
          await progressStep(
            "waiting",
            "project-host upgrade reported drift; confirming host convergence before rollback",
            {
              host_id,
              target_version: targetProjectHostVersion,
              previous_version: knownGoodProjectHostVersion,
            },
          );
          const convergedVersion = await timePhase(
            "project_host_convergence_ms",
            async () =>
              await waitForCompletedProjectHostUpgrade({
                host_id,
                targetVersion: targetProjectHostVersion,
                previousVersion: knownGoodProjectHostVersion,
              }),
          );
          if (
            convergedVersion &&
            (!targetProjectHostVersion ||
              convergedVersion === targetProjectHostVersion)
          ) {
            logger.info(
              "host upgrade: suppressing stale project-host rollback after observed convergence",
              {
                host_id,
                target_version: targetProjectHostVersion || convergedVersion,
                err: `${err}`,
              },
            );
            const updated = await updateLro({
              op_id,
              status: "succeeded",
              progress_summary: {
                phase: "done",
                host_id,
                results: response?.results ?? [],
                recovered_after_convergence_delay: true,
                ...(rolloutResponse
                  ? { managed_component_rollout: rolloutResponse.results ?? [] }
                  : {}),
                ...timingSummary(),
              },
              result: {
                host_id,
                ...(response ? response : {}),
                recovered_after_convergence_delay: true,
                ...(rolloutResponse
                  ? { managed_component_rollout: rolloutResponse.results ?? [] }
                  : {}),
                ...timingSummary(),
              },
              error: null,
            });
            if (updated) {
              await publishSummary(updated);
            }
            await progressStep(
              "done",
              "upgrade complete after delayed project-host convergence",
              {
                host_id,
                target_version: targetProjectHostVersion || convergedVersion,
                results: response?.results ?? [],
                ...timingSummary(),
              },
            );
            return;
          }
        }
        if (requestedProjectHostUpgrade && knownGoodProjectHostVersion) {
          try {
            await progressStep(
              "waiting",
              "project-host upgrade failed; attempting automatic rollback",
              {
                host_id,
                rollback_version: knownGoodProjectHostVersion,
              },
            );
            const rollbackStartedAt = Date.now();
            const automaticRollback = await timePhase(
              "automatic_rollback_ms",
              async () =>
                await rollbackProjectHostOverSshInternal({
                  account_id,
                  id: host_id,
                  version: knownGoodProjectHostVersion,
                  reason: "automatic_project_host_upgrade_rollback",
                }),
            );
            await timePhase(
              "post_rollback_heartbeat_wait_ms",
              async () =>
                await waitForHostHeartbeat({
                  host_id,
                  since: rollbackStartedAt,
                }),
            );
            const updated = await updateLro({
              op_id,
              status: "failed",
              progress_summary: {
                phase: "done",
                host_id,
                results: response?.results ?? [],
                automatic_rollback: automaticRollback,
                ...timingSummary(),
              },
              result: {
                host_id,
                ...(response ? response : {}),
                automatic_rollback: automaticRollback,
                ...timingSummary(),
              },
              error: `project-host upgrade failed and was automatically rolled back: ${err instanceof Error ? err.message : err}`,
            });
            if (updated) {
              await publishSummary(updated);
            }
            await progressStep(
              "done",
              "project-host upgrade failed; automatic rollback completed",
              {
                host_id,
                automatic_rollback: automaticRollback,
                ...timingSummary(),
              },
            );
            return;
          } catch (rollbackErr) {
            logger.error(
              "host upgrade: automatic project-host rollback failed",
              {
                host_id,
                rollback_version: knownGoodProjectHostVersion,
                err: `${rollbackErr}`,
              },
            );
            throw new Error(
              `project-host upgrade failed (${err instanceof Error ? err.message : err}); automatic rollback also failed (${rollbackErr instanceof Error ? rollbackErr.message : rollbackErr})`,
            );
          }
        }
        if (!requestedProjectHostUpgrade && !response) {
          logger.warn(
            "host upgrade: host-control upgrade failed before host-side response",
            {
              host_id,
              targets: input?.targets ?? [],
              err: `${err}`,
              ...timingSummary(),
            },
          );
          throw err;
        }
        logger.warn(
          "host upgrade: managed component rollout failed; retry via ssh reconcile",
          {
            host_id,
            components: rolloutComponentsForUpgradeResults(
              response?.results ?? [],
              {
                targets: input?.targets ?? [],
                alignRuntimeStack: !!input?.align_runtime_stack,
              },
            ),
            err: `${err}`,
            ...timingSummary(),
          },
        );
        await progressStep(
          "waiting",
          "managed rollout failed; attempting ssh reconcile",
          {
            host_id,
            components: rolloutComponentsForUpgradeResults(
              response?.results ?? [],
              {
                targets: input?.targets ?? [],
                alignRuntimeStack: !!input?.align_runtime_stack,
              },
            ),
            ...timingSummary(),
          },
        );
        await timePhase(
          "ssh_reconcile_ms",
          async () =>
            await reconcileHostSoftwareInternal({ account_id, id: host_id }),
        );
        const row = await loadHostStatus(host_id);
        const baselineSeen = row?.last_seen
          ? new Date(row.last_seen as any).getTime()
          : 0;
        await timePhase(
          "post_reconcile_heartbeat_wait_ms",
          async () =>
            await waitForHostHeartbeat({
              host_id,
              since: baselineSeen,
            }),
        );
      }
      const updated = await updateLro({
        op_id,
        status: "succeeded",
        progress_summary: {
          phase: "done",
          host_id,
          results: response?.results ?? [],
          ...(rolloutResponse
            ? { managed_component_rollout: rolloutResponse.results ?? [] }
            : {}),
          ...timingSummary(),
        },
        result: {
          host_id,
          ...(response ? response : {}),
          ...(rolloutResponse
            ? { managed_component_rollout: rolloutResponse.results ?? [] }
            : {}),
          ...timingSummary(),
        },
        error: null,
      });
      if (updated) {
        await publishSummary(updated);
      }
      await progressStep("done", "upgrade complete", {
        host_id,
        results: response?.results ?? [],
        ...(rolloutResponse
          ? { managed_component_rollout: rolloutResponse.results ?? [] }
          : {}),
        ...timingSummary(),
      });
      return;
    }

    if (kind === "host-rollout-managed-components") {
      await progressStep("waiting", "rolling out managed components", {
        host_id,
        components: input?.components ?? [],
      });
      const response = await rolloutHostManagedComponentsInternal({
        account_id,
        id: host_id,
        components: input?.components ?? [],
        base_url: input?.base_url,
        reason: input?.reason,
        onProgress: async (update) => {
          await progressStep("waiting", update.rollout_phase_label, {
            host_id,
            components: input?.components ?? [],
            ...update,
          });
        },
      });
      const updated = await updateLro({
        op_id,
        status: "succeeded",
        progress_summary: {
          phase: "done",
          host_id,
          components: input?.components ?? [],
          results: response.results ?? [],
        },
        result: { host_id, ...response },
        error: null,
      });
      if (updated) {
        await publishSummary(updated);
      }
      await progressStep("done", "managed component rollout complete", {
        host_id,
        components: input?.components ?? [],
        results: response.results ?? [],
      });
      return;
    }

    if (kind === "host-reconcile-software") {
      const reconcileStartedAt = Date.now();
      await progressStep("waiting", "running reconcile", {
        host_id,
      });
      await reconcileHostSoftwareInternal({
        account_id,
        id: host_id,
      });
      await progressStep("waiting", "waiting for host to return", {
        host_id,
      });
      await waitForHostHeartbeat({
        host_id,
        since: reconcileStartedAt,
      });
      const updated = await updateLro({
        op_id,
        status: "succeeded",
        progress_summary: {
          phase: "done",
          host_id,
          action: "reconcile",
        },
        result: { host_id, action: "reconcile" },
        error: null,
      });
      if (updated) {
        await publishSummary(updated);
      }
      await progressStep("done", "reconcile complete", {
        host_id,
      });
      return;
    }

    if (kind === "host-reconcile-runtime-deployments") {
      await progressStep("waiting", "reconciling runtime deployments", {
        host_id,
        components: input?.components ?? [],
      });
      const response = await reconcileHostRuntimeDeploymentsInternal({
        account_id,
        id: host_id,
        components: input?.components ?? [],
        reason: input?.reason,
        onProgress: async (update) => {
          await progressStep("waiting", update.rollout_phase_label, {
            host_id,
            components: input?.components ?? [],
            ...update,
          });
        },
      });
      const updated = await updateLro({
        op_id,
        status: "succeeded",
        progress_summary: {
          phase: "done",
          host_id,
          reconciled_components: response.reconciled_components,
        },
        result: response,
        error: null,
      });
      if (updated) {
        await publishSummary(updated);
      }
      await progressStep("done", "runtime deployment reconcile complete", {
        host_id,
        reconciled_components: response.reconciled_components,
        decisions: response.decisions,
      });
      return;
    }

    if (kind === "host-rollback-runtime-deployments") {
      await progressStep("waiting", "rolling back runtime deployment target", {
        host_id,
        target_type: input?.target_type,
        target: input?.target,
        version: input?.version,
        last_known_good: !!input?.last_known_good,
      });
      const response = await rollbackHostRuntimeDeploymentsInternal({
        account_id,
        id: host_id,
        target_type: input?.target_type,
        target: input?.target,
        version: input?.version,
        last_known_good: !!input?.last_known_good,
        reason: input?.reason,
      });
      const updated = await updateLro({
        op_id,
        status: "succeeded",
        progress_summary: {
          phase: "done",
          host_id,
          target_type: response.target_type,
          target: response.target,
          rollback_version: response.rollback_version,
        },
        result: response,
        error: null,
      });
      if (updated) {
        await publishSummary(updated);
      }
      await progressStep("done", "runtime deployment rollback complete", {
        host_id,
        target_type: response.target_type,
        target: response.target,
        rollback_version: response.rollback_version,
      });
      return;
    }

    if (kind === "host-backup-all") {
      const response = await runHostBackupAll({
        host_id,
        account_id,
        input,
        shouldCancel,
        progressStep,
      });
      const updated = await updateLro({
        op_id,
        status: response.failed > 0 ? "failed" : "succeeded",
        progress_summary: {
          phase: "done",
          host_id,
          total: response.total,
          backup_total: response.backup_total,
          succeeded: response.succeeded,
          failed: response.failed,
          skipped: response.skipped,
        },
        result: response,
        error:
          response.failed > 0
            ? `${response.failed} project backup(s) failed`
            : null,
      });
      if (updated) {
        await publishSummary(updated);
      }
      await progressStep(
        "done",
        `backup complete: ${response.succeeded} succeeded, ${response.failed} failed, ${response.skipped} skipped`,
        response,
      );
      return;
    }

    if (kind === "host-stop-projects" || kind === "host-restart-projects") {
      const action = kind === "host-stop-projects" ? "stop" : "restart";
      const response = await runHostProjectsAction({
        action,
        host_id,
        input,
        shouldCancel,
        progressStep,
      });
      const updated = await updateLro({
        op_id,
        status: response.failed > 0 ? "failed" : "succeeded",
        progress_summary: {
          phase: "done",
          host_id,
          action,
          total: response.total,
          succeeded: response.succeeded,
          failed: response.failed,
          skipped: response.skipped,
        },
        result: response,
        error:
          response.failed > 0
            ? `${response.failed} project action(s) failed`
            : null,
      });
      if (updated) {
        await publishSummary(updated);
      }
      await progressStep(
        "done",
        `${action} complete: ${response.succeeded} succeeded, ${response.failed} failed, ${response.skipped} skipped`,
        response,
      );
      return;
    }

    if (await shouldCancel()) {
      throw new HostOpCanceledError();
    }

    const actionResult = await runHostAction(kind, host_id, account_id, input, {
      shouldCancel,
      progressStep,
    });

    const wait = waitConfig(kind);
    const bootstrapFailureSince =
      kind === "host-start" || kind === "host-restart" ? Date.now() : undefined;
    await progressStep("waiting", wait.message, { host_id });
    const final = await waitForHostStatus({
      host_id,
      desired: wait.desired,
      failOn: wait.failOn,
      allowDeleted: wait.allowDeleted,
      shouldCancel,
      bootstrapFailureSince,
      onUpdate: async (status, metadata) => {
        logger.debug("host op status update", {
          op_id,
          kind,
          host_id,
          status,
          last_action_status: metadata?.last_action_status,
        });
      },
    });

    const updated = await updateLro({
      op_id,
      status: "succeeded",
      progress_summary: {
        phase: "done",
        host_id,
        status: final.status,
      },
      result:
        kind === "host-drain"
          ? { host_id, status: final.status, drain: actionResult }
          : { host_id, status: final.status },
      error: null,
    });
    if (updated) {
      await publishSummary(updated);
    }
    if (shouldStopTunnel(kind)) {
      stopSelfHostReverseTunnel(host_id);
    }
    await progressStep("done", `${actionLower} complete`, {
      host_id,
      status: final.status,
      ...(kind === "host-drain" ? { drain: actionResult } : {}),
    });
  } catch (err) {
    const canceled =
      err instanceof HostOpCanceledError ||
      (typeof err === "object" &&
        err !== null &&
        (err as { code?: string }).code === "host-op-canceled");
    if (canceled) {
      logger.info("host op canceled", { op_id, kind });
      const updated = await updateLro({
        op_id,
        status: "canceled",
        error: `${err}`,
      });
      if (updated) {
        await publishSummary(updated);
      }
      await progressStep("canceled", "operation canceled", {
        host_id,
      });
    } else {
      logger.warn("host op failed", { op_id, kind, err: `${err}` });
      const updated = await updateLro({
        op_id,
        status: "failed",
        error: `${err}`,
      });
      if (updated) {
        await publishSummary(updated);
      }
      await progressStep("done", "operation failed", {
        host_id,
        error: `${err}`,
      });
    }
  } finally {
    clearInterval(heartbeat);
  }
}

export function startHostLroWorker({
  intervalMs = TICK_MS,
  maxParallel,
}: {
  intervalMs?: number;
  maxParallel?: number;
} = {}) {
  if (running) return () => undefined;
  running = true;
  logger.info("starting host ops LRO worker", {
    worker_id: WORKER_ID,
    max_parallel: maxParallel ?? "dynamic",
  });

  const tick = async () => {
    let effectiveMaxParallel = maxParallel;
    if (effectiveMaxParallel == null) {
      try {
        const { value } = await getEffectiveParallelOpsLimit({
          worker_kind: "host-ops",
          default_limit: DEFAULT_MAX_PARALLEL,
        });
        effectiveMaxParallel = value;
      } catch (err) {
        logger.warn("host op limit lookup failed", { err });
        return;
      }
    }
    if (inFlight >= effectiveMaxParallel) return;
    for (const kind of HOST_OP_KINDS) {
      if (inFlight >= effectiveMaxParallel) break;
      let ops: LroSummary[] = [];
      try {
        ops = await claimLroOps({
          kind,
          owner_type: OWNER_TYPE,
          owner_id: WORKER_ID,
          limit: Math.max(1, effectiveMaxParallel - inFlight),
          lease_ms: LEASE_MS,
        });
      } catch (err) {
        logger.warn("host op claim failed", { kind, err });
        continue;
      }
      for (const claimed of ops) {
        inFlight += 1;
        void handleOp(claimed)
          .catch(async (err) => {
            logger.warn("host op handler failed", {
              op_id: claimed.op_id,
              kind: claimed.kind,
              err,
            });
            const updated = await updateLro({
              op_id: claimed.op_id,
              status: "failed",
              error: `${err}`,
            });
            if (updated) {
              await publishSummary(updated);
            }
          })
          .finally(() => {
            inFlight = Math.max(0, inFlight - 1);
          });
      }
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();

  void tick();

  return () => {
    running = false;
    clearInterval(timer);
  };
}

export const __test__ = {
  currentBootstrapFailure,
  completedProjectHostUpgradeVersion,
  waitForHostStatus,
  billingEnforcementDrainCompleteMetadata,
};
