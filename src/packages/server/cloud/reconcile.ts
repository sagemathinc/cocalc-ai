// Cloud VM reconciliation loop.
//
// Periodically compare cloud reality vs. our DB state so we don't
// accidentally leave paid VMs running or show stale status in the UI
// for an unbounded amount of time.
//
// This runs in parallel with the work queue worker and uses Postgres
// advisory locks so multiple hubs can run safely without duplicating work.

import getLogger from "@cocalc/backend/logger";
import getPool, { withSessionAdvisoryLock } from "@cocalc/database/pool";
import type { ProviderId } from "@cocalc/cloud";
import { getProviderContext, getProviderPrefix } from "./provider-context";
import { DisksClient } from "@google-cloud/compute";
import { NebiusClient } from "@cocalc/cloud/nebius/client";
import { getVolumes } from "@cocalc/cloud/hyperstack/client";
import { enqueueCloudVmWorkOnce } from "./db";
import { getServerProvider, listServerProviders } from "./providers";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { getNebiusRegionKeys } from "./nebius-credentials";
import {
  desiredPricingModel,
  effectivePricingModel,
  normalizeSpotRecoveryState,
  recordProviderSpotPreemption,
  shouldAutoRestoreInterruptedSpotHost,
  spotRecoveryPolicy,
  spotRecoveryState,
} from "./spot-restore";
import { recordHostAvailabilityFromSnapshot } from "@cocalc/server/hosts/availability";
export { shouldAutoRestoreInterruptedSpotHost } from "./spot-restore";

const logger = getLogger("server:cloud:reconcile");
const pool = () => getPool();

export const DEFAULT_INTERVALS = {
  // Guest shutdown notices are the fast path for Spot interruptions. This
  // provider poll is the independent fallback when the guest cannot report
  // before power is removed.
  running_ms: 60 * 1000,
  idle_ms: 30 * 60 * 1000,
  empty_ms: 3 * 60 * 60 * 1000,
};

type Intervals = typeof DEFAULT_INTERVALS;

export const PROVIDERS: ProviderId[] = listServerProviders()
  .map((provider) => provider.id)
  .filter((id) => id !== "local");

type Provider = ProviderId;

type ReconcileState = {
  last_run_at?: Date | null;
  next_run_at?: Date | null;
  last_error?: string | null;
};

type HostRow = {
  id: string;
  name?: string;
  status?: string;
  region?: string;
  metadata?: Record<string, any>;
  public_url?: string;
  internal_url?: string;
  ssh_server?: string | null;
  last_seen?: Date | string | null;
};

type RemoteInstance = {
  instance_id: string;
  name?: string;
  status?: string;
  zone?: string;
  public_ip?: string;
};

const RECONCILE_MISSING_CONFIRMATIONS = 2;
const RECONCILE_GRACE_MS = 2 * 60 * 1000;
const STALE_ACTIVE_RECOVERY_MS = 10 * 60 * 1000;
const FRESH_HOST_HEARTBEAT_MS = 2 * 60 * 1000;
const HOST_READY_VERIFICATION_PHASES = new Set([
  "retrying_spot",
  "returning_to_spot",
  "running_standard_fallback",
]);

type DiskStatus = "present" | "missing" | "unknown";

export type CloudOrphanInstance = {
  provider: Provider;
  category: "untracked" | "deleted-host" | "deprovisioned-host";
  instance_id: string;
  name?: string;
  status?: string;
  zone?: string;
  public_ip?: string;
  matched_host_id?: string;
  matched_host_name?: string;
  matched_host_status?: string;
  matched_host_deleted?: string | Date | null;
};

type KnownCloudHost = {
  id: string;
  name?: string;
  status?: string;
  deleted?: string | Date | null;
  metadata?: Record<string, any>;
};

const RESTORE_BLOCKING_PENDING_ACTIONS = [
  "start",
  "stop",
  "restart",
  "hard_restart",
  "delete",
  "deprovision",
  "force_deprovision",
  "provision",
  "bootstrap",
];

