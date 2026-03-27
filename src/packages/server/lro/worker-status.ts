import getPool from "@cocalc/database/pool";
import {
  type ParallelOpsConfigSource,
  type ParallelOpsLimitSnapshot,
  type ParallelOpsScopeModel,
  type ParallelOpsWorkerCategory,
  type ParallelOpsWorkerRegistration,
  parallelOpsLroKindToWorkerKind,
  parallelOpsWorkerRegistry,
  parallelOpsWorkerRegistryByKind,
} from "./worker-registry";
import {
  getEffectiveParallelOpsLimit,
  getEffectiveParallelOpsLimits,
} from "./worker-config";
import {
  listHostLocalBackupStatuses,
  type HostLocalBackupStatusRow,
} from "@cocalc/server/projects/backup-host-status";

const pool = () => getPool();

type LroStatusRow = {
  kind: string;
  status: string;
  owner_id: string | null;
  heartbeat_at: Date | null;
  created_at: Date | null;
};

type CloudVmWorkStatusRow = {
  state: string;
  locked_by: string | null;
  locked_at: Date | null;
  created_at: Date | null;
  payload: { provider?: string } | null;
};

type MoveTopologyStatusRow = {
  status: string;
  owner_id: string | null;
  heartbeat_at: Date | null;
  created_at: Date | null;
  source_host_id: string | null;
  dest_host_id: string | null;
};

const MOVE_SOURCE_HOST_WORKER_KIND = "project-move-source-host";
const MOVE_DESTINATION_HOST_WORKER_KIND = "project-move-destination-host";
const ROOTFS_PUBLISH_HOST_WORKER_KIND = "project-rootfs-publish-host";

type RootfsPublishHostStatusRow = {
  status: string;
  owner_id: string | null;
  heartbeat_at: Date | null;
  created_at: Date | null;
  project_host_id: string | null;
};

function getDateMs(value?: Date | null): number | null {
  if (value == null) return null;
  const ms = value.getTime();
  return Number.isFinite(ms) ? ms : null;
}

export interface ParallelOpsWorkerOwnerStatus {
  owner_id: string;
  active_count: number;
  stale_count: number;
}

export interface ParallelOpsWorkerBreakdownStatus {
  key: string;
  queued_count: number;
  running_count: number;
  limit?: number | null;
  extra?: Record<string, number>;
}

export interface ParallelOpsWorkerStatus {
  worker_kind: string;
  category: ParallelOpsWorkerCategory;
  scope_model: ParallelOpsScopeModel;
  dynamic_limit_supported: boolean;
  default_limit: number | null;
  configured_limit: number | null;
  effective_limit: number | null;
  config_source: ParallelOpsConfigSource;
  extra_limits?: Record<string, number>;
  queued_count: number;
  running_count: number;
  stale_running_count: number | null;
  oldest_queued_ms: number | null;
  worker_instances: number;
  owners: ParallelOpsWorkerOwnerStatus[];
  breakdown: ParallelOpsWorkerBreakdownStatus[];
  notes: string[];
}

function baseStatusForWorker(
  worker: ParallelOpsWorkerRegistration,
  limit: ParallelOpsLimitSnapshot,
): ParallelOpsWorkerStatus {
  return {
    worker_kind: worker.worker_kind,
    category: worker.category,
    scope_model: worker.scope_model,
    dynamic_limit_supported: worker.dynamic_limit_supported,
    default_limit: limit.default_limit,
    configured_limit: limit.configured_limit,
    effective_limit: limit.effective_limit,
    config_source: limit.config_source,
    ...(limit.extra_limits ? { extra_limits: limit.extra_limits } : {}),
    queued_count: 0,
    running_count: 0,
    stale_running_count: 0,
    oldest_queued_ms: null,
    worker_instances: 0,
    owners: [],
    breakdown: [],
    notes: [...(worker.notes ?? [])],
  };
}

