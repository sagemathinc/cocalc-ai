import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { clearProjectHostRuntimeDeployments } from "@cocalc/database/postgres/project-host-runtime-deployments";
import { deleteHostDns, ensureHostDns, hasDns } from "./dns";
import {
  deleteCloudflareTunnel,
  hasCloudflareTunnel,
  ensureCloudflareTunnelForHost,
} from "./cloudflare-tunnel";
import {
  enqueueCloudVmWork,
  enqueueCloudVmWorkOnce,
  logCloudVmEvent,
} from "./db";
import { buildHostSpec, provisionIfNeeded } from "./host-util";
import type { CloudVmWorkHandlers } from "./worker";
import type {
  HostMachine,
  HostPricingModel,
  HostSpotRecoveryPolicy,
  HostSpotRecoveryState,
} from "@cocalc/conat/hub/api/hosts";
import { buildCloudInitStartupScript, handleBootstrap } from "./bootstrap-host";
import { resolveLaunchpadBootstrapUrl } from "@cocalc/server/launchpad/bootstrap-url";
import { bumpReconcile, DEFAULT_INTERVALS } from "./reconcile";
import { normalizeProviderId } from "@cocalc/cloud";
import { getProviderContext } from "./provider-context";
import {
  computeSpotRetryDelayMs,
  desiredPricingModel,
  effectivePricingModel,
  isSpotRecoveryManagedHost,
  shouldAutoRestoreInterruptedSpotHost,
  spotProbeIntervalMs,
  spotRecoveryPolicy,
  standardFallbackMinMs,
  spotRecoveryState,
  spotRetryWindowMs,
} from "./spot-restore";
import { resolveGcpManagedHostInternalUrl } from "./internal-network";
import {
  createProjectHostBootstrapToken,
  revokeProjectHostTokensForHost,
  restoreProjectHostTokensForRestart,
} from "@cocalc/server/project-host/bootstrap-token";
import { getServerSettings } from "@cocalc/database/settings/server-settings";

const logger = getLogger("server:cloud:host-work");
const pool = () => getPool();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const HOST_READY_VERIFY_DELAY_MS = 10_000;
const HOST_READY_VERIFY_DEADLINE_MS = 10 * 60 * 1000;