async function loadHosts(provider: Provider): Promise<HostRow[]> {
  const { rows } = await pool().query(
    `
      SELECT id, name, status, region, metadata, public_url, internal_url, ssh_server, last_seen
      FROM project_hosts
      WHERE metadata->'machine'->>'cloud' = $1
        AND deleted IS NULL
    `,
    [provider],
  );
  return rows;
}

function recoveryActivityAt(state: Record<string, any>): number | undefined {
  for (const value of [
    state.verification_started_at,
    state.outage_started_at,
    state.last_preempted_at,
    state.machine_type_attempt_started_at,
  ]) {
    const timestamp = Date.parse(`${value ?? ""}`);
    if (Number.isFinite(timestamp)) return timestamp;
  }
}

export function closeStaleObservedSpotRecovery({
  row,
  provider_status,
  now = new Date(),
}: {
  row: HostRow;
  provider_status?: string;
  now?: Date;
}): Record<string, any> | undefined {
  if (provider_status !== "running") return;
  if (`${row.status ?? ""}` !== "running") return;
  if (desiredPricingModel(row) !== "spot") return;
  if (effectivePricingModel(row) !== "spot") return;
  const state = normalizeSpotRecoveryState(row.metadata?.spot_recovery_state);
  if (!state || !HOST_READY_VERIFICATION_PHASES.has(state.phase)) return;
  const activityAt = recoveryActivityAt(state);
  if (
    activityAt == null ||
    now.getTime() - activityAt < STALE_ACTIVE_RECOVERY_MS
  ) {
    return;
  }
  const lastSeenAt = new Date(row.last_seen ?? 0).getTime();
  if (
    !Number.isFinite(lastSeenAt) ||
    now.getTime() - lastSeenAt > FRESH_HOST_HEARTBEAT_MS
  ) {
    return;
  }
  return {
    phase: "idle",
    ...(state.outage_started_at
      ? { outage_started_at: state.outage_started_at }
      : {}),
    last_recovered_at: now.toISOString(),
    ...(state.attempt != null ? { attempt: state.attempt } : {}),
    ...(state.active_machine_type
      ? { active_machine_type: state.active_machine_type }
      : {}),
    ...(state.last_preempted_at
      ? { last_preempted_at: state.last_preempted_at }
      : {}),
    ...(state.standard_hold_until
      ? { standard_hold_until: state.standard_hold_until }
      : {}),
  };
}

async function loadKnownCloudHosts(
  provider: Provider,
): Promise<KnownCloudHost[]> {
  const { rows } = await pool().query(
    `
      SELECT id, name, status, deleted, metadata
      FROM project_hosts
      WHERE metadata->'machine'->>'cloud' = $1
    `,
    [provider],
  );
  return rows;
}

async function countHosts(provider: Provider): Promise<{
  total: number;
  running: number;
}> {
  const { rows } = await pool().query(
    `
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status='running')::int AS running
      FROM project_hosts
      WHERE metadata->'machine'->>'cloud' = $1
        AND deleted IS NULL
    `,
    [provider],
  );
  return rows[0] ?? { total: 0, running: 0 };
}

function nextInterval(
  { total, running }: { total: number; running: number },
  intervals: Intervals = DEFAULT_INTERVALS,
) {
  if (total === 0) return intervals.empty_ms;
  if (running > 0) return intervals.running_ms;
  return intervals.idle_ms;
}

async function getReconcileState(provider: Provider): Promise<ReconcileState> {
  const { rows } = await pool().query(
    `
      SELECT last_run_at, next_run_at, last_error
      FROM cloud_reconcile_state
      WHERE provider=$1
    `,
    [provider],
  );
  return rows[0] ?? {};
}

