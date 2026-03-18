import getPool from "@cocalc/database/pool";
import {
  type ParallelOpsConfigSource,
  type ParallelOpsLimitSnapshot,
  type ParallelOpsScopeModel,
  type ParallelOpsWorkerCategory,
  type ParallelOpsWorkerRegistration,
  parallelOpsLroKindToWorkerKind,
  parallelOpsWorkerRegistry,
} from "./worker-registry";
import { getEffectiveParallelOpsLimit } from "./worker-config";

const pool = () => getPool();

type LroStatusRow = {
  kind: string;
  status: string;
  owner_id: string | null;
  heartbeat_at: Date | null;
  created_at: Date;
};

type CloudVmWorkStatusRow = {
  state: string;
  locked_by: string | null;
  locked_at: Date | null;
  created_at: Date;
  payload: { provider?: string } | null;
};

export interface ParallelOpsWorkerOwnerStatus {
  owner_id: string;
  active_count: number;
  stale_count: number;
}

export interface ParallelOpsWorkerBreakdownStatus {
  key: string;
  queued_count: number;
  running_count: number;
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
  if (base.effective_limit == null || worker.scope_model !== "global") {
    return base;
  }
  const { value, source } = await getEffectiveParallelOpsLimit({
    worker_kind: worker.worker_kind,
    default_limit: base.effective_limit,
  });
  return {
    ...base,
    configured_limit: value,
    effective_limit: value,
    config_source:
      source === "db-override" ? "db-override" : base.config_source,
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
      const ageMs = Math.max(0, nowMs - row.created_at.getTime());
      oldestQueuedMs =
        oldestQueuedMs == null ? ageMs : Math.max(oldestQueuedMs, ageMs);
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
}: {
  worker: ParallelOpsWorkerRegistration;
  rows: CloudVmWorkStatusRow[];
  nowMs: number;
  limit?: ParallelOpsLimitSnapshot;
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
      const ageMs = Math.max(0, nowMs - row.created_at.getTime());
      oldestQueuedMs =
        oldestQueuedMs == null ? ageMs : Math.max(oldestQueuedMs, ageMs);
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
  status.breakdown = Array.from(breakdown.values()).sort((a, b) =>
    a.key.localeCompare(b.key),
  );
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

export async function getParallelOpsStatus(): Promise<
  ParallelOpsWorkerStatus[]
> {
  const nowMs = Date.now();
  const [lroRows, cloudRows, limitEntries] = await Promise.all([
    listRelevantLroRows(),
    listRelevantCloudVmWorkRows(),
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

  return parallelOpsWorkerRegistry.map((worker) => {
    if (worker.category === "cloud-work") {
      return summarizeCloudVmWorkStatus({
        worker,
        rows: cloudRows,
        nowMs,
        limit: limitMap.get(worker.worker_kind),
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