async function waitForProviderStatus(opts: {
  entry: Awaited<ReturnType<typeof getProviderContext>>["entry"];
  creds: any;
  runtime: any;
  desired: Array<"running" | "off" | "stopped" | "starting" | "error">;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<"running" | "starting" | "off" | "stopped" | "error" | undefined> {
  const timeoutMs = opts.timeoutMs ?? 120000;
  const intervalMs = opts.intervalMs ?? 5000;
  const deadline = Date.now() + timeoutMs;
  let lastStatus:
    | "running"
    | "starting"
    | "off"
    | "stopped"
    | "error"
    | undefined;
  while (Date.now() < deadline) {
    try {
      if (opts.entry.provider.getStatus) {
        const status = await opts.entry.provider.getStatus(
          opts.runtime,
          opts.creds,
        );
        lastStatus = status;
      } else if (opts.entry.provider.getInstance) {
        const remote = await opts.entry.provider.getInstance(
          opts.runtime,
          opts.creds,
        );
        if (!remote) {
          lastStatus = "off";
        } else {
          const mapped =
            opts.entry.provider.mapStatus?.(remote.status) ??
            remote.status ??
            undefined;
          lastStatus = mapped as typeof lastStatus;
        }
      }
      if (lastStatus && opts.desired.includes(lastStatus)) {
        return lastStatus;
      }
      if (lastStatus === "error") return lastStatus;
    } catch (err) {
      logger.warn("provider wait status failed", { err });
    }
    await sleep(intervalMs);
  }
  return lastStatus;
}

async function waitForLambdaStatus(opts: {
  entry: Awaited<ReturnType<typeof getProviderContext>>["entry"];
  creds: any;
  runtime: any;
  desired: "running" | "stopped";
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<"running" | "stopped" | "starting" | "error" | undefined> {
  const timeoutMs = opts.timeoutMs ?? 120000;
  const intervalMs = opts.intervalMs ?? 5000;
  const deadline = Date.now() + timeoutMs;
  let lastStatus: "running" | "stopped" | "starting" | "error" | undefined;
  while (Date.now() < deadline) {
    try {
      const status = await opts.entry.provider.getStatus(
        opts.runtime,
        opts.creds,
      );
      lastStatus = status;
      if (status === opts.desired) return status;
      if (status === "error") return status;
    } catch (err) {
      logger.warn("lambda wait status failed", { err });
    }
    await sleep(intervalMs);
  }
  return lastStatus;
}

async function waitForLambdaInstanceGone(opts: {
  entry: Awaited<ReturnType<typeof getProviderContext>>["entry"];
  creds: any;
  runtime: any;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 120000;
  const intervalMs = opts.intervalMs ?? 5000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const inst = await opts.entry.provider.getInstance?.(
        opts.runtime,
        opts.creds,
      );
      if (!inst) return true;
    } catch (err) {
      logger.warn("lambda wait instance failed", { err });
    }
    await sleep(intervalMs);
  }
  return false;
}

async function loadHostRow(id: string) {
  const { rows } = await pool().query(
    "SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL",
    [id],
  );
  return rows[0];
}

function currentMetricsWithoutSnapshot(metrics: any): any {
  if (!metrics || typeof metrics !== "object") return metrics;
  const next = { ...metrics };
  delete next.current;
  return Object.keys(next).length ? next : undefined;
}

function shouldResetToStoppedAfterStartFailure(opts: {
  action?: string;
  currentRow?: any;
  originalRow?: any;
}): boolean {
  if (opts.action !== "start" && opts.action !== "provision") {
    return false;
  }
  if (!opts.currentRow) return false;
  const currentRuntime = opts.currentRow.metadata?.runtime;
  if (currentRuntime?.instance_id) {
    return false;
  }
  return true;
}

function sanitizedMetadataForFailedStart(opts: {
  metadata: any;
  message: string;
  originalRow?: any;
}) {
  const nextMetadata = {
    ...(opts.metadata ?? {}),
    last_error: opts.message,
    last_error_at: new Date().toISOString(),
    bootstrap: {
      status: "error",
      message: opts.message,
      updated_at: new Date().toISOString(),
    },
  };
  delete nextMetadata.runtime;
  delete nextMetadata.dns;
  delete nextMetadata.cloudflare_tunnel;
  if (opts.originalRow?.metadata?.reprovision_required) {
    nextMetadata.reprovision_required = true;
  }
  const nextMetrics = currentMetricsWithoutSnapshot(nextMetadata.metrics);
  if (nextMetrics) {
    nextMetadata.metrics = nextMetrics;
  } else {
    delete nextMetadata.metrics;
  }
  return nextMetadata;
}

async function updateHostRow(id: string, updates: Record<string, any>) {
  const keys = Object.keys(updates).filter((key) => updates[key] !== undefined);
  if (!keys.length) return;
  if (updates.status !== undefined) {
    const stack = new Error().stack;
    logger.debug("status update", {
      host_id: id,
      status: updates.status,
      source: "host-work",
      stack,
    });
  }
  const sets = keys.map((key, idx) => `${key}=$${idx + 2}`);
  await pool().query(
    `UPDATE project_hosts SET ${sets.join(", ")}, updated=NOW() WHERE id=$1 AND deleted IS NULL`,
    [id, ...keys.map((key) => updates[key])],
  );
}

function setRuntimeObservedAt(metadata: any, at: Date): any {
  if (!metadata?.runtime) return metadata;
  return {
    ...metadata,
    runtime: {
      ...metadata.runtime,
      observed_at: at.toISOString(),
    },
  };
}

function clearVerificationFields(
  state: HostSpotRecoveryState | undefined,
): HostSpotRecoveryState | undefined {
  if (!state) return state;
  const next = { ...state };
  delete next.verification_started_at;
  delete next.verification_deadline_at;
  return next;
}

function clearHostLastErrorMetadata(metadata: any): any {
  const next = { ...(metadata ?? {}) };
  delete next.last_error;
  delete next.last_error_at;
  return next;
}

function hostLastSeenMs(row: any): number {
  if (!row?.last_seen) return 0;
  const ms = new Date(row.last_seen as any).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function hostIsOperationalSince(row: any, sinceIso?: string): boolean {
  const status = `${row?.status ?? ""}`.trim().toLowerCase();
  if (status !== "running" && status !== "active") return false;
  const sinceMs = sinceIso ? new Date(sinceIso).getTime() : 0;
  const lastSeenMs = hostLastSeenMs(row);
  return lastSeenMs > 0 && lastSeenMs >= sinceMs;
}

function withPricingAndRecoveryMetadata(
  metadata: any,
  opts: {
    desired_pricing_model?: HostPricingModel;
    effective_pricing_model?: HostPricingModel;
    spot_recovery_state?: HostSpotRecoveryState | null;
  },
) {
  const next = { ...(metadata ?? {}) };
  const desired =
    opts.desired_pricing_model ?? desiredPricingModel({ metadata });
  next.pricing_model = desired;
  next.desired_pricing_model = desired;
  next.effective_pricing_model =
    opts.effective_pricing_model ?? effectivePricingModel({ metadata });
  if (opts.spot_recovery_state === null) {
    delete next.spot_recovery_state;
  } else if (opts.spot_recovery_state) {
    next.spot_recovery_state = opts.spot_recovery_state;
  }
  return next;
}

async function scheduleHostReadyVerification(opts: {
  row: any;
  provider?: string;
  started_at: Date;
  deadline_at?: Date;
}) {
  const deadlineAt =
    opts.deadline_at ??
    new Date(opts.started_at.getTime() + HOST_READY_VERIFY_DEADLINE_MS);
  await enqueueCloudVmWork({
    vm_id: opts.row.id,
    action: "verify_host_ready",
    not_before: new Date(
      opts.started_at.getTime() + HOST_READY_VERIFY_DELAY_MS,
    ),
    payload: {
      provider: opts.provider,
      started_at: opts.started_at.toISOString(),
      deadline_at: deadlineAt.toISOString(),
    },
  });
}

async function scheduleSpotProbe(opts: {
  row: any;
  provider?: string;
  not_before: Date;
}) {
  await enqueueCloudVmWorkOnce({
    vm_id: opts.row.id,
    action: "probe_spot",
    not_before: opts.not_before,
    payload: {
      provider: opts.provider,
    },
  });
}

function shouldFallbackToStandard(opts: {
  state: HostSpotRecoveryState | undefined;
  policy: Required<HostSpotRecoveryPolicy>;
  now: Date;
}): boolean {
  if (!opts.policy.standard_fallback_enabled) return false;
  const outageStartedAt = opts.state?.outage_started_at
    ? new Date(opts.state.outage_started_at)
    : undefined;
  const attempts = Number(opts.state?.attempt ?? 0);
  if (
    opts.policy.max_restore_attempts_before_fallback > 0 &&
    attempts >= opts.policy.max_restore_attempts_before_fallback
  ) {
    return true;
  }
  if (!outageStartedAt || Number.isNaN(outageStartedAt.getTime())) return false;
  return (
    opts.now.getTime() - outageStartedAt.getTime() >=
    spotRetryWindowMs(opts.policy)
  );
}

async function scheduleSpotRetry(opts: {
  row: any;
  provider?: string;
  policy: Required<HostSpotRecoveryPolicy>;
  state?: HostSpotRecoveryState;
  reason: string;
  now?: Date;
}) {
  const now = opts.now ?? new Date();
  const attempt = Math.max(1, Number(opts.state?.attempt ?? 0));
  const delayMs = computeSpotRetryDelayMs({
    attempt,
    policy: opts.policy,
  });
  const nextRetryAt = new Date(now.getTime() + delayMs);
  const nextState: HostSpotRecoveryState = {
    ...(opts.state ?? { phase: "retrying_spot" }),
    phase: "retrying_spot",
    outage_started_at: opts.state?.outage_started_at ?? now.toISOString(),
    attempt,
    next_retry_at: nextRetryAt.toISOString(),
  };
  const nextMetadata = withPricingAndRecoveryMetadata(opts.row.metadata, {
    desired_pricing_model: desiredPricingModel(opts.row),
    effective_pricing_model: effectivePricingModel(opts.row),
    spot_recovery_state: clearVerificationFields(nextState),
  });
  await updateHostRow(opts.row.id, {
    status: "starting",
    metadata: nextMetadata,
    last_seen: null,
  });
  await enqueueCloudVmWorkOnce({
    vm_id: opts.row.id,
    action: "start",
    not_before: nextRetryAt,
    payload: {
      provider: opts.provider,
      source: "spot_recovery_retry",
      reason: opts.reason,
    },
  });
  await logCloudVmEvent({
    vm_id: opts.row.id,
    action: "spot_restore_retry_scheduled",
    status: "success",
    provider: opts.provider,
    runtime: {
      next_retry_at: nextRetryAt.toISOString(),
      attempt,
      reason: opts.reason,
    },
  });
}

function shouldUseCloudflareTunnel(row: any): boolean {
  const machine = row?.metadata?.machine ?? {};
  if (machine?.cloud === "self-host") {
    return machine?.metadata?.self_host_mode === "cloudflare";
  }
  return true;
}

function resolveInternalUrlForHost(row: any): string | undefined {
  const providerId = normalizeProviderId(row?.metadata?.machine?.cloud);
  if (providerId === "gcp") {
    return resolveGcpManagedHostInternalUrl({
      runtime: row?.metadata?.runtime,
      tunnelEnabled: shouldUseCloudflareTunnel(row),
    });
  }
  return undefined;
}

async function ensureDnsForHost(row: any) {
  if (!shouldUseCloudflareTunnel(row)) {
    return;
  }
  if (await hasCloudflareTunnel()) {
    try {
      const existing = row.metadata?.cloudflare_tunnel;
      const tunnel = await ensureCloudflareTunnelForHost({
        host_id: row.id,
        existing,
      });
      if (!tunnel) return;
      const tunnelChanged =
        !existing ||
        existing.id !== tunnel.id ||
        existing.hostname !== tunnel.hostname ||
        existing.record_id !== tunnel.record_id ||
        existing.ssh_hostname !== tunnel.ssh_hostname ||
        existing.ssh_record_id !== tunnel.ssh_record_id ||
        existing.token !== tunnel.token;
      const nextMetadata = {
        ...(row.metadata ?? {}),
        cloudflare_tunnel: tunnel,
        ...(tunnelChanged
          ? {
              bootstrap: {
                ...(row.metadata?.bootstrap ?? {}),
                status: "pending",
              },
            }
          : {}),
      };
      row.metadata = nextMetadata;
      const nextUrls = {
        public_url: `https://${tunnel.hostname}`,
        internal_url:
          resolveInternalUrlForHost({
            ...row,
            metadata: nextMetadata,
          }) ?? `https://${tunnel.hostname}`,
      };
      await updateHostRow(row.id, {
        metadata: nextMetadata,
        public_url: nextUrls.public_url,
        internal_url: nextUrls.internal_url,
      });
    } catch (err) {
      logger.warn("cloudflare tunnel ensure failed", {
        host_id: row.id,
        err,
      });
    }
    return;
  }
  if (!row?.metadata?.runtime?.public_ip) return;
  if (!(await hasDns())) return;
  try {
    const dns = await ensureHostDns({
      host_id: row.id,
      ipAddress: row.metadata.runtime.public_ip,
      record_id: row.metadata?.dns?.record_id,
    });
    row.metadata = { ...row.metadata, dns };
    const nextUrls = {
      public_url: `https://${dns.name}`,
      internal_url:
        resolveInternalUrlForHost({
          ...row,
          metadata: row.metadata,
        }) ?? `https://${dns.name}`,
    };
    await updateHostRow(row.id, {
      metadata: row.metadata,
      public_url: nextUrls.public_url,
      internal_url: nextUrls.internal_url,
    });
  } catch (err) {
    logger.warn("dns update failed", { host_id: row.id, err });
  }
}

async function refreshRuntimeNetworkInfo(row: any) {
  const machine: HostMachine = row.metadata?.machine ?? {};
  const runtime = row.metadata?.runtime;
  const providerId = normalizeProviderId(machine.cloud);
  if (!providerId || !runtime?.instance_id) return undefined;
  logger.debug("refreshRuntimeNetworkInfo: fetching", {
    host_id: row.id,
    provider: providerId,
    instance_id: runtime.instance_id,
  });
  const { entry, creds } = await getProviderContext(providerId, {
    region: row.region,
  });
  if (!entry.provider.getInstance) return undefined;
  const instance = await entry.provider.getInstance(runtime, creds);
  const mappedStatus = instance?.status
    ? (entry.provider.mapStatus?.(instance.status) ?? instance.status)
    : undefined;
  const network = {
    public_ip: instance?.public_ip ?? undefined,
    private_ip: instance?.private_ip ?? undefined,
    internal_hostname: instance?.internal_hostname ?? undefined,
    provider_status: instance?.status ?? undefined,
    mapped_status: mappedStatus,
  };
  logger.debug("refreshRuntimeNetworkInfo: result", {
    host_id: row.id,
    provider: providerId,
    instance_id: runtime.instance_id,
    network,
  });
  return network;
}

async function scheduleRuntimeRefresh(row: any, opts?: { force?: boolean }) {
  const runtime = row.metadata?.runtime;
  const providerId = normalizeProviderId(row.metadata?.machine?.cloud);
  const force = !!opts?.force;
  if (!runtime?.instance_id) {
    logger.debug("scheduleRuntimeRefresh: skip (no instance_id)", {
      host_id: row.id,
      provider: providerId ?? row.metadata?.machine?.cloud,
      force,
    });
    return;
  }
  if (runtime.public_ip && !force) {
    logger.debug("scheduleRuntimeRefresh: skip (already has public_ip)", {
      host_id: row.id,
      provider: providerId ?? row.metadata?.machine?.cloud,
      public_ip: runtime.public_ip,
      force,
    });
    return;
  }
  logger.debug("scheduleRuntimeRefresh", {
    host_id: row.id,
    provider: providerId ?? row.metadata?.machine?.cloud,
    instance_id: runtime.instance_id,
    force,
  });
  const enqueueFn = force ? enqueueCloudVmWork : enqueueCloudVmWorkOnce;
  const enqueued = await enqueueFn({
    vm_id: row.id,
    action: "refresh_runtime",
    payload: {
      provider: providerId ?? row.metadata?.machine?.cloud,
      attempt: 0,
      force,
    },
  });
  if (enqueued || force) {
    logger.info("scheduleRuntimeRefresh: enqueue", {
      host_id: row.id,
      provider: providerId ?? row.metadata?.machine?.cloud,
      instance_id: runtime.instance_id,
      force,
    });
  } else {
    logger.debug("scheduleRuntimeRefresh: already queued", {
      host_id: row.id,
      provider: providerId ?? row.metadata?.machine?.cloud,
      instance_id: runtime.instance_id,
    });
  }
}

function maybeReplaceIpInUrl(
  urlValue: string | null | undefined,
  previousIp: string | undefined,
  nextIp: string,
): string | null | undefined {
  if (!urlValue || !previousIp || previousIp === nextIp) return urlValue;
  try {
    const parsed = new URL(urlValue);
    if (parsed.hostname !== previousIp) return urlValue;
    parsed.hostname = nextIp;
    return parsed.toString();
  } catch {
    return urlValue;
  }
}

async function handleProvision(row: any) {
  const machine: HostMachine = row.metadata?.machine ?? {};
  const selfHostMode = machine?.metadata?.self_host_mode;
  const effectiveSelfHostMode =
    machine?.cloud === "self-host" && !selfHostMode ? "local" : selfHostMode;
  const isLocalSelfHost =
    machine?.cloud === "self-host" && effectiveSelfHostMode === "local";
  const providerId = normalizeProviderId(machine.cloud);
  if (!providerId) {
    await updateHostRow(row.id, { status: "running" });
    return;
  }
  if (providerId !== "self-host" && providerId !== "local") {
    const { dns } = await getServerSettings();
    const host = (dns ?? "").trim().toLowerCase();
    const invalid =
      !host ||
      host === "localhost" ||
      host.startsWith("localhost:") ||
      host.startsWith("http://localhost") ||
      host.startsWith("https://localhost") ||
      host.startsWith("http://127.0.0.1") ||
      host.startsWith("https://127.0.0.1") ||
      host.startsWith("127.0.0.1");
    if (invalid) {
      throw new Error(
        "External Domain Name must be configured before provisioning cloud project hosts.",
      );
    }
  }
  logger.debug("handleProvision: begin", {
    host_id: row.id,
    provider: providerId,
  });
  let startupScript: string | undefined;
  if (providerId) {
    try {
      const { baseUrl } = await resolveLaunchpadBootstrapUrl({
        preferCurrentBay: true,
        requirePublic: providerId !== "self-host" && providerId !== "local",
      });
      const token = await createProjectHostBootstrapToken(row.id);
      startupScript = await buildCloudInitStartupScript(
        row,
        token.token,
        baseUrl,
        undefined,
      );
      const nextMetadata = {
        ...(row.metadata ?? {}),
        bootstrap: {
          ...(row.metadata?.bootstrap ?? {}),
          status: "pending",
          pending_at: new Date().toISOString(),
          source: "cloud-init",
        },
      };
      row.metadata = nextMetadata;
      await updateHostRow(row.id, { metadata: nextMetadata });
    } catch (err) {
      logger.warn("cloud-init bootstrap preparation failed", {
        host_id: row.id,
        provider: providerId,
        err,
      });
      if (providerId !== "self-host" && providerId !== "local") {
        throw err;
      }
    }
  }
  const provisioned = await provisionIfNeeded(row, { startupScript });
  const runtime = provisioned.metadata?.runtime;
  const observedAt = new Date();
  let nextMetadata = setRuntimeObservedAt(provisioned.metadata, observedAt);
  logger.debug("handleProvision: runtime", {
    host_id: row.id,
    provider: providerId,
    runtime,
  });
  let nextStatus = provisioned.status ?? "running";
  if (providerId === "lambda" && runtime?.instance_id) {
    await updateHostRow(row.id, {
      status: "starting",
      last_seen: null,
      metadata: nextMetadata,
    });
    const { entry, creds } = await getProviderContext(providerId, {
      region: row.region,
    });
    const waitedStatus = await waitForLambdaStatus({
      entry,
      creds,
      runtime,
      desired: "running",
    });
    const observedAtDone = new Date();
    nextMetadata = setRuntimeObservedAt(nextMetadata, observedAtDone);
    nextStatus = waitedStatus ?? "starting";
  } else if (
    (providerId === "nebius" || providerId === "hyperstack") &&
    runtime?.instance_id
  ) {
    await updateHostRow(row.id, {
      status: "starting",
      last_seen: null,
      metadata: nextMetadata,
    });
    const { entry, creds } = await getProviderContext(providerId, {
      region: row.region,
    });
    const waitedStatus = await waitForProviderStatus({
      entry,
      creds,
      runtime,
      desired: ["running"],
    });
    const observedAtDone = new Date();
    nextMetadata = setRuntimeObservedAt(nextMetadata, observedAtDone);
    nextStatus = waitedStatus ?? "starting";
  }
  const publicUrl = isLocalSelfHost
    ? null
    : (provisioned.public_url ??
      (runtime?.public_ip ? `http://${runtime.public_ip}` : undefined));
  const internalUrl = isLocalSelfHost
    ? null
    : (resolveInternalUrlForHost(provisioned) ??
      provisioned.internal_url ??
      (runtime?.public_ip ? `http://${runtime.public_ip}` : undefined));
  const startedAt = new Date();
  const statusForRecord =
    providerId && providerId !== "self-host" && providerId !== "local"
      ? "starting"
      : nextStatus;
  await updateHostRow(provisioned.id, {
    metadata: nextMetadata,
    status: statusForRecord,
    public_url: publicUrl,
    internal_url: internalUrl,
  });
  await ensureDnsForHost({
    ...provisioned,
    metadata: nextMetadata,
    status: statusForRecord,
    public_url: publicUrl,
    internal_url: internalUrl,
  });
  await scheduleRuntimeRefresh({ ...provisioned, metadata: nextMetadata });
  if (providerId) {
    await scheduleHostReadyVerification({
      row: { ...provisioned, metadata: nextMetadata },
      provider: providerId,
      started_at: startedAt,
    });
  }
  await bumpReconcile(providerId, DEFAULT_INTERVALS.running_ms);
  await logCloudVmEvent({
    vm_id: row.id,
    action: "create",
    status: "success",
    provider: providerId,
    spec: machine,
    runtime: runtime ?? undefined,
  });
}

async function handleStart(row: any) {
  const machine: HostMachine = row.metadata?.machine ?? {};
  const runtime = row.metadata?.runtime;
  const reprovisionRequired = !!row.metadata?.reprovision_required;
  const providerId = normalizeProviderId(machine.cloud);
  const desiredPricing = desiredPricingModel(row);
  const currentEffectivePricing = effectivePricingModel(row);
  const managedSpotRecovery = isSpotRecoveryManagedHost(row);
  const recoveryPolicy = spotRecoveryPolicy(row);
  const currentRecoveryState = spotRecoveryState(row);
  logger.debug("handleStart: begin", {
    host_id: row.id,
    provider: providerId ?? machine.cloud,
    runtime,
    reprovision_required: reprovisionRequired,
  });
  // One-time recovery: if stop previously revoked tokens, restore the latest
  // unexpired bootstrap/master token so persistent VMs can reconnect on boot.
  try {
    const restored = await restoreProjectHostTokensForRestart(row.id);
    if (restored.restored.length > 0) {
      logger.info("handleStart: restored host tokens for restart", {
        host_id: row.id,
        restored: restored.restored,
      });
    }
  } catch (err) {
    logger.warn("handleStart: failed restoring host tokens for restart", {
      host_id: row.id,
      err,
    });
  }
  if (providerId) {
    if (!runtime?.instance_id || reprovisionRequired) {
      // If the VM was deprovisioned, treat "start" as "create" and provision now.
      if (reprovisionRequired && runtime?.instance_id) {
        const { entry, creds } = await getProviderContext(providerId, {
          region: row.region,
        });
        logger.info("handleStart: reprovision delete", {
          host_id: row.id,
          provider: providerId,
          instance_id: runtime.instance_id,
          zone: runtime.zone,
        });
        await entry.provider.deleteHost(runtime, creds, {
          preserveDataDisk: true,
        });
      }
      const clearedMetadata = {
        ...(row.metadata ?? {}),
      };
      if (reprovisionRequired && runtime?.instance_id) {
        const nextMachine = { ...(clearedMetadata.machine ?? {}) };
        const nextMachineMeta = { ...(nextMachine.metadata ?? {}) };
        if (providerId === "gcp") {
          const runtimeMeta = runtime.metadata as
            | { data_disk_name?: string }
            | undefined;
          nextMachineMeta.data_disk_name =
            runtimeMeta?.data_disk_name ?? `${runtime.instance_id}-data`;
        } else if (providerId === "nebius") {
          const runtimeMeta = runtime.metadata as
            | { diskIds?: { data?: string } }
            | undefined;
          if (runtimeMeta?.diskIds?.data) {
            nextMachineMeta.data_disk_id = runtimeMeta.diskIds.data;
          }
        } else if (providerId === "hyperstack") {
          const runtimeMeta = runtime.metadata as
            | { data_volume_id?: number; data_volume_name?: string }
            | undefined;
          if (runtimeMeta?.data_volume_id) {
            nextMachineMeta.data_volume_id = runtimeMeta.data_volume_id;
          }
          if (runtimeMeta?.data_volume_name) {
            nextMachineMeta.data_volume_name = runtimeMeta.data_volume_name;
          }
        }
        nextMachine.metadata = nextMachineMeta;
        clearedMetadata.machine = nextMachine;
      }
      delete clearedMetadata.runtime;
      delete clearedMetadata.dns;
      delete clearedMetadata.cloudflare_tunnel;
      delete clearedMetadata.reprovision_required;
      const rowForProvision = {
        ...row,
        metadata: clearedMetadata,
      };
      const observedAt = new Date();
      const metadataWithObserved = setRuntimeObservedAt(
        rowForProvision.metadata,
        observedAt,
      );
      await updateHostRow(row.id, {
        metadata: metadataWithObserved,
        status: "starting",
        last_seen: null,
        public_url: null,
        internal_url: null,
      });
      await handleProvision({
        ...rowForProvision,
        metadata: metadataWithObserved,
      });
      await logCloudVmEvent({
        vm_id: row.id,
        action: "start",
        status: "success",
        provider: providerId,
        spec: machine,
      });
      return;
    }
    const { entry, creds } = await getProviderContext(providerId, {
      region: row.region,
    });
    const startMode =
      managedSpotRecovery && currentRecoveryState?.phase === "returning_to_spot"
        ? "return_to_spot"
        : managedSpotRecovery && currentEffectivePricing === "on_demand"
          ? "standard"
          : managedSpotRecovery
            ? "spot"
            : "normal";
    let nextRecoveryState = currentRecoveryState
      ? clearVerificationFields(currentRecoveryState)
      : undefined;
    if (managedSpotRecovery && startMode === "spot") {
      nextRecoveryState = {
        ...(nextRecoveryState ?? { phase: "retrying_spot" }),
        phase: "retrying_spot",
        outage_started_at:
          nextRecoveryState?.outage_started_at ?? new Date().toISOString(),
        attempt: Number(nextRecoveryState?.attempt ?? 0) + 1,
      };
    } else if (managedSpotRecovery && startMode === "standard") {
      nextRecoveryState = {
        ...(nextRecoveryState ?? { phase: "running_standard_fallback" }),
        phase: "running_standard_fallback",
        outage_started_at:
          nextRecoveryState?.outage_started_at ?? new Date().toISOString(),
        fallback_started_at:
          nextRecoveryState?.fallback_started_at ?? new Date().toISOString(),
      };
    } else if (managedSpotRecovery && startMode === "return_to_spot") {
      nextRecoveryState = {
        ...(nextRecoveryState ?? { phase: "returning_to_spot" }),
        phase: "returning_to_spot",
        outage_started_at:
          nextRecoveryState?.outage_started_at ?? new Date().toISOString(),
      };
      await logCloudVmEvent({
        vm_id: row.id,
        action: "spot_return_started",
        status: "success",
        provider: providerId,
      });
    }
    let effectivePricingForStart = currentEffectivePricing;
    const updateRecoveryRecord = async (state: HostSpotRecoveryState) => {
      const observedAt = new Date();
      const nextMetadata = withPricingAndRecoveryMetadata(
        setRuntimeObservedAt(row.metadata ?? {}, observedAt),
        {
          desired_pricing_model: desiredPricing,
          effective_pricing_model: effectivePricingForStart,
          spot_recovery_state: state,
        },
      );
      await updateHostRow(row.id, {
        status: "starting",
        last_seen: null,
        metadata: nextMetadata,
      });
      row.metadata = nextMetadata;
      return nextMetadata;
    };
    const promoteToStandardFallback = async (reason: string) => {
      if (!entry.provider.setPricingModel || !recoveryPolicy) {
        throw new Error(
          `standard fallback is not supported for provider '${providerId}'`,
        );
      }
      await entry.provider.setPricingModel(runtime, "on_demand", creds);
      effectivePricingForStart = "on_demand";
      const fallbackState: HostSpotRecoveryState = {
        ...(nextRecoveryState ?? { phase: "running_standard_fallback" }),
        phase: "running_standard_fallback",
        outage_started_at:
          nextRecoveryState?.outage_started_at ?? new Date().toISOString(),
        fallback_started_at: new Date().toISOString(),
      };
      nextRecoveryState =
        clearVerificationFields(fallbackState) ?? fallbackState;
      await updateRecoveryRecord(nextRecoveryState);
      await logCloudVmEvent({
        vm_id: row.id,
        action: "spot_restore_fallback_standard",
        status: "success",
        provider: providerId,
        runtime: { reason },
      });
    };
    if (managedSpotRecovery && nextRecoveryState) {
      await updateRecoveryRecord(nextRecoveryState);
    } else {
      const observedAt = new Date();
      const nextMetadata = setRuntimeObservedAt(row.metadata ?? {}, observedAt);
      await updateHostRow(row.id, {
        status: "starting",
        last_seen: null,
        metadata: nextMetadata,
      });
      row.metadata = nextMetadata;
    }
    let runtimeForStart = runtime;
    try {
      const { baseUrl } = await resolveLaunchpadBootstrapUrl({
        preferCurrentBay: true,
        requirePublic: providerId !== "self-host" && providerId !== "local",
      });
      const token = await createProjectHostBootstrapToken(row.id);
      const startupScript = await buildCloudInitStartupScript(
        row,
        token.token,
        baseUrl,
        undefined,
      );
      runtimeForStart = {
        ...runtime,
        metadata: {
          ...(runtime.metadata ?? {}),
          startup_script: startupScript,
        },
      };
    } catch (err) {
      logger.warn("handleStart: failed preparing startup script refresh", {
        host_id: row.id,
        provider: providerId,
        err,
      });
    }
    try {
      if (managedSpotRecovery && startMode === "return_to_spot") {
        if (!entry.provider.setPricingModel) {
          throw new Error(
            `spot return is not supported for provider '${providerId}'`,
          );
        }
        await entry.provider.stopHost(runtimeForStart, creds);
        if (
          providerId === "gcp" ||
          providerId === "nebius" ||
          providerId === "hyperstack"
        ) {
          await waitForProviderStatus({
            entry,
            creds,
            runtime,
            desired: ["off", "stopped"],
          });
        }
        await entry.provider.setPricingModel(runtimeForStart, "spot", creds);
        effectivePricingForStart = "spot";
        nextRecoveryState = {
          ...(nextRecoveryState ?? { phase: "returning_to_spot" }),
          phase: "returning_to_spot",
          outage_started_at:
            nextRecoveryState?.outage_started_at ?? new Date().toISOString(),
        };
        await updateRecoveryRecord(nextRecoveryState);
      } else if (
        managedSpotRecovery &&
        startMode === "spot" &&
        recoveryPolicy &&
        shouldFallbackToStandard({
          state: nextRecoveryState,
          policy: recoveryPolicy,
          now: new Date(),
        })
      ) {
        await promoteToStandardFallback("retry-window-exhausted");
      }

      await entry.provider.startHost(runtimeForStart, creds);
    } catch (err) {
      if (managedSpotRecovery && recoveryPolicy) {
        if (startMode === "return_to_spot") {
          await logCloudVmEvent({
            vm_id: row.id,
            action: "spot_return_failed",
            status: "failure",
            provider: providerId,
            error: `${err}`,
          });
          await promoteToStandardFallback(`spot-return-failed:${err}`);
          await entry.provider.startHost(runtimeForStart, creds);
        } else if (
          shouldFallbackToStandard({
            state: nextRecoveryState,
            policy: recoveryPolicy,
            now: new Date(),
          })
        ) {
          await logCloudVmEvent({
            vm_id: row.id,
            action: "spot_restore_retry_failed",
            status: "failure",
            provider: providerId,
            error: `${err}`,
          });
          await promoteToStandardFallback(`spot-start-failed:${err}`);
          await entry.provider.startHost(runtimeForStart, creds);
        } else {
          await logCloudVmEvent({
            vm_id: row.id,
            action: "spot_restore_retry_failed",
            status: "failure",
            provider: providerId,
            error: `${err}`,
          });
          await scheduleSpotRetry({
            row,
            provider: providerId,
            policy: recoveryPolicy,
            state: nextRecoveryState,
            reason: `${err}`,
          });
          await bumpReconcile(providerId, DEFAULT_INTERVALS.running_ms);
          return;
        }
      } else {
        throw err;
      }
    }
    let statusAfterStart:
      | "running"
      | "starting"
      | "off"
      | "stopped"
      | "error"
      | undefined;
    if (
      providerId === "gcp" ||
      providerId === "nebius" ||
      providerId === "hyperstack"
    ) {
      statusAfterStart = await waitForProviderStatus({
        entry,
        creds,
        runtime,
        desired: ["running"],
      });
      const normalizedStatus =
        statusAfterStart === "stopped" ? "off" : statusAfterStart;
      if (normalizedStatus !== "running") {
        if (managedSpotRecovery && recoveryPolicy) {
          if (
            shouldFallbackToStandard({
              state: nextRecoveryState,
              policy: recoveryPolicy,
              now: new Date(),
            })
          ) {
            await promoteToStandardFallback(
              `provider-status:${normalizedStatus ?? "unknown"}`,
            );
          } else {
            await scheduleSpotRetry({
              row,
              provider: providerId,
              policy: recoveryPolicy,
              state: nextRecoveryState,
              reason: `provider-status:${normalizedStatus ?? "unknown"}`,
            });
            await bumpReconcile(providerId, DEFAULT_INTERVALS.running_ms);
            return;
          }
        }
        const observedAtDone = new Date();
        const nextMetadataAfter = setRuntimeObservedAt(
          row.metadata ?? {},
          observedAtDone,
        );
        await updateHostRow(row.id, {
          status: normalizedStatus ?? "starting",
          metadata: nextMetadataAfter,
          last_seen: null,
        });
        row.metadata = nextMetadataAfter;
        await bumpReconcile(providerId, DEFAULT_INTERVALS.running_ms);
        return;
      }
    }
    const startedAt = new Date();
    const verificationState: HostSpotRecoveryState | undefined =
      managedSpotRecovery
        ? {
            ...(nextRecoveryState ?? { phase: "idle" }),
            phase:
              effectivePricingForStart === "on_demand"
                ? "running_standard_fallback"
                : startMode === "return_to_spot"
                  ? "returning_to_spot"
                  : "retrying_spot",
            verification_started_at: startedAt.toISOString(),
            verification_deadline_at: new Date(
              startedAt.getTime() + HOST_READY_VERIFY_DEADLINE_MS,
            ).toISOString(),
            ...(effectivePricingForStart === "on_demand"
              ? {
                  fallback_started_at:
                    nextRecoveryState?.fallback_started_at ??
                    new Date().toISOString(),
                }
              : {}),
          }
        : undefined;
    const observedAt = new Date();
    const nextMetadata = withPricingAndRecoveryMetadata(
      setRuntimeObservedAt(row.metadata ?? {}, observedAt),
      {
        desired_pricing_model: desiredPricing,
        effective_pricing_model: effectivePricingForStart,
        spot_recovery_state: verificationState ?? null,
      },
    );
    await updateHostRow(row.id, {
      status: "starting",
      metadata: nextMetadata,
      last_seen: null,
    });
    const nextRow = { ...row, status: "starting", metadata: nextMetadata };
    await ensureDnsForHost(nextRow);
    await scheduleRuntimeRefresh(nextRow, { force: providerId === "gcp" });
    await scheduleHostReadyVerification({
      row: nextRow,
      provider: providerId,
      started_at: startedAt,
      deadline_at: new Date(
        startedAt.getTime() + HOST_READY_VERIFY_DEADLINE_MS,
      ),
    });
    await bumpReconcile(providerId, DEFAULT_INTERVALS.running_ms);
    await logCloudVmEvent({
      vm_id: row.id,
      action: "start",
      status: "success",
      provider: providerId ?? machine.cloud,
      spec: machine,
      runtime,
    });
    return;
  }
  const observedAt = new Date();
  const nextMetadata = setRuntimeObservedAt(row.metadata ?? {}, observedAt);
  await updateHostRow(row.id, {
    status: "running",
    metadata: nextMetadata,
  });
  const nextRow = { ...row, status: "running", metadata: nextMetadata };
  await ensureDnsForHost(nextRow);
  await scheduleRuntimeRefresh(nextRow, { force: providerId === "gcp" });
  if (providerId) {
    await bumpReconcile(providerId, DEFAULT_INTERVALS.running_ms);
  }
  await logCloudVmEvent({
    vm_id: row.id,
    action: "start",
    status: "success",
    provider: providerId ?? machine.cloud,
    spec: machine,
    runtime,
  });
}

async function handleStop(row: any) {
  const machine: HostMachine = row.metadata?.machine ?? {};
  const runtime = row.metadata?.runtime;
  const providerId = normalizeProviderId(machine.cloud);
  // Do not revoke bootstrap/master-conat tokens on stop: a stopped VM may
  // restart from the same persistent disk and must still authenticate.
  // Token revocation is handled on deprovision/delete.
  let supportsStop = true;
  let stopConfirmed = false;
  if (providerId && runtime?.instance_id) {
    const observedAt = new Date();
    const nextMetadata = setRuntimeObservedAt(row.metadata ?? {}, observedAt);
    await updateHostRow(row.id, {
      status: "stopping",
      last_seen: null,
      metadata: nextMetadata,
    });
    const { entry, creds } = await getProviderContext(providerId, {
      region: row.region,
    });
    supportsStop = entry.capabilities.supportsStop;
    await entry.provider.stopHost(runtime, creds);
    if (providerId === "nebius" || providerId === "hyperstack") {
      const waitedStatus = await waitForProviderStatus({
        entry,
        creds,
        runtime,
        desired: ["off", "stopped"],
      });
      const observedAtDone = new Date();
      const nextMetadataAfter = setRuntimeObservedAt(
        row.metadata ?? {},
        observedAtDone,
      );
      await updateHostRow(row.id, {
        status: waitedStatus ?? "stopping",
        metadata: nextMetadataAfter,
        last_seen: null,
      });
      stopConfirmed = waitedStatus === "off" || waitedStatus === "stopped";
    }
  }
  if (providerId === "hyperstack") {
    if (!stopConfirmed) {
      await bumpReconcile(providerId, DEFAULT_INTERVALS.running_ms);
      return;
    }
    if (!(await hasCloudflareTunnel()) && (await hasDns())) {
      await deleteHostDns({ record_id: row.metadata?.dns?.record_id });
    }
    const nextMetadata = {
      ...(row.metadata ?? {}),
    };
    delete nextMetadata.runtime;
    delete nextMetadata.dns;
    delete nextMetadata.cloudflare_tunnel;
    await updateHostRow(row.id, {
      metadata: nextMetadata,
      status: "off",
      public_url: null,
      internal_url: null,
      last_seen: null,
    });
  } else if (providerId === "lambda") {
    const { entry, creds } = await getProviderContext(providerId, {
      region: row.region,
    });
    const gone = await waitForLambdaInstanceGone({ entry, creds, runtime });
    if (!gone) {
      await bumpReconcile(providerId, DEFAULT_INTERVALS.running_ms);
      return;
    }
    const nextMetadata = {
      ...(row.metadata ?? {}),
    };
    delete nextMetadata.runtime;
    delete nextMetadata.dns;
    delete nextMetadata.cloudflare_tunnel;
    await updateHostRow(row.id, {
      metadata: nextMetadata,
      status: "deprovisioned",
      public_url: null,
      internal_url: null,
      last_seen: null,
    });
  } else if (providerId && !supportsStop) {
    // Providers without a stop state (e.g., Lambda) should be treated as
    // deprovisioned when "stop" is requested.
    const nextMetadata = {
      ...(row.metadata ?? {}),
    };
    delete nextMetadata.runtime;
    delete nextMetadata.dns;
    delete nextMetadata.cloudflare_tunnel;
    await updateHostRow(row.id, {
      metadata: nextMetadata,
      status: "deprovisioned",
      public_url: null,
      internal_url: null,
      last_seen: null,
    });
  } else {
    if (providerId === "nebius" && !stopConfirmed) {
      if (providerId) {
        await bumpReconcile(providerId, DEFAULT_INTERVALS.running_ms);
      }
      return;
    }
    const observedAt = new Date();
    const nextMetadata = setRuntimeObservedAt(row.metadata ?? {}, observedAt);
    await updateHostRow(row.id, {
      status: "off",
      metadata: nextMetadata,
    });
  }
  await logCloudVmEvent({
    vm_id: row.id,
    action: "stop",
    status: "success",
    provider: providerId ?? machine.cloud,
    spec: machine,
    runtime,
  });
}

async function handleRestart(row: any, mode: "reboot" | "hard") {
  const machine: HostMachine = row.metadata?.machine ?? {};
  const runtime = row.metadata?.runtime;
  const providerId = normalizeProviderId(machine.cloud);
  logger.debug("handleRestart: begin", {
    host_id: row.id,
    provider: providerId ?? machine.cloud,
    mode,
    runtime,
  });
  if (!providerId) {
    await updateHostRow(row.id, { status: "running", last_seen: new Date() });
    return;
  }
  if (!runtime?.instance_id) {
    throw new Error("host is not provisioned");
  }
  const { entry, creds } = await getProviderContext(providerId, {
    region: row.region,
  });
  const provider = entry.provider;
  let runtimeForRestart = runtime;
  try {
    const { baseUrl } = await resolveLaunchpadBootstrapUrl({
      preferCurrentBay: true,
      requirePublic: providerId !== "self-host" && providerId !== "local",
    });
    const token = await createProjectHostBootstrapToken(row.id);
    const startupScript = await buildCloudInitStartupScript(
      row,
      token.token,
      baseUrl,
      undefined,
    );
    runtimeForRestart = {
      ...runtime,
      metadata: {
        ...(runtime.metadata ?? {}),
        startup_script: startupScript,
      },
    };
  } catch (err) {
    logger.warn("handleRestart: failed preparing startup script refresh", {
      host_id: row.id,
      provider: providerId,
      err,
    });
  }
  const observedAt = new Date();
  const nextMetadata = setRuntimeObservedAt(row.metadata ?? {}, observedAt);
  await updateHostRow(row.id, {
    status: "restarting",
    last_seen: null,
    metadata: nextMetadata,
  });
  if (mode === "hard") {
    if (provider.hardRestartHost) {
      await provider.hardRestartHost(runtimeForRestart, creds);
    } else if (provider.restartHost) {
      await provider.restartHost(runtimeForRestart, creds);
    } else if (entry.capabilities.supportsStop) {
      await provider.stopHost(runtimeForRestart, creds);
      await provider.startHost(runtimeForRestart, creds);
    } else {
      throw new Error("hard reboot not supported");
    }
  } else {
    if (provider.restartHost) {
      await provider.restartHost(runtimeForRestart, creds);
    } else if (entry.capabilities.supportsStop) {
      await provider.stopHost(runtimeForRestart, creds);
      await provider.startHost(runtimeForRestart, creds);
    } else if (provider.hardRestartHost) {
      await provider.hardRestartHost(runtimeForRestart, creds);
    } else {
      throw new Error("reboot not supported");
    }
  }
  const observedAtComplete = new Date();
  const nextMetadataComplete = setRuntimeObservedAt(
    row.metadata ?? {},
    observedAtComplete,
  );
  await updateHostRow(row.id, {
    status: "running",
    metadata: nextMetadataComplete,
  });
  await scheduleRuntimeRefresh(
    { ...row, metadata: nextMetadataComplete },
    { force: providerId === "gcp" },
  );
  await bumpReconcile(providerId, DEFAULT_INTERVALS.running_ms);
  await logCloudVmEvent({
    vm_id: row.id,
    action: mode === "hard" ? "hard_restart" : "restart",
    status: "success",
    provider: providerId,
    spec: machine,
    runtime,
  });
}

async function handleDelete(row: any) {
  const machine: HostMachine = row.metadata?.machine ?? {};
  const runtime = row.metadata?.runtime;
  const providerId = normalizeProviderId(machine.cloud);
  await revokeProjectHostTokensForHost(row.id, { purpose: "bootstrap" });
  await revokeProjectHostTokensForHost(row.id, { purpose: "master-conat" });
  if (providerId && runtime?.instance_id) {
    const { entry, creds } = await getProviderContext(providerId, {
      region: row.region,
    });
    await entry.provider.deleteHost(runtime, creds);
  }
  if (shouldUseCloudflareTunnel(row) && (await hasCloudflareTunnel())) {
    await deleteCloudflareTunnel({
      host_id: row.id,
      tunnel: row.metadata?.cloudflare_tunnel,
    });
  } else if (await hasDns()) {
    await deleteHostDns({ record_id: row.metadata?.dns?.record_id });
  }
  await logCloudVmEvent({
    vm_id: row.id,
    action: "delete",
    status: "success",
    provider: providerId ?? machine.cloud,
    spec: machine,
    runtime,
  });
  // set the project host to a deprovisioned state, which means all
  // the data stored there is definitely gone and no dns is setup.
  const nextMetadata = {
    ...(row.metadata ?? {}),
  };
  delete nextMetadata.runtime;
  delete nextMetadata.dns;
  delete nextMetadata.cloudflare_tunnel;
  delete nextMetadata.runtime_deployments;
  await clearProjectHostRuntimeDeployments({
    scope_type: "host",
    host_id: row.id,
  });
  await updateHostRow(row.id, {
    metadata: nextMetadata,
    status: "deprovisioned",
    public_url: null,
    internal_url: null,
    last_seen: null,
  });
}

async function handleRefreshRuntime(row: any) {
  const host = row;
  const runtime = host.metadata?.runtime;
  if (!runtime?.instance_id) return;
  const machine: HostMachine = host.metadata?.machine ?? {};
  const selfHostMode = machine?.metadata?.self_host_mode;
  const effectiveSelfHostMode =
    machine?.cloud === "self-host" && !selfHostMode ? "local" : selfHostMode;
  const isLocalSelfHost =
    machine?.cloud === "self-host" && effectiveSelfHostMode === "local";
  if (isLocalSelfHost) return;
  const force = !!row.payload?.force;
  const providerId = normalizeProviderId(host.metadata?.machine?.cloud);
  const needsGcpNetworkRepair =
    providerId === "gcp" &&
    (!`${runtime.private_ip ?? ""}`.trim() || !resolveInternalUrlForHost(host));
  if (runtime.public_ip && !force && !needsGcpNetworkRepair) return;
  logger.debug("handleRefreshRuntime", {
    host_id: host.id,
    provider: providerId ?? host.metadata?.machine?.cloud,
    instance_id: runtime.instance_id,
    attempt: row.payload?.attempt ?? 0,
    force,
  });
  logger.info("handleRefreshRuntime: attempt", {
    host_id: host.id,
    provider: providerId ?? host.metadata?.machine?.cloud,
    instance_id: runtime.instance_id,
    attempt: row.payload?.attempt ?? 0,
    force,
  });
  const network = await refreshRuntimeNetworkInfo(host);
  if (
    !network?.public_ip &&
    !network?.private_ip &&
    !network?.internal_hostname
  ) {
    const attempt = Number(row.payload?.attempt ?? 0);
    logger.debug("handleRefreshRuntime: still missing", {
      host_id: host.id,
      provider: providerId ?? host.metadata?.machine?.cloud,
      instance_id: runtime.instance_id,
      attempt,
    });
    if (attempt < 12) {
      await enqueueCloudVmWorkOnce({
        vm_id: host.id,
        action: "refresh_runtime",
        not_before: new Date(Date.now() + 10_000),
        payload: {
          provider: providerId ?? host.metadata?.machine?.cloud,
          attempt: attempt + 1,
        },
      });
    }
    return;
  }
  logger.info("handleRefreshRuntime: obtained", {
    host_id: host.id,
    provider: host.metadata?.machine?.cloud,
    instance_id: runtime.instance_id,
    network,
  });
  const mappedProviderStatus = network?.mapped_status as
    | "running"
    | "starting"
    | "off"
    | "stopped"
    | "error"
    | undefined;
  const nextMetadata = {
    ...(host.metadata ?? {}),
    runtime: {
      ...runtime,
      ...(network?.public_ip ? { public_ip: network.public_ip } : {}),
      ...(network?.private_ip ? { private_ip: network.private_ip } : {}),
      ...(network?.internal_hostname
        ? { internal_hostname: network.internal_hostname }
        : {}),
      ...(network?.provider_status
        ? { provider_status: network.provider_status }
        : {}),
    },
  };
  if (mappedProviderStatus && mappedProviderStatus !== "running") {
    const nextStatus =
      mappedProviderStatus === "stopped" ? "off" : mappedProviderStatus;
    await updateHostRow(host.id, {
      metadata: nextMetadata,
      status: nextStatus,
      last_seen: null,
    });
    const nextHost = {
      ...host,
      status: nextStatus,
      metadata: nextMetadata,
    };
    if (
      providerId &&
      nextStatus === "off" &&
      shouldAutoRestoreInterruptedSpotHost(nextHost)
    ) {
      await enqueueCloudVmWorkOnce({
        vm_id: host.id,
        action: "start",
        payload: {
          source: "refresh_runtime",
          reason: network?.provider_status
            ? `provider-status:${network.provider_status}`
            : "provider-offline",
        },
      });
      await bumpReconcile(providerId, 1000);
    } else if (providerId) {
      await bumpReconcile(providerId, DEFAULT_INTERVALS.running_ms);
    }
    await logCloudVmEvent({
      vm_id: host.id,
      action: "refresh_runtime",
      status: "success",
      provider: providerId ?? host.metadata?.machine?.cloud,
      runtime: {
        ...runtime,
        ...(network?.public_ip ? { public_ip: network.public_ip } : {}),
        ...(network?.private_ip ? { private_ip: network.private_ip } : {}),
        ...(network?.internal_hostname
          ? { internal_hostname: network.internal_hostname }
          : {}),
        ...(network?.provider_status
          ? { provider_status: network.provider_status }
          : {}),
      },
    });
    return;
  }
  const previousIp = `${runtime.public_ip ?? ""}`.trim() || undefined;
  const publicUrl =
    (network?.public_ip
      ? maybeReplaceIpInUrl(host.public_url, previousIp, network.public_ip)
      : undefined) ??
    host.public_url ??
    (network?.public_ip ? `http://${network.public_ip}` : undefined);
  const internalUrl =
    resolveInternalUrlForHost({
      ...host,
      metadata: nextMetadata,
    }) ??
    (network?.public_ip
      ? maybeReplaceIpInUrl(host.internal_url, previousIp, network.public_ip)
      : undefined) ??
    host.internal_url ??
    (network?.public_ip ? `http://${network.public_ip}` : undefined);
  const nextStatus = host.status;
  await updateHostRow(host.id, {
    metadata: nextMetadata,
    public_url: publicUrl,
    internal_url: internalUrl,
    status: nextStatus,
  });
  const nextHost = {
    ...host,
    status: nextStatus,
    metadata: nextMetadata,
    public_url: publicUrl,
    internal_url: internalUrl,
  };
  await ensureDnsForHost(nextHost);
  await logCloudVmEvent({
    vm_id: host.id,
    action: "refresh_runtime",
    status: "success",
    provider: providerId ?? host.metadata?.machine?.cloud,
    runtime: { ...runtime, ...network },
  });
}

async function handleVerifyHostReady(row: any) {
  const host = await loadHostRow(row.vm_id);
  if (!host) return;
  const providerId = normalizeProviderId(host.metadata?.machine?.cloud);
  const startedAtIso = `${row.payload?.started_at ?? ""}`.trim();
  const deadlineAtIso = `${row.payload?.deadline_at ?? ""}`.trim();
  if (hostIsOperationalSince(host, startedAtIso)) {
    if (isSpotRecoveryManagedHost(host)) {
      const policy = spotRecoveryPolicy(host);
      const state = spotRecoveryState(host);
      const effective = effectivePricingModel(host);
      const desired = desiredPricingModel(host);
      if (effective === "on_demand") {
        const fallbackState: HostSpotRecoveryState = clearVerificationFields({
          ...(state ?? { phase: "running_standard_fallback" }),
          phase: "running_standard_fallback",
          fallback_started_at:
            state?.fallback_started_at ?? new Date().toISOString(),
        }) ?? { phase: "running_standard_fallback" };
        const nextMetadata = withPricingAndRecoveryMetadata(
          clearHostLastErrorMetadata(host.metadata),
          {
            desired_pricing_model: desired,
            effective_pricing_model: effective,
            spot_recovery_state: fallbackState,
          },
        );
        await updateHostRow(host.id, { metadata: nextMetadata });
        if (policy) {
          const fallbackStartedAt = fallbackState.fallback_started_at
            ? new Date(fallbackState.fallback_started_at)
            : new Date();
          await scheduleSpotProbe({
            row: { ...host, metadata: nextMetadata },
            provider: providerId ?? host.metadata?.machine?.cloud,
            not_before: new Date(
              Math.max(
                Date.now(),
                fallbackStartedAt.getTime() + standardFallbackMinMs(policy),
              ),
            ),
          });
        }
      } else {
        const idleState: HostSpotRecoveryState = {
          phase: "idle",
          ...(state?.last_probe_at
            ? { last_probe_at: state.last_probe_at }
            : {}),
          ...(state?.last_probe_result
            ? { last_probe_result: state.last_probe_result }
            : {}),
          ...(state?.last_probe_error
            ? { last_probe_error: state.last_probe_error }
            : {}),
        };
        const nextMetadata = withPricingAndRecoveryMetadata(
          clearHostLastErrorMetadata(host.metadata),
          {
            desired_pricing_model: desired,
            effective_pricing_model: effective,
            spot_recovery_state: idleState,
          },
        );
        await updateHostRow(host.id, { metadata: nextMetadata });
        if (state?.phase === "returning_to_spot") {
          await logCloudVmEvent({
            vm_id: host.id,
            action: "spot_return_succeeded",
            status: "success",
            provider: providerId ?? host.metadata?.machine?.cloud,
          });
        }
      }
    }
    return;
  }

  const deadlineAt = deadlineAtIso ? new Date(deadlineAtIso) : undefined;
  if (
    deadlineAt &&
    Number.isFinite(deadlineAt.getTime()) &&
    Date.now() >= deadlineAt.getTime()
  ) {
    logger.warn("verify host ready timed out", {
      host_id: host.id,
      provider: providerId ?? host.metadata?.machine?.cloud,
      started_at: startedAtIso || undefined,
      deadline_at: deadlineAtIso || undefined,
      status: host.status,
      last_seen: host.last_seen,
    });
    if (isSpotRecoveryManagedHost(host)) {
      const policy = spotRecoveryPolicy(host);
      const state = spotRecoveryState(host);
      if (
        policy &&
        effectivePricingModel(host) === "on_demand" &&
        state?.phase === "running_standard_fallback"
      ) {
        await scheduleSpotProbe({
          row: host,
          provider: providerId ?? host.metadata?.machine?.cloud,
          not_before: new Date(Date.now() + spotProbeIntervalMs(policy)),
        });
      }
    }
    throw new Error(
      `host did not become ready before the startup deadline (${deadlineAt.toISOString()})`,
    );
  }

  await enqueueCloudVmWork({
    vm_id: host.id,
    action: "verify_host_ready",
    not_before: new Date(Date.now() + HOST_READY_VERIFY_DELAY_MS),
    payload: {
      ...row.payload,
      provider: providerId ?? host.metadata?.machine?.cloud,
    },
  });
}

async function handleProbeSpot(row: any) {
  const host = await loadHostRow(row.vm_id);
  if (!host) return;
  if (!isSpotRecoveryManagedHost(host)) return;
  if (effectivePricingModel(host) !== "on_demand") return;
  const policy = spotRecoveryPolicy(host);
  const state = spotRecoveryState(host);
  const providerId = normalizeProviderId(host.metadata?.machine?.cloud);
  if (!providerId || !policy) return;
  const { entry, creds } = await getProviderContext(providerId, {
    region: host.region,
  });
  if (!entry.provider.probeSpotAvailability) return;
  const probingState: HostSpotRecoveryState = {
    ...(state ?? { phase: "probing_spot" }),
    phase: "probing_spot",
    last_probe_at: new Date().toISOString(),
  };
  const probingMetadata = withPricingAndRecoveryMetadata(host.metadata, {
    desired_pricing_model: desiredPricingModel(host),
    effective_pricing_model: "on_demand",
    spot_recovery_state: probingState,
  });
  await updateHostRow(host.id, { metadata: probingMetadata });
  await logCloudVmEvent({
    vm_id: host.id,
    action: "spot_probe_started",
    status: "success",
    provider: providerId,
  });
  const spec = {
    ...(await buildHostSpec({ ...host, metadata: probingMetadata })),
    pricing_model: "spot" as const,
  };
  const available = await entry.provider.probeSpotAvailability(spec, creds);
  if (!available) {
    const failedState: HostSpotRecoveryState = {
      ...(probingState ?? { phase: "running_standard_fallback" }),
      phase: "running_standard_fallback",
      last_probe_at: new Date().toISOString(),
      last_probe_result: "failure",
      last_probe_error: "spot probe failed",
    };
    const failedMetadata = withPricingAndRecoveryMetadata(host.metadata, {
      desired_pricing_model: desiredPricingModel(host),
      effective_pricing_model: "on_demand",
      spot_recovery_state: failedState,
    });
    await updateHostRow(host.id, { metadata: failedMetadata });
    await logCloudVmEvent({
      vm_id: host.id,
      action: "spot_probe_failed",
      status: "failure",
      provider: providerId,
      error: "spot probe failed",
    });
    await scheduleSpotProbe({
      row: { ...host, metadata: failedMetadata },
      provider: providerId,
      not_before: new Date(Date.now() + spotProbeIntervalMs(policy)),
    });
    return;
  }
  const successState: HostSpotRecoveryState = {
    ...(probingState ?? { phase: "returning_to_spot" }),
    phase: "returning_to_spot",
    last_probe_at: new Date().toISOString(),
    last_probe_result: "success",
  };
  delete successState.last_probe_error;
  const successMetadata = withPricingAndRecoveryMetadata(host.metadata, {
    desired_pricing_model: desiredPricingModel(host),
    effective_pricing_model: "on_demand",
    spot_recovery_state: successState,
  });
  await updateHostRow(host.id, {
    metadata: successMetadata,
    status: "starting",
    last_seen: null,
  });
  await logCloudVmEvent({
    vm_id: host.id,
    action: "spot_probe_succeeded",
    status: "success",
    provider: providerId,
  });
  await enqueueCloudVmWorkOnce({
    vm_id: host.id,
    action: "start",
    payload: {
      provider: providerId,
      source: "spot_probe_success",
      reason: "spot_probe_succeeded",
    },
  });
}

async function markHostError(
  row: any,
  err: unknown,
  opts?: { action?: string; originalRow?: any },
) {
  const message = err ? String(err) : "unknown error";
  const currentRow = (await loadHostRow(row.id)) ?? row;
  if (
    shouldResetToStoppedAfterStartFailure({
      action: opts?.action,
      currentRow,
      originalRow: opts?.originalRow ?? row,
    })
  ) {
    await updateHostRow(row.id, {
      metadata: sanitizedMetadataForFailedStart({
        metadata: currentRow.metadata ?? {},
        message,
        originalRow: opts?.originalRow ?? row,
      }),
      status: "off",
      last_seen: null,
      public_url: null,
      internal_url: null,
    });
    return;
  }
  const nextMetadata = {
    ...(currentRow.metadata ?? {}),
    last_error: message,
    last_error_at: new Date().toISOString(),
  };
  await updateHostRow(row.id, {
    metadata: nextMetadata,
    status: "error",
    last_seen: null,
  });
}

export const cloudHostHandlers: CloudVmWorkHandlers = {
  provision: async (row) => {
    const host = await loadHostRow(row.vm_id);
    if (!host) return;
    try {
      await handleProvision(host);
    } catch (err) {
      await markHostError(host, err, {
        action: "provision",
        originalRow: host,
      });
      throw err;
    }
  },
  start: async (row) => {
    const host = await loadHostRow(row.vm_id);
    if (!host) return;
    try {
      await handleStart(host);
    } catch (err) {
      await markHostError(host, err, { action: "start", originalRow: host });
      throw err;
    }
  },
  stop: async (row) => {
    const host = await loadHostRow(row.vm_id);
    if (!host) return;
    try {
      await handleStop(host);
    } catch (err) {
      await markHostError(host, err);
      throw err;
    }
  },
  restart: async (row) => {
    const host = await loadHostRow(row.vm_id);
    if (!host) return;
    try {
      await handleRestart(host, "reboot");
    } catch (err) {
      await markHostError(host, err);
      throw err;
    }
  },
  hard_restart: async (row) => {
    const host = await loadHostRow(row.vm_id);
    if (!host) return;
    try {
      await handleRestart(host, "hard");
    } catch (err) {
      await markHostError(host, err);
      throw err;
    }
  },
  delete: async (row) => {
    const host = await loadHostRow(row.vm_id);
    if (!host) return;
    try {
      await handleDelete(host);
    } catch (err) {
      await markHostError(host, err);
      throw err;
    }
  },
  refresh_runtime: async (row) => {
    const host = await loadHostRow(row.vm_id);
    if (!host) return;
    try {
      await handleRefreshRuntime({
        ...host,
        payload: row.payload,
      });
    } catch (err) {
      await markHostError(host, err);
      throw err;
    }
  },
  verify_host_ready: async (row) => {
    try {
      await handleVerifyHostReady(row);
    } catch (err) {
      const host = await loadHostRow(row.vm_id);
      if (host) {
        await markHostError(host, err);
      }
      throw err;
    }
  },
  probe_spot: async (row) => {
    try {
      await handleProbeSpot(row);
    } catch (err) {
      const host = await loadHostRow(row.vm_id);
      if (host) {
        await markHostError(host, err);
      }
      throw err;
    }
  },
  bootstrap: async (row) => {
    const host = await loadHostRow(row.vm_id);
    if (!host) return;
    try {
      await handleBootstrap(host);
    } catch (err) {
      const metadata = host.metadata ?? {};
      await updateHostRow(host.id, {
        metadata: {
          ...metadata,
          bootstrap: {
            status: "error",
            error: String(err),
            failed_at: new Date().toISOString(),
          },
        },
      });
      await markHostError(host, err);
      throw err;
    }
  },
};