async function resolveLimitSnapshot(
  worker: ParallelOpsWorkerRegistration,
): Promise<ParallelOpsLimitSnapshot> {
  const base = worker.getLimitSnapshot();
  if (base.effective_limit == null) {
    return base;
  }
  if (
    worker.scope_model !== "global" &&
    worker.scope_model !== "per-provider"
  ) {
    return base;
  }
  const { value, source } = await getEffectiveParallelOpsLimit({
    worker_kind: worker.worker_kind,
    default_limit: base.effective_limit,
  });
  return {
    ...base,
    configured_limit:
      source === "db-override" ? value : (base.configured_limit ?? null),
    effective_limit: value,
    config_source:
      source === "db-override"
        ? "db-override"
        : source === "env-debug-cap"
          ? "env-debug-cap"
          : base.config_source,
  };
}

export function summarizeLroWorkerStatus({
  worker,
  rows,
  nowMs,
  limit,
}: {
  worker: ParallelOpsWorkerRegistration;
  rows: LroStatusRow[];
  nowMs: number;
  limit?: ParallelOpsLimitSnapshot;
}): ParallelOpsWorkerStatus {
  const status = baseStatusForWorker(
    worker,
    limit ?? worker.getLimitSnapshot(),
  );
  const staleCutoffMs =
    worker.lease_ms != null
      ? nowMs - worker.lease_ms
      : Number.NEGATIVE_INFINITY;
  let oldestQueuedMs: number | null = null;
  const owners = new Map<string, ParallelOpsWorkerOwnerStatus>();

  for (const row of rows) {
    if (row.status === "queued") {
      status.queued_count += 1;
      const createdAtMs = getDateMs(row.created_at);
      if (createdAtMs != null) {
        const ageMs = Math.max(0, nowMs - createdAtMs);
        oldestQueuedMs =
          oldestQueuedMs == null ? ageMs : Math.max(oldestQueuedMs, ageMs);
      }
      continue;
    }
    if (row.status !== "running") continue;

    status.running_count += 1;
    const stale =
      row.heartbeat_at == null || row.heartbeat_at.getTime() < staleCutoffMs;
    if (stale) {
      status.stale_running_count = (status.stale_running_count ?? 0) + 1;
    }
    if (!row.owner_id) continue;
    const owner = owners.get(row.owner_id) ?? {
      owner_id: row.owner_id,
      active_count: 0,
      stale_count: 0,
    };
    owner.active_count += 1;
    if (stale) owner.stale_count += 1;
    owners.set(row.owner_id, owner);
  }

  status.oldest_queued_ms = oldestQueuedMs;
  status.owners = Array.from(owners.values()).sort((a, b) =>
    a.owner_id.localeCompare(b.owner_id),
  );
  status.worker_instances = status.owners.length;
  return status;
}

