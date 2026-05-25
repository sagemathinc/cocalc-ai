import getLogger from "@cocalc/backend/logger";
import {
  createHostRegistryService,
  type HostProjectStopOverride,
  type HostProjectStopPolicyRow,
} from "@cocalc/conat/project-host/api";
import {
  upsertProjectHost,
  type ProjectHostRecord,
} from "@cocalc/database/postgres/project-hosts";
import { conat } from "@cocalc/backend/conat";
import { getProjectHostAuthTokenPublicKey } from "@cocalc/backend/data";
import getPool from "@cocalc/database/pool";
import {
  createProjectHostMasterConatToken,
  verifyProjectHostToken,
} from "@cocalc/server/project-host/bootstrap-token";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";
import { enqueueCloudVmWorkOnce } from "@cocalc/server/cloud/db";
import { shouldAutoRestoreInterruptedSpotHost } from "@cocalc/server/cloud/spot-restore";
import {
  ensureAutomaticHostArtifactDeploymentsReconcile,
  ensureAutomaticHostRuntimeDeploymentsReconcile,
} from "@cocalc/server/conat/api/hosts";
import { appendProjectOutboxEventForProject } from "@cocalc/database/postgres/project-events-outbox";
import { publishProjectAccountFeedEventsBestEffort } from "@cocalc/server/account/project-feed";
import { appendProjectLogRowBestEffort } from "@cocalc/server/projects/project-log";
import { startProjectOnHost } from "@cocalc/server/project-host/control";
import { loadProjectRuntimeSponsor } from "@cocalc/server/projects/runtime-sponsor-db";
import {
  heartbeatProjectRuntimeSlot,
  releaseProjectRuntimeSlot,
  reserveProjectRuntimeSlot,
} from "@cocalc/server/projects/runtime-slots";
import {
  getProjectOwnerAccountId,
  type ProjectUsers,
} from "@cocalc/server/projects/runtime-sponsor";
import { sleep } from "@cocalc/util/async-utils";
import { notifyProjectHostUpdate } from "./route-project";

const logger = getLogger("server:conat:host-registry");
const pool = () => getPool();
const STOP_POLICY_PRIORITY_CACHE_TTL_MS = 5 * 60_000;
const HOST_RESTART_RECOVERY_SCHEDULE_DELAY_MS = 1_000;
const HOST_RESTART_RECOVERY_DEFAULT_PARALLEL_STARTS = 4;
const HOST_RESTART_RECOVERY_MAX_PARALLEL_STARTS = 32;
const HOST_RESTART_RECOVERY_SLOT_TTL_MS = 30 * 60_000;
const HOST_RESTART_RECOVERY_ACTIVE_STATES = [
  "running",
  "starting",
  "restarting",
];

const stopPolicyPriorityCache = new Map<
  string,
  { priority: number; expires_at: number }
>();
const stopPolicyPriorityInflight = new Map<string, Promise<number>>();
const hostRestartRecoveryInflight = new Map<string, Promise<void>>();

export interface HostRegistration extends ProjectHostRecord {
  sshpiperd_public_key?: string;
  project_host_auth_public_key?: string;
}

function getHostSessionId(metadata: any): string | undefined {
  const value = `${metadata?.host_session_id ?? ""}`.trim();
  return value || undefined;
}

function getHostBootId(metadata: any): string | undefined {
  const value = `${metadata?.host_boot_id ?? ""}`.trim();
  return value || undefined;
}

function registryBayIdForHeartbeat(previousBayId: unknown): string {
  const localBayId = getConfiguredBayId();
  const current = `${previousBayId ?? ""}`.trim();
  // Heartbeats prove this bay currently has a host connection; they do not
  // grant metadata ownership. During host rehome, the old bay can keep seeing
  // heartbeats until bootstrap reconcile restarts the host agent.
  return current || localBayId;
}

function getPendingAutomaticConvergenceRetry(metadata: any): {
  runtime: boolean;
  artifacts: boolean;
} {
  const pending =
    metadata?.runtime_deployments?.pending_automatic_convergence_retry ?? {};
  return {
    runtime: pending?.runtime === true,
    artifacts: pending?.artifacts === true,
  };
}

const SUBJECT = "project-hosts";