async function setReconcileState(
  provider: Provider,
  opts: {
    last_run_at?: Date | null;
    next_run_at?: Date | null;
    last_error?: string | null;
  },
) {
  await pool().query(
    `
      INSERT INTO cloud_reconcile_state
        (provider, last_run_at, next_run_at, last_error, updated_at)
      VALUES ($1,$2,$3,$4, NOW())
      ON CONFLICT (provider)
      DO UPDATE SET
        last_run_at = EXCLUDED.last_run_at,
        next_run_at = EXCLUDED.next_run_at,
        last_error = EXCLUDED.last_error,
        updated_at = NOW()
    `,
    [
      provider,
      opts.last_run_at ?? null,
      opts.next_run_at ?? null,
      opts.last_error ?? null,
    ],
  );
}

export async function bumpReconcile(
  provider: Provider,
  interval_ms = DEFAULT_INTERVALS.running_ms,
) {
  const nextAt = new Date(Date.now() + interval_ms);
  await pool().query(
    `
      INSERT INTO cloud_reconcile_state
        (provider, next_run_at, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (provider)
      DO UPDATE SET
        next_run_at = LEAST(
          COALESCE(cloud_reconcile_state.next_run_at, EXCLUDED.next_run_at),
          EXCLUDED.next_run_at
        ),
        last_error = NULL,
        updated_at = NOW()
    `,
    [provider, nextAt],
  );
}

async function withReconcileLock<T>(
  provider: Provider,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  const lockKey = `cloud_reconcile:${provider}`;
  return await withSessionAdvisoryLock({ lockKey, fn });
}

async function listProviderInstances(
  provider: Provider,
  prefix: string | undefined,
): Promise<RemoteInstance[] | undefined> {
  if (provider === "nebius") {
    const settings = await getServerSettings();
    const regions = getNebiusRegionKeys(settings);
    if (regions.length) {
      const entries: RemoteInstance[] = [];
      for (const region of regions) {
        try {
          const { entry, creds } = await getProviderContext(provider, {
            region,
          });
          if (!entry.provider.listInstances) {
            logger.warn("cloud reconcile: listInstances not implemented", {
              provider,
            });
            return undefined;
          }
          const instances = await entry.provider.listInstances(
            creds,
            prefix ? { namePrefix: prefix } : undefined,
          );
          entries.push(...instances);
        } catch (err) {
          logger.warn("cloud reconcile: nebius listInstances failed", {
            provider,
            region,
            err,
          });
        }
      }
      return entries;
    }
  }
  const { entry, creds } = await getProviderContext(provider);
  if (!entry.provider.listInstances) {
    logger.warn("cloud reconcile: listInstances not implemented", { provider });
    return undefined;
  }
  return await entry.provider.listInstances(
    creds,
    prefix ? { namePrefix: prefix } : undefined,
  );
}