export function summarizeCloudVmWorkStatus({
  worker,
  rows,
  nowMs,
  limit,
  providerLimits,
}: {
  worker: ParallelOpsWorkerRegistration;
  rows: CloudVmWorkStatusRow[];
  nowMs: number;
  limit?: ParallelOpsLimitSnapshot;
  providerLimits: Map<string, { value: number; source: string }>;
}): ParallelOpsWorkerStatus {
  const status = baseStatusForWorker(
    worker,
    limit ?? worker.getLimitSnapshot(),
  );
  status.stale_running_count = null;
  status.notes.push(
    "Cloud VM work does not currently expose lease reclaim or stale-running semantics.",
  );
  let oldestQueuedMs: number | null = null;
  const owners = new Map<string, ParallelOpsWorkerOwnerStatus>();
  const breakdown = new Map<string, ParallelOpsWorkerBreakdownStatus>();
  const defaultProviderLimit =
    limit?.extra_limits?.per_provider_limit ??
    worker.getLimitSnapshot().extra_limits?.per_provider_limit ??
    null;
  let hasProviderOverride = false;

  for (const row of rows) {
    const provider = `${row.payload?.provider ?? "unknown"}`;
    const entry = breakdown.get(provider) ?? {
      key: provider,
      queued_count: 0,
      running_count: 0,
    };
    if (row.state === "queued") {
      status.queued_count += 1;
      entry.queued_count += 1;
      const createdAtMs = getDateMs(row.created_at);
      if (createdAtMs != null) {
        const ageMs = Math.max(0, nowMs - createdAtMs);
        oldestQueuedMs =
          oldestQueuedMs == null ? ageMs : Math.max(oldestQueuedMs, ageMs);
      }
    } else if (row.state === "in_progress") {
      status.running_count += 1;
      entry.running_count += 1;
      if (row.locked_by) {
        const owner = owners.get(row.locked_by) ?? {
          owner_id: row.locked_by,
          active_count: 0,
          stale_count: 0,
        };
        owner.active_count += 1;
        owners.set(row.locked_by, owner);
      }
    }
    breakdown.set(provider, entry);
  }

  status.oldest_queued_ms = oldestQueuedMs;
  status.owners = Array.from(owners.values()).sort((a, b) =>
    a.owner_id.localeCompare(b.owner_id),
  );
  status.worker_instances = status.owners.length;
  status.breakdown = Array.from(breakdown.values())
    .map((entry) => {
      const limitEntry = providerLimits.get(entry.key);
      if (limitEntry?.source === "db-override") {
        hasProviderOverride = true;
      } else if (limitEntry?.source === "env-debug-cap") {
        status.config_source = "env-debug-cap";
      }
      return {
        ...entry,
        limit: limitEntry?.value ?? defaultProviderLimit,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
  const uniqueLimits = Array.from(
    new Set(
      status.breakdown
        .map(({ limit }) => limit)
        .filter((entry) => entry != null),
    ),
  );
  if (uniqueLimits.length > 1) {
    status.notes.push("Providers currently report mixed cloud VM work limits.");
  }
  if (hasProviderOverride) {
    status.config_source = "db-override";
  }
  return status;
}

export function summarizeHostLocalBackupStatus({
  worker,
  rows,
  unreachable_hosts,
}: {
  worker: ParallelOpsWorkerRegistration;
  rows: HostLocalBackupStatusRow[];
  unreachable_hosts: number;
}): ParallelOpsWorkerStatus {
  const status = baseStatusForWorker(worker, worker.getLimitSnapshot());
  status.stale_running_count = null;
  status.worker_instances = rows.length;
  status.running_count = rows.reduce((sum, row) => sum + row.in_flight, 0);
  status.queued_count = rows.reduce((sum, row) => sum + row.queued, 0);
  status.breakdown = rows
    .map((row) => ({
      key: row.host_id,
      queued_count: row.queued,
      running_count: row.in_flight,
      limit: row.max_parallel,
      extra: {
        project_lock_count: row.project_lock_count,
      },
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const uniqueLimits = Array.from(new Set(rows.map((row) => row.max_parallel)));
  if (uniqueLimits.length === 1) {
    status.configured_limit = uniqueLimits[0];
    status.effective_limit = uniqueLimits[0];
  } else if (uniqueLimits.length > 1) {
    status.configured_limit = null;
    status.effective_limit = null;
    status.notes.push(
      "Reachable project-hosts currently report mixed backup slot limits.",
    );
  }
  if (unreachable_hosts > 0) {
    status.notes.push(
      `${unreachable_hosts} recent running project-hosts did not answer backup execution status requests.`,
    );
  }
  return status;
}

export function summarizeMoveRoleWorkerStatus({
  worker,
  rows,
  role,
  nowMs,
  limit,
  limitByHost,
}: {
  worker: ParallelOpsWorkerRegistration;
  rows: MoveTopologyStatusRow[];
  role: "source" | "destination";
  nowMs: number;
  limit?: ParallelOpsLimitSnapshot;
  limitByHost: Map<string, { value: number; source: string }>;
}): ParallelOpsWorkerStatus {
  const status = baseStatusForWorker(
    worker,
    limit ?? worker.getLimitSnapshot(),
  );
  const staleCutoffMs =
    worker.lease_ms != null
      ? nowMs - worker.lease_ms
      : Number.NEGATIVE_INFINITY;
  let oldestQueuedMs: number | null = null;
  const owners = new Map<string, ParallelOpsWorkerOwnerStatus>();
  const breakdown = new Map<string, ParallelOpsWorkerBreakdownStatus>();
  let hasDbOverride = false;
  let hasUnknownHost = false;
  let hasUnassignedDestination = false;

  for (const row of rows) {
    const host_id =
      role === "source"
        ? row.source_host_id
        : (row.dest_host_id ?? (row.status === "queued" ? "unassigned" : null));
    if (!host_id) {
      hasUnknownHost = true;
      continue;
    }
    if (host_id === "unassigned") {
      hasUnassignedDestination = true;
    }
    const entry = breakdown.get(host_id) ?? {
      key: host_id,
      queued_count: 0,
      running_count: 0,
    };
    if (row.status === "queued") {
      status.queued_count += 1;
      entry.queued_count += 1;
      const createdAtMs = getDateMs(row.created_at);
      if (createdAtMs != null) {
        const ageMs = Math.max(0, nowMs - createdAtMs);
        oldestQueuedMs =
          oldestQueuedMs == null ? ageMs : Math.max(oldestQueuedMs, ageMs);
      }
    } else if (row.status === "running") {
      status.running_count += 1;
      entry.running_count += 1;
      const stale =
        row.heartbeat_at == null || row.heartbeat_at.getTime() < staleCutoffMs;
      if (stale) {
        status.stale_running_count = (status.stale_running_count ?? 0) + 1;
      }
      if (row.owner_id) {
        const owner = owners.get(row.owner_id) ?? {
          owner_id: row.owner_id,
          active_count: 0,
          stale_count: 0,
        };
        owner.active_count += 1;
        if (stale) {
          owner.stale_count += 1;
        }
        owners.set(row.owner_id, owner);
      }
    }
    breakdown.set(host_id, entry);
  }

  status.oldest_queued_ms = oldestQueuedMs;
  status.owners = Array.from(owners.values()).sort((a, b) =>
    a.owner_id.localeCompare(b.owner_id),
  );
  status.worker_instances = status.owners.length;
  status.breakdown = Array.from(breakdown.values())
    .map((entry) => {
      if (entry.key === "unassigned") {
        return { ...entry, limit: null };
      }
      const limitEntry = limitByHost.get(entry.key);
      if (limitEntry?.source === "db-override") {
        hasDbOverride = true;
      } else if (limitEntry?.source === "env-debug-cap") {
        status.config_source = "env-debug-cap";
      }
      return {
        ...entry,
        limit: limitEntry?.value ?? null,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));

  const uniqueLimits = Array.from(
    new Set(
      status.breakdown
        .map(({ limit }) => limit)
        .filter((limit) => limit != null),
    ),
  );
  if (uniqueLimits.length === 1) {
    status.configured_limit = uniqueLimits[0] ?? null;
    status.effective_limit = uniqueLimits[0] ?? null;
  } else if (uniqueLimits.length > 1) {
    status.configured_limit = null;
    status.effective_limit = null;
    status.notes.push("Hosts currently report mixed move-admission limits.");
  }
  if (hasDbOverride) {
    status.config_source = "db-override";
  }
  if (hasUnassignedDestination) {
    status.notes.push(
      "Queued moves without a selected destination are tracked under the 'unassigned' breakdown key.",
    );
  }
  if (hasUnknownHost) {
    status.notes.push(
      "Some move ops are missing host metadata for this role and were excluded from the host breakdown.",
    );
  }
  return status;
}

export function summarizeProjectHostLroWorkerStatus({
  worker,
  rows,
  nowMs,
  limit,
  limitByHost,
  missingHostNote,
}: {
  worker: ParallelOpsWorkerRegistration;
  rows: RootfsPublishHostStatusRow[];
  nowMs: number;
  limit?: ParallelOpsLimitSnapshot;
  limitByHost: Map<string, { value: number; source: string }>;
  missingHostNote: string;
}): ParallelOpsWorkerStatus {
  const status = baseStatusForWorker(
    worker,
    limit ?? worker.getLimitSnapshot(),
  );
  const staleCutoffMs =
    worker.lease_ms != null
      ? nowMs - worker.lease_ms
      : Number.NEGATIVE_INFINITY;
  let oldestQueuedMs: number | null = null;
  const owners = new Map<string, ParallelOpsWorkerOwnerStatus>();
  const breakdown = new Map<string, ParallelOpsWorkerBreakdownStatus>();
  let hasDbOverride = false;
  let hasUnknownHost = false;

  for (const row of rows) {
    const host_id = row.project_host_id;
    if (!host_id) {
      hasUnknownHost = true;
      continue;
    }
    const entry = breakdown.get(host_id) ?? {
      key: host_id,
      queued_count: 0,
      running_count: 0,
    };
    if (row.status === "queued") {
      status.queued_count += 1;
      entry.queued_count += 1;
      const createdAtMs = getDateMs(row.created_at);
      if (createdAtMs != null) {
        const ageMs = Math.max(0, nowMs - createdAtMs);
        oldestQueuedMs =
          oldestQueuedMs == null ? ageMs : Math.max(oldestQueuedMs, ageMs);
      }
    } else if (row.status === "running") {
      status.running_count += 1;
      entry.running_count += 1;
      const stale =
        row.heartbeat_at == null || row.heartbeat_at.getTime() < staleCutoffMs;
      if (stale) {
        status.stale_running_count = (status.stale_running_count ?? 0) + 1;
      }
      if (row.owner_id) {
        const owner = owners.get(row.owner_id) ?? {
          owner_id: row.owner_id,
          active_count: 0,
          stale_count: 0,
        };
        owner.active_count += 1;
        if (stale) {
          owner.stale_count += 1;
        }
        owners.set(row.owner_id, owner);
      }
    }
    breakdown.set(host_id, entry);
  }

  status.oldest_queued_ms = oldestQueuedMs;
  status.owners = Array.from(owners.values()).sort((a, b) =>
    a.owner_id.localeCompare(b.owner_id),
  );
  status.worker_instances = status.owners.length;
  status.breakdown = Array.from(breakdown.values())
    .map((entry) => {
      const limitEntry = limitByHost.get(entry.key);
      if (limitEntry?.source === "db-override") {
        hasDbOverride = true;
      } else if (limitEntry?.source === "env-debug-cap") {
        status.config_source = "env-debug-cap";
      }
      return {
        ...entry,
        limit: limitEntry?.value ?? null,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));

  const uniqueLimits = Array.from(
    new Set(
      status.breakdown
        .map(({ limit }) => limit)
        .filter((limit) => limit != null),
    ),
  );
  if (uniqueLimits.length === 1) {
    status.configured_limit = uniqueLimits[0] ?? null;
    status.effective_limit = uniqueLimits[0] ?? null;
  } else if (uniqueLimits.length > 1) {
    status.configured_limit = null;
    status.effective_limit = null;
    status.notes.push("Hosts currently report mixed RootFS publish limits.");
  }
  if (hasDbOverride) {
    status.config_source = "db-override";
  }
  if (hasUnknownHost) {
    status.notes.push(missingHostNote);
  }
  return status;
}

async function listRelevantLroRows(): Promise<LroStatusRow[]> {
  const lroKinds = Array.from(parallelOpsLroKindToWorkerKind.keys());
  if (lroKinds.length === 0) return [];
  const { rows } = await pool().query<LroStatusRow>(
    `
      SELECT kind, status, owner_id, heartbeat_at, created_at
      FROM long_running_operations
      WHERE dismissed_at IS NULL
        AND kind = ANY($1::text[])
        AND status IN ('queued', 'running')
    `,
    [lroKinds],
  );
  return rows;
}

async function listRelevantCloudVmWorkRows(): Promise<CloudVmWorkStatusRow[]> {
  const { rows } = await pool().query<CloudVmWorkStatusRow>(
    `
      SELECT state, locked_by, locked_at, created_at, payload
      FROM cloud_vm_work
      WHERE state IN ('queued', 'in_progress')
    `,
  );
  return rows;
}

async function listRelevantMoveRows(): Promise<MoveTopologyStatusRow[]> {
  const { rows } = await pool().query<MoveTopologyStatusRow>(
    `
      SELECT
        l.status,
        l.owner_id,
        l.heartbeat_at,
        l.created_at,
        COALESCE(NULLIF(l.input->>'source_host_id', ''), p.host_id::text) AS source_host_id,
        NULLIF(l.input->>'dest_host_id', '') AS dest_host_id
      FROM long_running_operations l
      JOIN projects p ON p.project_id = l.scope_id::uuid
      WHERE l.kind = 'project-move'
        AND l.dismissed_at IS NULL
        AND l.status IN ('queued', 'running')
    `,
  );
  return rows;
}

async function listRelevantRootfsPublishRows(): Promise<
  RootfsPublishHostStatusRow[]
> {
  const { rows } = await pool().query<RootfsPublishHostStatusRow>(
    `
      SELECT
        l.status,
        l.owner_id,
        l.heartbeat_at,
        l.created_at,
        COALESCE(NULLIF(l.input->>'project_host_id', ''), p.host_id::text) AS project_host_id
      FROM long_running_operations l
      JOIN projects p ON p.project_id = l.scope_id::uuid
      WHERE l.kind = 'project-rootfs-publish'
        AND l.dismissed_at IS NULL
        AND l.status IN ('queued', 'running')
    `,
  );
  return rows;
}

export async function getParallelOpsStatus(): Promise<
  ParallelOpsWorkerStatus[]
> {
  const nowMs = Date.now();
  const [
    lroRows,
    moveRows,
    rootfsPublishRows,
    cloudRows,
    hostLocalBackup,
    limitEntries,
  ] = await Promise.all([
    listRelevantLroRows(),
    listRelevantMoveRows(),
    listRelevantRootfsPublishRows(),
    listRelevantCloudVmWorkRows(),
    listHostLocalBackupStatuses(),
    Promise.all(
      parallelOpsWorkerRegistry.map(
        async (worker) =>
          [worker.worker_kind, await resolveLimitSnapshot(worker)] as [
            string,
            ParallelOpsLimitSnapshot,
          ],
      ),
    ),
  ] as const);
  const limitMap = new Map<string, ParallelOpsLimitSnapshot>(limitEntries);
  const lroRowsByWorker = new Map<string, LroStatusRow[]>();
  for (const row of lroRows) {
    const workerKind = parallelOpsLroKindToWorkerKind.get(row.kind);
    if (!workerKind) continue;
    const rows = lroRowsByWorker.get(workerKind) ?? [];
    rows.push(row);
    lroRowsByWorker.set(workerKind, rows);
  }
  const moveSourceWorker = parallelOpsWorkerRegistryByKind.get(
    MOVE_SOURCE_HOST_WORKER_KIND,
  );
  const moveDestinationWorker = parallelOpsWorkerRegistryByKind.get(
    MOVE_DESTINATION_HOST_WORKER_KIND,
  );
  const rootfsPublishHostWorker = parallelOpsWorkerRegistryByKind.get(
    ROOTFS_PUBLISH_HOST_WORKER_KIND,
  );
  const cloudWorker = parallelOpsWorkerRegistryByKind.get("cloud-vm-work");
  const cloudProviderIds = Array.from(
    new Set(
      cloudRows
        .map((row) => `${row.payload?.provider ?? "unknown"}`)
        .filter((provider) => provider !== "unknown"),
    ),
  );
  const moveSourceHostIds = Array.from(
    new Set(
      moveRows
        .map(({ source_host_id }) => source_host_id)
        .filter(Boolean) as string[],
    ),
  );
  const moveDestinationHostIds = Array.from(
    new Set(
      moveRows
        .map(({ dest_host_id }) => dest_host_id)
        .filter(Boolean) as string[],
    ),
  );
  const rootfsPublishHostIds = Array.from(
    new Set(
      rootfsPublishRows
        .map(({ project_host_id }) => project_host_id)
        .filter(Boolean) as string[],
    ),
  );
  const [
    cloudProviderLimits,
    sourceHostLimits,
    destinationHostLimits,
    rootfsPublishHostLimits,
  ] = await Promise.all([
    getEffectiveParallelOpsLimits({
      worker_kind: "cloud-vm-work",
      default_limit:
        cloudWorker?.getLimitSnapshot().extra_limits?.per_provider_limit ?? 10,
      scope_type: "provider",
      scope_ids: cloudProviderIds,
    }),
    getEffectiveParallelOpsLimits({
      worker_kind: MOVE_SOURCE_HOST_WORKER_KIND,
      default_limit: moveSourceWorker?.getLimitSnapshot().default_limit ?? 1,
      scope_type: "project_host",
      scope_ids: moveSourceHostIds,
    }),
    getEffectiveParallelOpsLimits({
      worker_kind: MOVE_DESTINATION_HOST_WORKER_KIND,
      default_limit:
        moveDestinationWorker?.getLimitSnapshot().default_limit ?? 1,
      scope_type: "project_host",
      scope_ids: moveDestinationHostIds,
    }),
    getEffectiveParallelOpsLimits({
      worker_kind: ROOTFS_PUBLISH_HOST_WORKER_KIND,
      default_limit:
        rootfsPublishHostWorker?.getLimitSnapshot().default_limit ?? 1,
      scope_type: "project_host",
      scope_ids: rootfsPublishHostIds,
    }),
  ]);

  return parallelOpsWorkerRegistry.map((worker) => {
    if (worker.category === "cloud-work") {
      return summarizeCloudVmWorkStatus({
        worker,
        rows: cloudRows,
        nowMs,
        limit: limitMap.get(worker.worker_kind),
        providerLimits: cloudProviderLimits,
      });
    }
    if (worker.category === "host-local") {
      return summarizeHostLocalBackupStatus({
        worker,
        rows: hostLocalBackup.rows,
        unreachable_hosts: hostLocalBackup.unreachable_hosts,
      });
    }
    if (worker.worker_kind === MOVE_SOURCE_HOST_WORKER_KIND) {
      return summarizeMoveRoleWorkerStatus({
        worker,
        rows: moveRows,
        role: "source",
        nowMs,
        limit: limitMap.get(worker.worker_kind),
        limitByHost: sourceHostLimits,
      });
    }
    if (worker.worker_kind === MOVE_DESTINATION_HOST_WORKER_KIND) {
      return summarizeMoveRoleWorkerStatus({
        worker,
        rows: moveRows,
        role: "destination",
        nowMs,
        limit: limitMap.get(worker.worker_kind),
        limitByHost: destinationHostLimits,
      });
    }
    if (worker.worker_kind === ROOTFS_PUBLISH_HOST_WORKER_KIND) {
      return summarizeProjectHostLroWorkerStatus({
        worker,
        rows: rootfsPublishRows,
        nowMs,
        limit: limitMap.get(worker.worker_kind),
        limitByHost: rootfsPublishHostLimits,
        missingHostNote:
          "Some RootFS publish ops are missing host metadata and were excluded from the host breakdown.",
      });
    }
    return summarizeLroWorkerStatus({
      worker,
      rows: lroRowsByWorker.get(worker.worker_kind) ?? [],
      nowMs,
      limit: limitMap.get(worker.worker_kind),
    });
  });
}