function normalizeSharedComputePriority(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

async function getSharedComputePriorityForOwner(
  owner_account_id: string,
): Promise<number> {
  const now = Date.now();
  const cached = stopPolicyPriorityCache.get(owner_account_id);
  if (cached && cached.expires_at > now) {
    return cached.priority;
  }
  const inflight = stopPolicyPriorityInflight.get(owner_account_id);
  if (inflight) {
    return await inflight;
  }
  const promise = (async () => {
    try {
      const resolution = await resolveMembershipForAccount(owner_account_id);
      const priority = normalizeSharedComputePriority(
        resolution.effective_limits?.shared_compute_priority,
      );
      stopPolicyPriorityCache.set(owner_account_id, {
        priority,
        expires_at: now + STOP_POLICY_PRIORITY_CACHE_TTL_MS,
      });
      return priority;
    } catch (err) {
      logger.warn("failed to resolve shared compute priority", {
        owner_account_id,
        err: `${err}`,
      });
      return 0;
    } finally {
      stopPolicyPriorityInflight.delete(owner_account_id);
    }
  })();
  stopPolicyPriorityInflight.set(owner_account_id, promise);
  return await promise;
}

type StopPolicyBaseRow = {
  project_id: string;
  owner_account_id: string | null;
  authoritative_last_edited_ms: number | null;
  policy_updated_ms: number;
};

async function hydrateStopPolicyRows(
  rows: StopPolicyBaseRow[],
): Promise<HostProjectStopPolicyRow[]> {
  const priorities = new Map<string, number>();
  const ownerIds = Array.from(
    new Set(
      rows
        .map((row) => `${row.owner_account_id ?? ""}`.trim())
        .filter((owner_account_id) => owner_account_id.length > 0),
    ),
  );
  await Promise.all(
    ownerIds.map(async (owner_account_id) => {
      priorities.set(
        owner_account_id,
        await getSharedComputePriorityForOwner(owner_account_id),
      );
    }),
  );
  const defaultOverride: HostProjectStopOverride = "default";
  return rows.map((row) => {
    const owner_account_id = `${row.owner_account_id ?? ""}`.trim() || null;
    return {
      project_id: row.project_id,
      owner_account_id,
      shared_compute_priority: owner_account_id
        ? (priorities.get(owner_account_id) ?? 0)
        : 0,
      authoritative_last_edited_ms:
        row.authoritative_last_edited_ms != null
          ? Number(row.authoritative_last_edited_ms)
          : null,
      policy_updated_ms: Math.max(0, Number(row.policy_updated_ms ?? 0) || 0),
      stop_override: defaultOverride,
    };
  });
}

type HostRestartRecoveryBaseRow = {
  project_id: string;
  users: ProjectUsers;
  last_edited: Date | null;
  created: Date | null;
};

type HostRestartRecoveryProject = {
  project_id: string;
  owner_account_id?: string;
  shared_compute_priority: number;
  activity_ms: number;
};

type HostRestartRecoveryMetadataStatus =
  | "queued"
  | "running"
  | "finished"
  | "failed";

function recoveryInflightKey(host_id: string, host_boot_id?: string): string {
  return `${host_id}:${host_boot_id ?? ""}`;
}

function getRestartRecoveryStatus(metadata: any): {
  status?: string;
  host_boot_id?: string;
} {
  const recovery = metadata?.restart_recovery ?? {};
  return {
    status: `${recovery.status ?? ""}`.trim() || undefined,
    host_boot_id: `${recovery.host_boot_id ?? ""}`.trim() || undefined,
  };
}

function isRestartRecoveryPendingForBoot(
  metadata: any,
  host_boot_id?: string,
): boolean {
  const recovery = getRestartRecoveryStatus(metadata);
  return (
    !!host_boot_id &&
    recovery.host_boot_id === host_boot_id &&
    (recovery.status === "queued" || recovery.status === "running")
  );
}

function recoveryActivityMs(row: HostRestartRecoveryBaseRow): number {
  const value = row.last_edited ?? row.created;
  const ms = value ? new Date(value as any).getTime() : 0;
  return Number.isFinite(ms) ? ms : 0;
}

function parsePositiveNumber(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function parsePositiveInteger(value: unknown): number | undefined {
  const n = parsePositiveNumber(value);
  return n == null ? undefined : Math.floor(n);
}

function bytesToGiB(value: unknown): number | undefined {
  const bytes = parsePositiveNumber(value);
  return bytes == null ? undefined : bytes / 1024 ** 3;
}

function parseHostRestartRecoveryCpuCount({
  metadata,
  capacity,
}: {
  metadata?: any;
  capacity?: any;
}): number | undefined {
  const machineMetadata = metadata?.machine?.metadata ?? {};
  const runtimeMetadata = metadata?.runtime?.metadata ?? {};
  return (
    parsePositiveInteger(metadata?.host_cpu_count) ??
    parsePositiveInteger(metadata?.cpu_count) ??
    parsePositiveInteger(capacity?.cpu) ??
    parsePositiveInteger(capacity?.cpus) ??
    parsePositiveInteger(capacity?.vcpus) ??
    parsePositiveInteger(machineMetadata.cpu) ??
    parsePositiveInteger(machineMetadata.cpus) ??
    parsePositiveInteger(machineMetadata.vcpus) ??
    parsePositiveInteger(runtimeMetadata.cpu) ??
    parsePositiveInteger(runtimeMetadata.cpus) ??
    parsePositiveInteger(runtimeMetadata.vcpus)
  );
}

function parseHostRestartRecoveryMemoryGiB({
  metadata,
  capacity,
}: {
  metadata?: any;
  capacity?: any;
}): number | undefined {
  const machineMetadata = metadata?.machine?.metadata ?? {};
  const runtimeMetadata = metadata?.runtime?.metadata ?? {};
  const metrics = metadata?.metrics?.current ?? {};
  const hostRamMb = parsePositiveNumber(metadata?.host_ram_mb);
  return (
    bytesToGiB(metrics.memory_total_bytes) ??
    (hostRamMb == null ? undefined : hostRamMb / 1024) ??
    parsePositiveNumber(metadata?.host_ram_gb) ??
    parsePositiveNumber(capacity?.memory_gib) ??
    parsePositiveNumber(capacity?.ram_gib) ??
    parsePositiveNumber(machineMetadata.memory_gib) ??
    parsePositiveNumber(machineMetadata.ram_gib) ??
    parsePositiveNumber(runtimeMetadata.memory_gib) ??
    parsePositiveNumber(runtimeMetadata.ram_gib)
  );
}

export function hostRestartRecoveryParallelStarts({
  metadata,
  capacity,
}: {
  metadata?: any;
  capacity?: any;
}): number {
  const explicit =
    parsePositiveInteger(metadata?.restart_recovery?.max_parallel_starts) ??
    parsePositiveInteger(metadata?.restart_recovery_parallel_starts);
  if (explicit != null) {
    return Math.min(HOST_RESTART_RECOVERY_MAX_PARALLEL_STARTS, explicit);
  }
  const cpuCount = parseHostRestartRecoveryCpuCount({ metadata, capacity });
  const memoryGiB = parseHostRestartRecoveryMemoryGiB({ metadata, capacity });
  const cpuBased =
    cpuCount == null ? undefined : Math.max(1, Math.floor(cpuCount / 2));
  const memoryBased =
    memoryGiB == null ? undefined : Math.max(1, Math.floor(memoryGiB / 8));
  return Math.min(
    HOST_RESTART_RECOVERY_MAX_PARALLEL_STARTS,
    Math.max(
      HOST_RESTART_RECOVERY_DEFAULT_PARALLEL_STARTS,
      cpuBased ?? 0,
      memoryBased ?? 0,
    ),
  );
}

async function loadHostRestartRecoveryParallelStarts(
  host_id: string,
): Promise<number> {
  const { rows } = await pool().query<{ metadata: any; capacity: any }>(
    "SELECT metadata, capacity FROM project_hosts WHERE id=$1 AND deleted IS NULL",
    [host_id],
  );
  return hostRestartRecoveryParallelStarts({
    metadata: rows[0]?.metadata,
    capacity: rows[0]?.capacity,
  });
}

async function loadHostRestartRecoveryProjects(
  host_id: string,
): Promise<HostRestartRecoveryProject[]> {
  const { rows } = await pool().query<HostRestartRecoveryBaseRow>(
    `
      SELECT project_id, users, last_edited, created
        FROM projects
       WHERE host_id=$1
         AND deleted IS NOT TRUE
         AND COALESCE(state->>'state', '') = ANY($2)
    `,
    [host_id, HOST_RESTART_RECOVERY_ACTIVE_STATES],
  );
  const ownerIds = Array.from(
    new Set(
      rows
        .map((row) => getProjectOwnerAccountId(row.users))
        .filter((account_id): account_id is string => !!account_id),
    ),
  );
  const priorities = new Map<string, number>();
  await Promise.all(
    ownerIds.map(async (owner_account_id) => {
      priorities.set(
        owner_account_id,
        await getSharedComputePriorityForOwner(owner_account_id),
      );
    }),
  );
  return rows
    .map((row) => {
      const owner_account_id = getProjectOwnerAccountId(row.users);
      return {
        project_id: row.project_id,
        owner_account_id,
        shared_compute_priority: owner_account_id
          ? (priorities.get(owner_account_id) ?? 0)
          : 0,
        activity_ms: recoveryActivityMs(row),
      };
    })
    .sort((a, b) => {
      const priority = b.shared_compute_priority - a.shared_compute_priority;
      if (priority !== 0) return priority;
      const activity = b.activity_ms - a.activity_ms;
      if (activity !== 0) return activity;
      return a.project_id.localeCompare(b.project_id);
    });
}

async function updateHostRestartRecoveryMetadata({
  host_id,
  patch,
}: {
  host_id: string;
  patch: Record<string, unknown>;
}): Promise<void> {
  const { rows } = await pool().query<{ metadata: any }>(
    "SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
    [host_id],
  );
  const metadata = { ...(rows[0]?.metadata ?? {}) };
  metadata.restart_recovery = {
    ...(metadata.restart_recovery ?? {}),
    ...patch,
    updated_at: new Date().toISOString(),
  };
  await pool().query(
    "UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1 AND deleted IS NULL",
    [host_id, metadata],
  );
}

async function stillNeedsHostRestartRecovery({
  project_id,
  host_id,
}: {
  project_id: string;
  host_id: string;
}): Promise<boolean> {
  const { rows } = await pool().query<{ state: string | null }>(
    `
      SELECT COALESCE(state->>'state', '') AS state
        FROM projects
       WHERE project_id=$1
         AND host_id=$2
         AND deleted IS NOT TRUE
       LIMIT 1
    `,
    [project_id, host_id],
  );
  return HOST_RESTART_RECOVERY_ACTIVE_STATES.includes(rows[0]?.state ?? "");
}

async function markProjectRestartRecoveryFailedOpened({
  project_id,
  host_id,
  host_boot_id,
  err,
}: {
  project_id: string;
  host_id: string;
  host_boot_id?: string;
  err: unknown;
}): Promise<void> {
  const defaultBayId = getConfiguredBayId();
  const state = {
    state: "opened",
    time: new Date().toISOString(),
    reason: "host_restart_recovery_failed",
    host_boot_id,
    error: `${err}`.slice(0, 1000),
  };
  const client = await pool().connect();
  let changed = false;
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE projects
          SET state=$3::jsonb
        WHERE project_id=$1
          AND host_id=$2
          AND deleted IS NOT TRUE
          AND COALESCE(state->>'state', '') = ANY($4)`,
      [project_id, host_id, state, HOST_RESTART_RECOVERY_ACTIVE_STATES],
    );
    changed = (result.rowCount ?? 0) > 0;
    if (changed) {
      await appendProjectOutboxEventForProject({
        db: client,
        event_type: "project.state_changed",
        project_id,
        default_bay_id: defaultBayId,
      });
    }
    await client.query("COMMIT");
  } catch (updateErr) {
    await client.query("ROLLBACK");
    logger.warn("failed to mark restart recovery failure opened", {
      project_id,
      host_id,
      err: `${updateErr}`,
    });
  } finally {
    client.release();
  }
  if (changed) {
    await publishProjectAccountFeedEventsBestEffort({
      project_id,
      default_bay_id: defaultBayId,
    });
  }
}

async function recoverProjectAfterHostRestart({
  project,
  host_id,
  host_boot_id,
}: {
  project: HostRestartRecoveryProject;
  host_id: string;
  host_boot_id?: string;
}): Promise<"started" | "skipped" | "failed"> {
  if (
    !(await stillNeedsHostRestartRecovery({
      project_id: project.project_id,
      host_id,
    }))
  ) {
    return "skipped";
  }
  let reserved = false;
  let sponsor_account_id: string | undefined;
  try {
    const sponsor = await loadProjectRuntimeSponsor(project.project_id);
    sponsor_account_id = sponsor.sponsor_account_id;
    await reserveProjectRuntimeSlot({
      ...sponsor,
      project_id: project.project_id,
      actor_account_id: project.owner_account_id,
      reason: "host-restart-recovery",
      state: "starting",
      ttl_ms: HOST_RESTART_RECOVERY_SLOT_TTL_MS,
      metadata: {
        host_id,
        host_boot_id,
        recovered_by: "host-restart-recovery",
      },
    });
    reserved = true;
    await startProjectOnHost(project.project_id, {
      account_id: project.owner_account_id,
      ignore_recent_state_snapshot: true,
    });
    await heartbeatProjectRuntimeSlot({
      sponsor_account_id: sponsor.sponsor_account_id,
      project_id: project.project_id,
      host_id,
      state: "running",
      ttl_ms: HOST_RESTART_RECOVERY_SLOT_TTL_MS,
      metadata: {
        host_id,
        host_boot_id,
        recovered_by: "host-restart-recovery",
      },
    });
    return "started";
  } catch (err) {
    logger.warn("host restart recovery failed to start project", {
      host_id,
      host_boot_id,
      project_id: project.project_id,
      err: `${err}`,
    });
    if (reserved && sponsor_account_id) {
      await releaseProjectRuntimeSlot({
        sponsor_account_id,
        project_id: project.project_id,
        state: "failed",
      }).catch((releaseErr) => {
        logger.warn("failed to release restart recovery runtime slot", {
          host_id,
          project_id: project.project_id,
          sponsor_account_id,
          err: `${releaseErr}`,
        });
      });
    }
    await markProjectRestartRecoveryFailedOpened({
      project_id: project.project_id,
      host_id,
      host_boot_id,
      err,
    });
    return "failed";
  }
}

export async function startHostRestartRecoveryForHost({
  host_id,
  host_boot_id,
  previous_host_boot_id,
  previous_host_session_id,
  host_session_id,
  source,
  max_parallel_starts,
}: {
  host_id: string;
  host_boot_id?: string;
  previous_host_boot_id?: string;
  previous_host_session_id?: string;
  host_session_id?: string;
  source: "register" | "heartbeat";
  max_parallel_starts?: number;
}): Promise<void> {
  const startedAt = new Date().toISOString();
  await updateHostRestartRecoveryMetadata({
    host_id,
    patch: {
      status: "running" satisfies HostRestartRecoveryMetadataStatus,
      host_boot_id,
      previous_host_boot_id,
      previous_host_session_id,
      host_session_id,
      source,
      started_at: startedAt,
    },
  });
  const projects = await loadHostRestartRecoveryProjects(host_id);
  const rawParallelStarts =
    max_parallel_starts ??
    (await loadHostRestartRecoveryParallelStarts(host_id));
  const requestedParallelStarts =
    Number.isFinite(rawParallelStarts) && rawParallelStarts > 0
      ? Math.floor(rawParallelStarts)
      : HOST_RESTART_RECOVERY_DEFAULT_PARALLEL_STARTS;
  const parallelStarts = Math.max(
    1,
    Math.min(projects.length || 1, requestedParallelStarts),
  );
  let started = 0;
  let skipped = 0;
  let failed = 0;
  let nextIndex = 0;
  const runWorker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      const project = projects[index];
      if (!project) return;
      const result = await recoverProjectAfterHostRestart({
        project,
        host_id,
        host_boot_id,
      });
      if (result === "started") {
        started += 1;
      } else if (result === "skipped") {
        skipped += 1;
      } else {
        failed += 1;
      }
    }
  };
  await Promise.all(
    Array.from({ length: parallelStarts }, async () => await runWorker()),
  );
  await updateHostRestartRecoveryMetadata({
    host_id,
    patch: {
      status: (failed > 0
        ? "failed"
        : "finished") satisfies HostRestartRecoveryMetadataStatus,
      host_boot_id,
      previous_host_boot_id,
      previous_host_session_id,
      host_session_id,
      source,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      total: projects.length,
      parallel_starts: parallelStarts,
      started,
      skipped,
      failed,
    },
  });
  logger.info("host restart recovery finished", {
    host_id,
    host_boot_id,
    previous_host_boot_id,
    source,
    total: projects.length,
    parallel_starts: parallelStarts,
    started,
    skipped,
    failed,
  });
}

async function ensureHostRestartRecovery({
  host_id,
  previous_metadata,
  previous_session_id,
  next_session_id,
  previous_boot_id,
  next_boot_id,
  source,
}: {
  host_id: string;
  previous_metadata?: any;
  previous_session_id?: string;
  next_session_id?: string;
  previous_boot_id?: string;
  next_boot_id?: string;
  source: "register" | "heartbeat";
}): Promise<void> {
  const bootChanged =
    !!previous_boot_id && !!next_boot_id && previous_boot_id !== next_boot_id;
  const pending = isRestartRecoveryPendingForBoot(
    previous_metadata,
    next_boot_id,
  );
  if (!bootChanged && !pending) {
    return;
  }
  const key = recoveryInflightKey(host_id, next_boot_id);
  if (hostRestartRecoveryInflight.has(key)) {
    return;
  }
  await updateHostRestartRecoveryMetadata({
    host_id,
    patch: {
      status: "queued" satisfies HostRestartRecoveryMetadataStatus,
      host_boot_id: next_boot_id,
      previous_host_boot_id: previous_boot_id,
      previous_host_session_id: previous_session_id,
      host_session_id: next_session_id,
      source,
      queued_at: new Date().toISOString(),
    },
  });
  if (process.env.NODE_ENV === "test") {
    return;
  }
  const task = (async () => {
    if (HOST_RESTART_RECOVERY_SCHEDULE_DELAY_MS > 0) {
      await sleep(HOST_RESTART_RECOVERY_SCHEDULE_DELAY_MS);
    }
    await startHostRestartRecoveryForHost({
      host_id,
      host_boot_id: next_boot_id,
      previous_host_boot_id: previous_boot_id,
      previous_host_session_id: previous_session_id,
      host_session_id: next_session_id,
      source,
    });
  })();
  hostRestartRecoveryInflight.set(key, task);
  task
    .catch(async (err) => {
      logger.warn("host restart recovery failed", {
        host_id,
        host_boot_id: next_boot_id,
        source,
        err: `${err}`,
      });
      await updateHostRestartRecoveryMetadata({
        host_id,
        patch: {
          status: "failed" satisfies HostRestartRecoveryMetadataStatus,
          host_boot_id: next_boot_id,
          previous_host_boot_id: previous_boot_id,
          previous_host_session_id: previous_session_id,
          host_session_id: next_session_id,
          source,
          failed_at: new Date().toISOString(),
          error: `${err}`.slice(0, 1000),
        },
      }).catch((metadataErr) => {
        logger.warn("failed to record host restart recovery failure", {
          host_id,
          host_boot_id: next_boot_id,
          err: `${metadataErr}`,
        });
      });
    })
    .finally(() => {
      if (hostRestartRecoveryInflight.get(key) === task) {
        hostRestartRecoveryInflight.delete(key);
      }
    });
}

export async function initHostRegistryService() {
  logger.info("starting host registry service");
  const client = conat();
  const loadCurrentStatus = async (id: string): Promise<string | undefined> => {
    const { rows } = await pool().query(
      "SELECT status FROM project_hosts WHERE id=$1 AND deleted IS NULL",
      [id],
    );
    return rows[0]?.status;
  };
  const resolveLocalSelfHost = async (
    info: HostRegistration,
  ): Promise<boolean> => {
    const machineFromInfo = info?.metadata?.machine ?? {};
    if (machineFromInfo?.cloud) {
      const selfHostMode = machineFromInfo?.metadata?.self_host_mode;
      const effectiveSelfHostMode =
        machineFromInfo?.cloud === "self-host" && !selfHostMode
          ? "local"
          : selfHostMode;
      return (
        machineFromInfo?.cloud === "self-host" &&
        effectiveSelfHostMode === "local"
      );
    }
    const { rows } = await pool().query(
      "SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
      [info.id],
    );
    const machine = rows[0]?.metadata?.machine ?? {};
    const selfHostMode = machine?.metadata?.self_host_mode;
    const effectiveSelfHostMode =
      machine?.cloud === "self-host" && !selfHostMode ? "local" : selfHostMode;
    return machine?.cloud === "self-host" && effectiveSelfHostMode === "local";
  };
  const publishKey = async (info: HostRegistration) => {
    if (!info?.id) return;
    try {
      await client.publish(`${SUBJECT}.keys`, {
        id: info.id,
        sshpiperd_public_key: info.sshpiperd_public_key,
        project_host_auth_public_key: getProjectHostAuthTokenPublicKey(),
      });
    } catch (err) {
      logger.warn("failed to publish host ssh key", { err, id: info.id });
    }
  };
  const updatePendingAutomaticConvergenceRetry = async ({
    host_id,
    runtime,
    artifacts,
  }: {
    host_id: string;
    runtime: boolean;
    artifacts: boolean;
  }) => {
    const { rows } = await pool().query<{ metadata?: any }>(
      "SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
      [host_id],
    );
    const metadata = rows[0]?.metadata ?? {};
    const runtimeDeployments = { ...(metadata?.runtime_deployments ?? {}) };
    if (runtime || artifacts) {
      runtimeDeployments.pending_automatic_convergence_retry = {
        ...(runtime ? { runtime: true } : {}),
        ...(artifacts ? { artifacts: true } : {}),
        updated_at: new Date().toISOString(),
      };
    } else {
      delete runtimeDeployments.pending_automatic_convergence_retry;
    }
    const nextMetadata = {
      ...metadata,
      runtime_deployments: runtimeDeployments,
    };
    await pool().query(
      "UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1 AND deleted IS NULL",
      [host_id, nextMetadata],
    );
  };
  const attemptAutomaticConvergence = async ({
    host_id,
    reason,
    retryOnlyPending,
  }: {
    host_id: string;
    reason: string;
    retryOnlyPending?: boolean;
  }) => {
    let pending = {
      runtime: true,
      artifacts: true,
    };
    if (retryOnlyPending) {
      const { rows } = await pool().query<{ metadata?: any }>(
        "SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        [host_id],
      );
      pending = getPendingAutomaticConvergenceRetry(rows[0]?.metadata);
      if (!pending.runtime && !pending.artifacts) {
        return;
      }
    }
    let nextRuntimePending = false;
    let nextArtifactsPending = false;
    if (pending.runtime) {
      try {
        const result = await ensureAutomaticHostRuntimeDeploymentsReconcile({
          host_id,
          reason,
        });
        nextRuntimePending =
          !result.queued && result.reason === "observation_failed";
      } catch (err) {
        nextRuntimePending = true;
        logger.warn("automatic runtime deployment reconcile failed", {
          host_id,
          source: reason,
          err: `${err}`,
        });
      }
    }
    if (pending.artifacts) {
      try {
        const result = await ensureAutomaticHostArtifactDeploymentsReconcile({
          host_id,
        });
        nextArtifactsPending =
          !result.queued && result.reason === "observation_failed";
      } catch (err) {
        nextArtifactsPending = true;
        logger.warn("automatic artifact deployment reconcile failed", {
          host_id,
          source: reason,
          err: `${err}`,
        });
      }
    }
    await updatePendingAutomaticConvergenceRetry({
      host_id,
      runtime: nextRuntimePending,
      artifacts: nextArtifactsPending,
    });
  };
  return await createHostRegistryService({
    client,
    impl: {
      async register(info: HostRegistration) {
        if (!info?.id) {
          throw Error("register: id is required");
        }
        logger.debug("register", {
          id: info.id,
          region: info.region,
          url: info.public_url,
        });
        const currentStatus = await loadCurrentStatus(info.id);
        if (
          currentStatus &&
          // During cloud startup, register is the readiness signal. Accepting
          // it immediately upserts status=running and last_seen below.
          !["running", "active", "starting", "restarting"].includes(
            String(currentStatus),
          )
        ) {
          logger.debug("register ignored (status)", {
            id: info.id,
            status: currentStatus,
          });
          return;
        }
        const isLocalSelfHost = await resolveLocalSelfHost(info);
        const sanitized = isLocalSelfHost
          ? { ...info, public_url: undefined, internal_url: undefined }
          : info;
        logger.debug("register host urls", {
          id: info.id,
          isLocalSelfHost,
          public_url: sanitized.public_url,
          internal_url: sanitized.internal_url,
        });
        const { rows: previousRows } = await pool().query<{
          metadata: any;
          bay_id?: string | null;
        }>(
          "SELECT metadata, bay_id FROM project_hosts WHERE id=$1 AND deleted IS NULL",
          [info.id],
        );
        const registryBayId = registryBayIdForHeartbeat(
          previousRows[0]?.bay_id,
        );
        const previousSessionId = getHostSessionId(previousRows[0]?.metadata);
        const previousBootId = getHostBootId(previousRows[0]?.metadata);
        const nextSessionId = getHostSessionId(sanitized.metadata);
        const nextBootId = getHostBootId(sanitized.metadata);
        await upsertProjectHost({
          ...sanitized,
          bay_id: registryBayId,
          status: "running",
          last_seen: new Date(),
          host_session_id: nextSessionId,
        });
        await ensureHostRestartRecovery({
          host_id: info.id,
          previous_metadata: previousRows[0]?.metadata,
          previous_session_id: previousSessionId,
          next_session_id: nextSessionId,
          previous_boot_id: previousBootId,
          next_boot_id: nextBootId,
          source: "register",
        });
        if (previousRows[0] && previousSessionId !== nextSessionId) {
          await notifyProjectHostUpdate({ host_id: info.id });
        }
        await attemptAutomaticConvergence({
          host_id: info.id,
          reason: "host_register",
        });
        await publishKey(info);
      },
      async heartbeat(info: HostRegistration) {
        if (!info?.id) {
          throw Error("heartbeat: id is required");
        }
        logger.silly?.("heartbeat", { id: info.id, status: info.status });
        const currentStatus = await loadCurrentStatus(info.id);
        if (
          currentStatus &&
          !["running", "active", "starting", "restarting"].includes(
            String(currentStatus),
          )
        ) {
          logger.debug("heartbeat ignored (status)", {
            id: info.id,
            status: currentStatus,
          });
          return;
        }
        const isLocalSelfHost = await resolveLocalSelfHost(info);
        const sanitized = isLocalSelfHost
          ? { ...info, public_url: undefined, internal_url: undefined }
          : info;
        const { rows: previousRows } = await pool().query<{
          metadata: any;
          bay_id?: string | null;
        }>(
          "SELECT metadata, bay_id FROM project_hosts WHERE id=$1 AND deleted IS NULL",
          [info.id],
        );
        const registryBayId = registryBayIdForHeartbeat(
          previousRows[0]?.bay_id,
        );
        const previousSessionId = getHostSessionId(previousRows[0]?.metadata);
        const previousBootId = getHostBootId(previousRows[0]?.metadata);
        const nextSessionId = getHostSessionId(sanitized.metadata);
        const nextBootId = getHostBootId(sanitized.metadata);
        await upsertProjectHost({
          ...sanitized,
          bay_id: registryBayId,
          status: "running",
          last_seen: new Date(),
          host_session_id: nextSessionId,
        });
        await ensureHostRestartRecovery({
          host_id: info.id,
          previous_metadata: previousRows[0]?.metadata,
          previous_session_id: previousSessionId,
          next_session_id: nextSessionId,
          previous_boot_id: previousBootId,
          next_boot_id: nextBootId,
          source: "heartbeat",
        });
        await attemptAutomaticConvergence({
          host_id: info.id,
          reason: "host_heartbeat_retry",
          retryOnlyPending: true,
        });
        await publishKey(info);
      },
      async shutdownNotice(opts) {
        const host_id = `${opts?.host_id ?? ""}`.trim();
        if (!host_id) {
          throw Error("shutdownNotice: host_id is required");
        }
        const announcedSessionId = `${opts?.host_session_id ?? ""}`.trim();
        const { rows } = await pool().query<{
          status?: string;
          metadata?: any;
        }>(
          "SELECT status, metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
          [host_id],
        );
        const row = rows[0];
        if (!row) {
          logger.debug("shutdown notice ignored (missing host)", { host_id });
          return;
        }
        const currentSessionId = getHostSessionId(row.metadata);
        if (
          announcedSessionId &&
          currentSessionId &&
          announcedSessionId !== currentSessionId
        ) {
          logger.debug("shutdown notice ignored (stale session)", {
            host_id,
            announcedSessionId,
            currentSessionId,
          });
          return;
        }
        const notice = {
          at: new Date().toISOString(),
          signal:
            typeof opts?.signal === "string" && opts.signal.trim()
              ? opts.signal.trim()
              : undefined,
          reason:
            typeof opts?.reason === "string" && opts.reason.trim()
              ? opts.reason.trim()
              : undefined,
          host_session_id: currentSessionId ?? announcedSessionId ?? undefined,
        };
        const nextMetadata = {
          ...(row.metadata ?? {}),
          shutdown_notice: notice,
        };
        await pool().query(
          "UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1 AND deleted IS NULL",
          [host_id, nextMetadata],
        );
        if (
          !shouldAutoRestoreInterruptedSpotHost({
            status: row.status,
            metadata: nextMetadata,
          })
        ) {
          logger.debug("shutdown notice recorded without auto-restore", {
            host_id,
            status: row.status,
            signal: notice.signal,
            reason: notice.reason,
          });
          return;
        }
        const enqueued = await enqueueCloudVmWorkOnce({
          vm_id: host_id,
          action: "start",
          payload: {
            source: "shutdown_notice",
            signal: notice.signal,
            reason: notice.reason,
          },
        });
        logger.info("processed shutdown notice for spot host", {
          host_id,
          signal: notice.signal,
          reason: notice.reason,
          enqueued,
        });
      },
      async getProjectHostAuthPublicKey() {
        return {
          project_host_auth_public_key: getProjectHostAuthTokenPublicKey(),
        };
      },
      async listProjectUserDeltas(opts) {
        const host_id = `${opts?.host_id ?? ""}`.trim();
        if (!host_id) {
          throw Error("listProjectUserDeltas: host_id is required");
        }
        const since_ms = Math.max(0, Number(opts?.since_ms ?? 0));
        const limit = Math.max(
          1,
          Math.min(2000, Number(opts?.limit ?? 500) || 500),
        );
        const { rows } = await pool().query<{
          project_id: string;
          users: any;
          updated_ms: number;
        }>(
          `
            SELECT
              project_id,
              COALESCE(users, '{}'::jsonb) AS users,
              FLOOR(EXTRACT(EPOCH FROM COALESCE(last_edited, created, to_timestamp(0))) * 1000)::bigint AS updated_ms
            FROM projects
            WHERE host_id=$1
              AND deleted IS NOT TRUE
              AND FLOOR(EXTRACT(EPOCH FROM COALESCE(last_edited, created, to_timestamp(0))) * 1000)::bigint > $2
            ORDER BY COALESCE(last_edited, created, to_timestamp(0)) ASC
            LIMIT $3
          `,
          [host_id, since_ms, limit],
        );
        let next_since_ms = since_ms;
        for (const row of rows) {
          next_since_ms = Math.max(next_since_ms, Number(row.updated_ms || 0));
        }
        return {
          rows,
          next_since_ms,
          has_more: rows.length >= limit,
        };
      },
      async listProjectUserReconcile(opts) {
        const host_id = `${opts?.host_id ?? ""}`.trim();
        if (!host_id) {
          throw Error("listProjectUserReconcile: host_id is required");
        }
        const limit = Math.max(
          1,
          Math.min(5000, Number(opts?.limit ?? 2000) || 2000),
        );
        const recent_days = Math.max(
          1,
          Math.min(90, Number(opts?.recent_days ?? 7) || 7),
        );
        const { rows } = await pool().query<{
          project_id: string;
          users: any;
          updated_ms: number;
        }>(
          `
            SELECT
              project_id,
              COALESCE(users, '{}'::jsonb) AS users,
              FLOOR(EXTRACT(EPOCH FROM COALESCE(last_edited, created, to_timestamp(0))) * 1000)::bigint AS updated_ms
            FROM projects
            WHERE host_id=$1
              AND deleted IS NOT TRUE
              AND (
                COALESCE(state ->> 'state', '') IN ('running', 'starting')
                OR COALESCE(last_edited, to_timestamp(0)) > NOW() - ($2 || ' days')::interval
              )
            ORDER BY COALESCE(last_edited, created, to_timestamp(0)) DESC
            LIMIT $3
          `,
          [host_id, `${recent_days}`, limit],
        );
        return {
          rows,
          as_of_ms: Date.now(),
          has_more: rows.length >= limit,
        };
      },
      async listProjectStopPolicyDeltas(opts) {
        const host_id = `${opts?.host_id ?? ""}`.trim();
        if (!host_id) {
          throw Error("listProjectStopPolicyDeltas: host_id is required");
        }
        const since_ms = Math.max(0, Number(opts?.since_ms ?? 0));
        const limit = Math.max(
          1,
          Math.min(2000, Number(opts?.limit ?? 500) || 500),
        );
        const { rows } = await pool().query<StopPolicyBaseRow>(
          `
            SELECT
              project_id,
              (
                SELECT account_id_text::text
                FROM jsonb_each(COALESCE(users, '{}'::jsonb)) AS u(account_id_text, user_data)
                WHERE COALESCE(u.user_data ->> 'group', '') = 'owner'
                LIMIT 1
              ) AS owner_account_id,
              FLOOR(EXTRACT(EPOCH FROM COALESCE(last_edited, created, to_timestamp(0))) * 1000)::bigint AS authoritative_last_edited_ms,
              FLOOR(EXTRACT(EPOCH FROM COALESCE(last_edited, created, to_timestamp(0))) * 1000)::bigint AS policy_updated_ms
            FROM projects
            WHERE host_id=$1
              AND deleted IS NOT TRUE
              AND FLOOR(EXTRACT(EPOCH FROM COALESCE(last_edited, created, to_timestamp(0))) * 1000)::bigint > $2
            ORDER BY COALESCE(last_edited, created, to_timestamp(0)) ASC
            LIMIT $3
          `,
          [host_id, since_ms, limit],
        );
        let next_since_ms = since_ms;
        for (const row of rows) {
          next_since_ms = Math.max(
            next_since_ms,
            Number(row.policy_updated_ms ?? 0) || 0,
          );
        }
        return {
          rows: await hydrateStopPolicyRows(rows),
          next_since_ms,
          has_more: rows.length >= limit,
        };
      },
      async listProjectStopPolicyReconcile(opts) {
        const host_id = `${opts?.host_id ?? ""}`.trim();
        if (!host_id) {
          throw Error("listProjectStopPolicyReconcile: host_id is required");
        }
        const limit = Math.max(
          1,
          Math.min(5000, Number(opts?.limit ?? 2000) || 2000),
        );
        const recent_days = Math.max(
          1,
          Math.min(90, Number(opts?.recent_days ?? 7) || 7),
        );
        const { rows } = await pool().query<StopPolicyBaseRow>(
          `
            SELECT
              project_id,
              (
                SELECT account_id_text::text
                FROM jsonb_each(COALESCE(users, '{}'::jsonb)) AS u(account_id_text, user_data)
                WHERE COALESCE(u.user_data ->> 'group', '') = 'owner'
                LIMIT 1
              ) AS owner_account_id,
              FLOOR(EXTRACT(EPOCH FROM COALESCE(last_edited, created, to_timestamp(0))) * 1000)::bigint AS authoritative_last_edited_ms,
              FLOOR(EXTRACT(EPOCH FROM COALESCE(last_edited, created, to_timestamp(0))) * 1000)::bigint AS policy_updated_ms
            FROM projects
            WHERE host_id=$1
              AND deleted IS NOT TRUE
              AND (
                COALESCE(state ->> 'state', '') IN ('running', 'starting')
                OR COALESCE(last_edited, to_timestamp(0)) > NOW() - ($2 || ' days')::interval
              )
            ORDER BY COALESCE(last_edited, created, to_timestamp(0)) DESC
            LIMIT $3
          `,
          [host_id, `${recent_days}`, limit],
        );
        return {
          rows: await hydrateStopPolicyRows(rows),
          as_of_ms: Date.now(),
          has_more: rows.length >= limit,
        };
      },
      async reportProjectPressureAction(opts) {
        const host_id = `${opts?.host_id ?? ""}`.trim();
        const project_id = `${opts?.project_id ?? ""}`.trim();
        const reason = `${opts?.reason ?? ""}`.trim();
        const action_status =
          opts?.action_status === "stop_failed" ? "stop_failed" : "stopped";
        const pressure_zone = `${opts?.pressure_zone ?? ""}`.trim();
        if (!host_id || !project_id || !reason || !pressure_zone) {
          throw Error(
            "reportProjectPressureAction: host_id, project_id, pressure_zone, and reason are required",
          );
        }
        const occurred_at_ms =
          Math.max(0, Number(opts?.occurred_at_ms ?? 0)) || Date.now();
        const host_name = `${opts?.host_name ?? ""}`.trim() || undefined;
        const trigger = `${opts?.trigger ?? ""}`.trim() || undefined;
        const candidate_count = Number(opts?.candidate_count);
        const memory_used_percent = Number(opts?.memory_used_percent);
        const memory_available_bytes = Number(opts?.memory_available_bytes);
        const event =
          action_status === "stopped"
            ? "project_pressure_stopped"
            : "project_pressure_stop_failed";
        const row = {
          id: `project-pressure:${host_id}:${project_id}:${occurred_at_ms}:${event}`,
          project_id,
          account_id: null,
          time: new Date(occurred_at_ms),
          event: {
            event,
            pressure_zone,
            reason,
            source_host_id: host_id,
            ...(host_name ? { source_host_name: host_name } : {}),
            ...(trigger ? { trigger } : {}),
            ...(Number.isFinite(candidate_count) && candidate_count >= 0
              ? { candidate_count: Math.floor(candidate_count) }
              : {}),
            ...(Number.isFinite(memory_used_percent)
              ? { memory_used_percent }
              : {}),
            ...(Number.isFinite(memory_available_bytes)
              ? { memory_available_bytes }
              : {}),
          },
        };
        const logged = await appendProjectLogRowBestEffort({
          project_id,
          row,
          fresh: true,
          context: "host_pressure",
        });
        return { logged };
      },
      async getMasterConatTokenStatus(opts) {
        const host_id = `${opts?.host_id ?? ""}`.trim();
        const currentToken = `${opts?.current_token ?? ""}`.trim();
        if (!host_id || !currentToken) {
          throw Error(
            "getMasterConatTokenStatus: host_id and current_token are required",
          );
        }
        const info = await verifyProjectHostToken(currentToken, {
          purpose: "master-conat",
        });
        if (!info || info.host_id !== host_id) {
          throw Error(
            "getMasterConatTokenStatus: token is invalid for this host",
          );
        }
        return {
          expires_at: info.expires.toISOString(),
        };
      },
      async rotateMasterConatToken(opts) {
        const host_id = `${opts?.host_id ?? ""}`.trim();
        if (!host_id) {
          throw Error("rotateMasterConatToken: host_id is required");
        }
        const currentToken = `${opts?.current_token ?? ""}`.trim();
        const bootstrapToken = `${opts?.bootstrap_token ?? ""}`.trim();
        if (!currentToken && !bootstrapToken) {
          throw Error(
            "rotateMasterConatToken: current_token or bootstrap_token is required",
          );
        }
        const currentInfo = currentToken
          ? await verifyProjectHostToken(currentToken, {
              purpose: "master-conat",
            })
          : null;
        const bootstrapInfo = bootstrapToken
          ? await verifyProjectHostToken(bootstrapToken, {
              purpose: "bootstrap",
            })
          : null;
        const info = currentInfo ?? bootstrapInfo;
        if (!info || info.host_id !== host_id) {
          throw Error("rotateMasterConatToken: token is invalid for host");
        }
        const issued = await createProjectHostMasterConatToken(host_id, {
          ttlMs: 1000 * 60 * 60 * 24 * 365, // 1 year
        });
        return { master_conat_token: issued.token };
      },
    },
  });
}