function parseLastActionAt(row: HostRow): Date | undefined {
  const value = row.metadata?.last_action_at;
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function getMissingCount(runtime: Record<string, any> | undefined): number {
  return Number(runtime?.metadata?.reconcile?.missing_count ?? 0);
}

function setMissingCount(
  runtime: Record<string, any>,
  count: number,
  now: Date,
): Record<string, any> {
  const metadata = runtime.metadata ?? {};
  const reconcile = metadata.reconcile ?? {};
  return {
    ...runtime,
    metadata: {
      ...metadata,
      reconcile: {
        ...reconcile,
        missing_count: count,
        last_missing_at: count ? now.toISOString() : undefined,
      },
    },
  };
}

export function classifyCloudOrphanInstances({
  provider,
  instances,
  hosts,
}: {
  provider: Provider;
  instances: RemoteInstance[];
  hosts: KnownCloudHost[];
}): CloudOrphanInstance[] {
  const hostByInstanceId = new Map<string, KnownCloudHost>();
  for (const host of hosts) {
    const instanceId = `${host.metadata?.runtime?.instance_id ?? ""}`.trim();
    if (instanceId) {
      hostByInstanceId.set(instanceId, host);
    }
  }
  const orphans: CloudOrphanInstance[] = [];
  for (const instance of instances) {
    const host = hostByInstanceId.get(instance.instance_id);
    let category: CloudOrphanInstance["category"] | undefined;
    if (!host) {
      category = "untracked";
    } else if (host.deleted) {
      category = "deleted-host";
    } else if (host.status === "deprovisioned") {
      category = "deprovisioned-host";
    }
    if (!category) continue;
    orphans.push({
      provider,
      category,
      instance_id: instance.instance_id,
      name: instance.name,
      status: instance.status,
      zone: instance.zone,
      public_ip: instance.public_ip,
      matched_host_id: host?.id,
      matched_host_name: host?.name,
      matched_host_status: host?.status,
      matched_host_deleted: host?.deleted ?? null,
    });
  }
  return orphans;
}

export async function listCloudOrphanInstances(
  provider: Provider,
): Promise<CloudOrphanInstance[]> {
  const prefix = await getProviderPrefix(provider);
  const instances = await listProviderInstances(provider, prefix);
  if (!instances) return [];
  const hosts = await loadKnownCloudHosts(provider);
  return classifyCloudOrphanInstances({ provider, instances, hosts });
}

export async function hasPendingRestoreBlockingWork(
  vmId: string,
): Promise<boolean> {
  const { rows } = await pool().query<{ exists: boolean }>(
    `
      SELECT EXISTS(
        SELECT 1
        FROM cloud_vm_work
        WHERE vm_id=$1
          AND state IN ('queued','in_progress')
          AND action = ANY($2::text[])
      ) AS exists
    `,
    [vmId, RESTORE_BLOCKING_PENDING_ACTIONS],
  );
  return !!rows[0]?.exists;
}

export async function ensureHostReadyVerificationWork({
  provider,
  row,
  provider_status,
}: {
  provider: Provider;
  row: HostRow;
  provider_status?: string;
}): Promise<boolean> {
  if (provider_status !== "running") return false;
  const state = row.metadata?.spot_recovery_state;
  if (!HOST_READY_VERIFICATION_PHASES.has(`${state?.phase ?? ""}`)) {
    return false;
  }
  const startedAt = new Date(`${state?.verification_started_at ?? ""}`);
  const deadlineAt = new Date(`${state?.verification_deadline_at ?? ""}`);
  if (
    !Number.isFinite(startedAt.getTime()) ||
    !Number.isFinite(deadlineAt.getTime())
  ) {
    return false;
  }
  const workId = await enqueueCloudVmWorkOnce({
    vm_id: row.id,
    action: "verify_host_ready",
    payload: {
      provider,
      started_at: startedAt.toISOString(),
      deadline_at: deadlineAt.toISOString(),
    },
  });
  if (workId) {
    logger.warn("cloud reconcile: restored host readiness verification", {
      provider,
      host_id: row.id,
      recovery_phase: state.phase,
      verification_started_at: startedAt.toISOString(),
      verification_deadline_at: deadlineAt.toISOString(),
    });
  }
  return !!workId;
}

async function dataDiskStatus(
  provider: Provider,
  row: HostRow,
  creds: any,
): Promise<DiskStatus> {
  const runtime = row.metadata?.runtime ?? {};
  const runtimeMeta = runtime.metadata ?? {};
  if (provider === "lambda") return "missing";
  if (provider === "self-host") return "unknown";
  if (provider === "gcp") {
    const zone =
      runtime.zone ??
      row.metadata?.machine?.zone ??
      runtimeMeta.zone ??
      row.metadata?.machine?.metadata?.zone;
    let diskName: string | undefined = runtimeMeta.data_disk_name;
    if (!diskName && runtimeMeta.data_disk_uri) {
      diskName = String(runtimeMeta.data_disk_uri).split("/").pop();
    }
    if (!zone || !diskName) return "unknown";
    const diskClient = new DisksClient(creds);
    try {
      await diskClient.get({ project: creds.projectId, zone, disk: diskName });
      return "present";
    } catch (err) {
      const message = String((err as any)?.message ?? err);
      const code = (err as any)?.code ?? (err as any)?.status;
      if (code === 404 || message.includes("was not found")) {
        return "missing";
      }
      logger.warn("cloud reconcile: gcp disk lookup failed", {
        host_id: row.id,
        disk: diskName,
        err,
      });
      return "unknown";
    }
  }
  if (provider === "hyperstack") {
    const volumeId = Number(runtimeMeta.data_volume_id);
    if (!Number.isFinite(volumeId) || volumeId <= 0) return "unknown";
    try {
      const volumes = await getVolumes(false);
      const volume = volumes.find((item) => item.id === volumeId);
      if (!volume) return "missing";
      const status = String(volume.status ?? "").toLowerCase();
      if (status === "deleted") return "missing";
      return "present";
    } catch (err) {
      logger.warn("cloud reconcile: hyperstack volume lookup failed", {
        host_id: row.id,
        volumeId,
        err,
      });
      return "unknown";
    }
  }
  if (provider === "nebius") {
    const diskId = runtimeMeta.diskIds?.data;
    if (!diskId) return "unknown";
    try {
      await using client = new NebiusClient(creds);
      const parentId = creds.parentId;
      if (!parentId) return "unknown";
      let pageToken = "";
      for (;;) {
        const res = await client.disks.list({
          parentId,
          pageSize: 1000,
          pageToken,
        } as any);
        const match = (res.items ?? []).find(
          (disk) => disk.metadata?.id === diskId,
        );
        if (match) return "present";
        const nextToken = res.nextPageToken ?? "";
        if (!nextToken) return "missing";
        pageToken = nextToken;
      }
    } catch (err) {
      logger.warn("cloud reconcile: nebius disk lookup failed", {
        host_id: row.id,
        diskId,
        err,
      });
      return "unknown";
    }
  }
  return "unknown";
}

export async function updateHostFromProviderSnapshot(
  row: HostRow,
  updates: {
    status?: string;
    runtime?: Record<string, any> | null;
    desired_state?: "running" | "stopped";
    spot_recovery_state?: Record<string, any>;
    public_url?: string | null;
    internal_url?: string | null;
  },
) {
  if (updates.status !== undefined) {
    const stack = new Error().stack;
    logger.debug("status update", {
      host_id: row.id,
      status: updates.status,
      previous: row.status,
      source: "reconcile",
      stack,
    });
  }
  const sets: string[] = [];
  const params: any[] = [row.id];
  let idx = 2;
  if (updates.status) {
    sets.push(`status=$${idx++}`);
    params.push(updates.status);
  }
  let metadataExpression = "COALESCE(metadata,'{}'::jsonb)";
  if (updates.runtime !== undefined) {
    metadataExpression = `jsonb_set(${metadataExpression}, '{runtime}', $${idx++}::jsonb, true)`;
    params.push(JSON.stringify(updates.runtime));
  }
  if (updates.desired_state !== undefined) {
    metadataExpression = `jsonb_set(${metadataExpression}, '{desired_state}', to_jsonb($${idx++}::text), true)`;
    params.push(updates.desired_state);
  }
  if (updates.spot_recovery_state !== undefined) {
    metadataExpression = `jsonb_set(${metadataExpression}, '{spot_recovery_state}', $${idx++}::jsonb, true)`;
    params.push(JSON.stringify(updates.spot_recovery_state));
  }
  if (
    updates.runtime !== undefined ||
    updates.desired_state !== undefined ||
    updates.spot_recovery_state !== undefined
  ) {
    sets.push(`metadata = ${metadataExpression}`);
  }
  if (updates.public_url !== undefined) {
    sets.push(`public_url=$${idx++}`);
    params.push(updates.public_url);
  }
  if (updates.internal_url !== undefined) {
    sets.push(`internal_url=$${idx++}`);
    params.push(updates.internal_url);
  }
  const sshServer = runtimeSshServerForProviderReconcile(row, updates.runtime);
  if (sshServer !== undefined && sshServer !== row.ssh_server) {
    sets.push(`ssh_server=$${idx++}`);
    params.push(sshServer);
  }
  if (!sets.length) return;
  const where = ["id=$1", "deleted IS NULL"];
  const expectedInstanceId =
    `${row.metadata?.runtime?.instance_id ?? ""}`.trim();
  if (expectedInstanceId) {
    where.push(`metadata->'runtime'->>'instance_id'=$${idx++}`);
    params.push(expectedInstanceId);
  }
  const result = await pool().query(
    `UPDATE project_hosts
        SET ${sets.join(", ")}, updated=NOW()
      WHERE ${where.join(" AND ")}
      RETURNING id`,
    params,
  );
  const updated = (result.rowCount ?? result.rows?.length ?? 0) > 0;
  if (!updated && expectedInstanceId) {
    logger.info("cloud reconcile: skipped stale provider snapshot", {
      host_id: row.id,
      expected_instance_id: expectedInstanceId,
    });
  }
  const { rows } = await pool().query(
    `SELECT id, status, deleted, last_seen, metadata
       FROM project_hosts
      WHERE id=$1
      LIMIT 1`,
    [row.id],
  );
  if (rows[0]) {
    await recordHostAvailabilityFromSnapshot(rows[0], "cloud_reconcile");
  }
  return updated;
}

const updateHost = updateHostFromProviderSnapshot;

export function runtimeSshServerForProviderReconcile(
  row: Pick<HostRow, "metadata">,
  runtime: Record<string, any> | null | undefined,
): string | undefined {
  if (row.metadata?.machine?.cloud !== "gcp") {
    return undefined;
  }
  const publicIp = `${runtime?.public_ip ?? ""}`.trim();
  return publicIp ? `${publicIp}:2222` : undefined;
}

async function enqueueSpotRestore(
  provider: Provider,
  row: HostRow,
  nextRuntime: Record<string, any>,
  reason: string,
): Promise<boolean> {
  if (!shouldAutoRestoreInterruptedSpotHost(row)) return false;
  const now = new Date();
  const preemption =
    effectivePricingModel(row) === "spot"
      ? recordProviderSpotPreemption({
          state: spotRecoveryState(row),
          policy: spotRecoveryPolicy(row),
          now,
        })
      : undefined;
  const nextRecoveryState = preemption?.recorded
    ? {
        ...preemption.state,
        phase: "retrying_spot" as const,
        outage_started_at: now.toISOString(),
        active_machine_type:
          preemption.state.active_machine_type ??
          row.metadata?.machine?.machine_type,
      }
    : undefined;
  const enqueued = await enqueueCloudVmWorkOnce({
    vm_id: row.id,
    action: "start",
    payload: {
      source: "cloud_reconcile",
      reason,
    },
  });
  logger.warn("cloud reconcile: auto-restoring interrupted spot host", {
    provider,
    host_id: row.id,
    reason,
    enqueued: !!enqueued,
    rapid_preemption_circuit_breaker:
      preemption?.circuit_breaker_triggered ?? false,
    standard_hold_until: preemption?.state.standard_hold_until,
  });
  const runtimeMetadata = nextRuntime.metadata ?? {};
  const reconcileMetadata = runtimeMetadata.reconcile ?? {};
  await updateHost(row, {
    status: "starting",
    desired_state: "running",
    spot_recovery_state: nextRecoveryState,
    runtime: {
      ...nextRuntime,
      public_ip: undefined,
      metadata: {
        ...runtimeMetadata,
        reconcile: {
          ...reconcileMetadata,
          auto_restore_reason: reason,
          auto_restore_requested_at: new Date().toISOString(),
        },
      },
    },
  });
  await bumpReconcile(provider, DEFAULT_INTERVALS.running_ms);
  return true;
}

async function reconcileProvider(provider: Provider) {
  const prefix = await getProviderPrefix(provider);
  const entry = getServerProvider(provider)?.entry;
  if (!entry) {
    throw new Error(`unsupported cloud provider ${provider}`);
  }
  const hosts = await loadHosts(provider);
  const instances = await listProviderInstances(provider, prefix);
  if (!instances) return;

  const remoteById = new Map<string, RemoteInstance>();
  for (const inst of instances) {
    remoteById.set(inst.instance_id, inst);
  }

  for (const row of hosts) {
    const runtime = row.metadata?.runtime ?? {};
    const instance_id = runtime.instance_id;
    if (!instance_id) continue;
    const now = new Date();
    const remote = remoteById.get(instance_id);
    const lastActionAt = parseLastActionAt(row);
    const inGrace =
      lastActionAt &&
      now.getTime() - lastActionAt.getTime() < RECONCILE_GRACE_MS;
    const pendingBlockingWork = await hasPendingRestoreBlockingWork(row.id);
    let missingCount = getMissingCount(runtime);
    let nextRuntime = {
      ...runtime,
      provider_status: remote?.status ?? "missing",
      observed_at: now.toISOString(),
      public_ip: remote?.public_ip ?? (remote ? runtime.public_ip : undefined),
      zone: remote?.zone ?? runtime.zone,
    };
    if (!remote) {
      missingCount += 1;
      nextRuntime = setMissingCount(nextRuntime, missingCount, now);
    } else if (missingCount !== 0) {
      nextRuntime = setMissingCount(nextRuntime, 0, now);
    }

    if (inGrace) {
      await updateHost(row, { runtime: nextRuntime });
      continue;
    }
    if (pendingBlockingWork) {
      await updateHost(row, { runtime: nextRuntime });
      continue;
    }

    if (!remote) {
      if (missingCount < RECONCILE_MISSING_CONFIRMATIONS) {
        await updateHost(row, { runtime: nextRuntime });
        continue;
      }
      const { creds } = await getProviderContext(provider, {
        region: row.metadata?.runtime?.region ?? row.region,
      });
      const diskState = await dataDiskStatus(provider, row, creds);
      if (diskState === "unknown") {
        await updateHost(row, { runtime: nextRuntime });
        continue;
      }
      if (diskState === "present") {
        if (
          await enqueueSpotRestore(
            provider,
            row,
            {
              ...nextRuntime,
              public_ip: undefined,
            },
            "missing-instance",
          )
        ) {
          continue;
        }
        await updateHost(row, {
          status: "off",
          runtime: {
            ...nextRuntime,
            public_ip: undefined,
          },
        });
        continue;
      }
      await updateHost(row, {
        status: "deprovisioned",
        runtime: null,
        public_url: null,
        internal_url: null,
      });
      continue;
    }

    const desiredStatus =
      entry.provider.mapStatus?.(remote.status) ?? row.status;
    const closedRecoveryState = closeStaleObservedSpotRecovery({
      row,
      provider_status: desiredStatus,
      now,
    });
    if (closedRecoveryState) {
      logger.warn("cloud reconcile: closed stale observed spot recovery", {
        provider,
        host_id: row.id,
        previous_phase: row.metadata?.spot_recovery_state?.phase,
        outage_started_at: row.metadata?.spot_recovery_state?.outage_started_at,
      });
    } else {
      await ensureHostReadyVerificationWork({
        provider,
        row,
        provider_status: desiredStatus,
      });
    }
    const bootstrapDone =
      row.metadata?.bootstrap?.status === "done" ||
      row.metadata?.bootstrap_lifecycle?.summary_status === "in_sync";
    const nextStatus =
      desiredStatus === "starting" && bootstrapDone ? "running" : desiredStatus;
    if (
      nextStatus === "off" &&
      (await enqueueSpotRestore(
        provider,
        row,
        {
          ...nextRuntime,
          public_ip: undefined,
        },
        remote.status ? `provider-status:${remote.status}` : "provider-offline",
      ))
    ) {
      continue;
    }
    await updateHost(row, {
      status: nextStatus,
      runtime: nextRuntime,
      ...(closedRecoveryState
        ? { spot_recovery_state: closedRecoveryState }
        : {}),
    });
    // cloud-init handles bootstrap; no queue-based bootstrap scheduling.
  }
}

export type ReconcileRunResult = {
  ran: boolean;
  skipped?: "locked" | "not_due";
  next_at?: Date;
};

export async function runReconcileOnce(
  provider: Provider,
  opts: {
    now?: () => Date;
    intervals?: Intervals;
    reconcile?: (provider: Provider) => Promise<void>;
    count?: (provider: Provider) => Promise<{ total: number; running: number }>;
  } = {},
): Promise<ReconcileRunResult | undefined> {
  const now = opts.now ?? (() => new Date());
  const intervals = opts.intervals ?? DEFAULT_INTERVALS;
  const reconcile = opts.reconcile ?? reconcileProvider;
  const count = opts.count ?? countHosts;

  return await withReconcileLock(provider, async () => {
    const state = await getReconcileState(provider);
    const current = now();
    if (state.next_run_at && state.next_run_at > current) {
      return { ran: false, skipped: "not_due", next_at: state.next_run_at };
    }
    logger.debug("cloud reconcile tick", { provider });
    try {
      await reconcile(provider);
      const counts = await count(provider);
      const next_at = new Date(
        current.getTime() + nextInterval(counts, intervals),
      );
      await setReconcileState(provider, {
        last_run_at: current,
        next_run_at: next_at,
        last_error: null,
      });
      return { ran: true, next_at };
    } catch (err) {
      const next_at = new Date(current.getTime() + intervals.idle_ms);
      await setReconcileState(provider, {
        last_run_at: current,
        next_run_at: next_at,
        last_error: String(err),
      });
      throw err;
    }
  });
}

export function startCloudVmReconciler(
  opts: {
    providers?: Provider[];
    intervals?: Intervals;
  } = {},
) {
  const providers: Provider[] = opts.providers ?? [...PROVIDERS];
  const intervals = opts.intervals ?? DEFAULT_INTERVALS;
  logger.info("startCloudVmReconciler", { providers, intervals });
  const timers = new Map<Provider, NodeJS.Timeout>();
  let stopped = false;

  const schedule = async (provider: Provider, nextAt?: Date) => {
    if (stopped) return;
    let delay = intervals.idle_ms;
    if (nextAt) {
      delay = Math.max(1000, nextAt.getTime() - Date.now());
    } else {
      const counts = await countHosts(provider);
      delay = nextInterval(counts, intervals);
    }
    const timer = setTimeout(() => tick(provider), delay);
    timers.set(provider, timer);
  };

  const tick = async (provider: Provider) => {
    if (stopped) return;
    let nextAt: Date | undefined;
    try {
      const result = await runReconcileOnce(provider, { intervals });
      if (result?.next_at) {
        nextAt = result.next_at;
      } else if (result === undefined) {
        // Lock not acquired; schedule based on state if available.
        const state = await getReconcileState(provider);
        if (state.next_run_at) {
          nextAt = state.next_run_at;
        }
      }
    } catch (err) {
      logger.warn("cloud reconcile failed", { provider, err });
      nextAt = new Date(Date.now() + intervals.idle_ms);
      await setReconcileState(provider, {
        last_error: String(err),
        next_run_at: nextAt,
      });
    }
    await schedule(provider, nextAt);
  };

  for (const provider of providers) {
    void tick(provider);
  }

  return () => {
    stopped = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
}
