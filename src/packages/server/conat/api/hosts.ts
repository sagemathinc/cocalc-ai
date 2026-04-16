import { spawn } from "node:child_process";
import { randomUUID } from "crypto";
import { delay } from "awaiting";
import type {
  Host,
  HostBackupStatus,
  HostBootstrapStatus,
  HostBootstrapLifecycle,
  HostBootstrapLifecycleItem,
  HostConnectionInfo,
  HostDrainResult,
  HostMachine,
  HostStatus,
  HostCatalog,
  HostSoftwareArtifact,
  HostSoftwareAvailableVersion,
  HostSoftwareChannel,
  HostSoftwareUpgradeTarget,
  HostSoftwareUpgradeResponse,
  HostRuntimeArtifact,
  HostRuntimeArtifactObservation,
  HostRuntimeDeploymentRecord,
  HostRuntimeDeploymentObservedTarget,
  HostRuntimeRollbackTarget,
  HostRuntimeDeploymentTarget,
  HostRuntimeDeploymentRollbackResult,
  HostRuntimeDeploymentReconcileResult,
  HostRuntimeDeploymentObservedVersionState,
  HostRuntimeDeploymentScopeType,
  HostRuntimeDeploymentStatus,
  HostRuntimeDeploymentUpsert,
  HostLroResponse,
  HostLroKind,
  HostProjectRow,
  HostProjectsResponse,
  HostManagedRootfsReleaseLifecycle,
  HostRootfsGcResult,
  HostRootfsImage,
  HostPricingModel,
  HostInterruptionRestorePolicy,
  HostCurrentMetrics,
  HostMetricsHistory,
  HostManagedComponentRolloutRequest,
} from "@cocalc/conat/hub/api/hosts";
import type {
  HostManagedComponentRolloutResponse,
  HostManagedComponentStatus,
  ManagedComponentKind,
} from "@cocalc/conat/project-host/api";
import type {
  ProjectCopyRow,
  ProjectCopyState,
} from "@cocalc/conat/hub/api/projects";
import { issueProjectHostAuthToken as issueProjectHostAuthTokenJwt } from "@cocalc/conat/auth/project-host-token";
import getLogger from "@cocalc/backend/logger";
import { getProjectHostAuthTokenPrivateKey } from "@cocalc/backend/data";
import getPool from "@cocalc/database/pool";
import { appendProjectOutboxEventForProject } from "@cocalc/database/postgres/project-events-outbox";
import { publishProjectAccountFeedEventsBestEffort } from "@cocalc/server/account/project-feed";
import {
  computePlacementPermission,
  getUserHostTier,
} from "@cocalc/server/project-host/placement";
import { maybeAutoGrowHostDiskForReservationFailure } from "@cocalc/server/project-host/auto-grow";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";
import {
  enqueueCloudVmWork,
  listCloudVmLog,
  logCloudVmEvent,
  refreshCloudCatalogNow,
  deleteHostDns,
  hasDns,
} from "@cocalc/server/cloud";
import { sendSelfHostCommand } from "@cocalc/server/self-host/commands";
import isAdmin from "@cocalc/server/accounts/is-admin";
import isBanned from "@cocalc/server/accounts/is-banned";
import { normalizeProviderId, type ProviderId } from "@cocalc/cloud";
import {
  gcpSafeName,
  getProviderPrefix,
  getServerProvider,
  listServerProviders,
} from "@cocalc/server/cloud/providers";
import { getProviderContext } from "@cocalc/server/cloud/provider-context";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import siteURL from "@cocalc/database/settings/site-url";
import {
  createProjectHostBootstrapToken,
  revokeProjectHostTokensForHost,
} from "@cocalc/server/project-host/bootstrap-token";
import {
  claimPendingCopies as claimPendingCopiesDb,
  updateCopyStatus as updateCopyStatusDb,
} from "@cocalc/server/projects/copy-db";
import sshKeys from "@cocalc/server/projects/get-ssh-keys";
import { createLro } from "@cocalc/server/lro/lro-db";
import { publishLroEvent, publishLroSummary } from "@cocalc/server/lro/stream";
import { lroStreamName } from "@cocalc/conat/lro/names";
import { DEFAULT_PROJECT_IMAGE } from "@cocalc/util/db-schema/defaults";
import { SERVICE as PERSIST_SERVICE } from "@cocalc/conat/persist/util";
import {
  machineHasGpu,
  normalizeMachineGpuInPlace,
} from "@cocalc/server/cloud/host-gpu";
import { desiredHostState } from "@cocalc/server/cloud/spot-restore";
import {
  createConnectorRecord,
  ensureConnectorRecord,
  revokeConnector,
  createPairingTokenForHost,
} from "@cocalc/server/self-host/connector-tokens";
import {
  getExternalCredential as getExternalCredentialDb,
  hasExternalCredential as hasExternalCredentialDb,
  touchExternalCredential as touchExternalCredentialDb,
  upsertExternalCredential as upsertExternalCredentialDb,
  type ExternalCredentialScope,
} from "@cocalc/server/external-credentials/store";
import {
  ensureSelfHostReverseTunnel,
  runConnectorInstallOverSsh,
} from "@cocalc/server/self-host/ssh-target";
import {
  clearProjectHostMetrics,
  loadProjectHostMetricsHistory,
} from "@cocalc/database/postgres/project-host-metrics";
import {
  listProjectHostRuntimeDeployments,
  loadEffectiveProjectHostRuntimeDeployments,
  setProjectHostRuntimeDeployments,
} from "@cocalc/database/postgres/project-host-runtime-deployments";
import {
  deleteCloudflareTunnel,
  hasCloudflareTunnel,
} from "@cocalc/server/cloud/cloudflare-tunnel";
import { resolveOnPremHost } from "@cocalc/server/onprem";
import { to_bool } from "@cocalc/util/db-schema/site-defaults";
import { getLLMUsageStatus } from "@cocalc/server/llm/usage-status";
import { computeUsageUnits } from "@cocalc/server/llm/usage-units";
import { saveResponse } from "@cocalc/server/llm/save-response";
import {
  isCoreLanguageModel,
  type LanguageModelCore,
} from "@cocalc/util/db-schema/llm-utils";
import { syncProjectUsersOnHost } from "@cocalc/server/project-host/control";
import { moveProjectToHost } from "@cocalc/server/projects/move";
import { notifyProjectHostUpdate } from "@cocalc/server/conat/route-project";
import {
  issueRootfsReleaseArtifactAccess,
  recordManagedRootfsRusticReplica,
} from "@cocalc/server/rootfs/releases";
import {
  isManagedRootfsImageName,
  type RootfsReleaseGcStatus,
  type RootfsUploadedArtifactResult,
} from "@cocalc/util/rootfs-images";
import { buildCloudInitStartupScript } from "@cocalc/server/cloud/bootstrap-host";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  resolveHostBay,
  resolveProjectBay,
} from "@cocalc/server/inter-bay/directory";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { getRoutedHostControlClient } from "@cocalc/server/project-host/client";
import {
  assertAccountProjectHostTokenProjectAccess,
  assertProjectHostAgentTokenAccess,
  hasAccountProjectHostTokenHostAccess,
} from "./project-host-token-auth";
function pool() {
  return getPool();
}

const SELF_HOST_RESIZE_TIMEOUT_MS = 5 * 60 * 1000;
const HOST_START_LRO_KIND = "host-start";
const HOST_STOP_LRO_KIND = "host-stop";
const HOST_RESTART_LRO_KIND = "host-restart";
const HOST_DRAIN_LRO_KIND = "host-drain";
const HOST_RECONCILE_LRO_KIND = "host-reconcile-software";
const HOST_RECONCILE_RUNTIME_DEPLOYMENTS_LRO_KIND =
  "host-reconcile-runtime-deployments";
const HOST_ROLLBACK_RUNTIME_DEPLOYMENTS_LRO_KIND =
  "host-rollback-runtime-deployments";
const HOST_UPGRADE_LRO_KIND = "host-upgrade-software";
const HOST_ROLLOUT_MANAGED_COMPONENTS_LRO_KIND =
  "host-rollout-managed-components";
const HOST_DEPROVISION_LRO_KIND = "host-deprovision";
const HOST_DELETE_LRO_KIND = "host-delete";
const HOST_FORCE_DEPROVISION_LRO_KIND = "host-force-deprovision";
const HOST_REMOVE_CONNECTOR_LRO_KIND = "host-remove-connector";
const logger = getLogger("server:conat:api:hosts");

const DEFAULT_RUNTIME_DEPLOYMENT_POLICY: Record<
  ManagedComponentKind,
  HostRuntimeDeploymentRecord["rollout_policy"]
> = {
  "project-host": "restart_now",
  "conat-router": "restart_now",
  "conat-persist": "restart_now",
  "acp-worker": "drain_then_replace",
};

const AUTOMATIC_RUNTIME_DEPLOYMENT_RECONCILE_REASON =
  "automatic_runtime_deployment_reconcile";

function normalizeRuntimeArtifactTarget(
  artifact?: HostSoftwareArtifact | HostRuntimeArtifact,
): HostRuntimeArtifact | undefined {
  if (artifact === "project" || artifact === "project-bundle") {
    return "project-bundle";
  }
  if (
    artifact === "project-host" ||
    artifact === "tools" ||
    artifact === "bootstrap-environment"
  ) {
    return artifact;
  }
  return;
}

function normalizeRuntimeDeploymentUpsert(
  deployment: HostRuntimeDeploymentUpsert,
): HostRuntimeDeploymentUpsert | undefined {
  const desired_version = `${deployment?.desired_version ?? ""}`.trim();
  if (!desired_version) return;
  if (deployment?.target_type === "component") {
    const target = deployment.target as ManagedComponentKind;
    if (!(target in DEFAULT_RUNTIME_DEPLOYMENT_POLICY)) return;
    return {
      ...deployment,
      target_type: "component",
      target,
      desired_version,
      rollout_policy:
        deployment.rollout_policy ?? DEFAULT_RUNTIME_DEPLOYMENT_POLICY[target],
      rollout_reason: `${deployment?.rollout_reason ?? ""}`.trim() || undefined,
      drain_deadline_seconds:
        deployment.drain_deadline_seconds == null
          ? undefined
          : Math.max(0, Math.floor(Number(deployment.drain_deadline_seconds))),
      metadata:
        deployment.metadata && typeof deployment.metadata === "object"
          ? deployment.metadata
          : undefined,
    };
  }
  if (deployment?.target_type === "artifact") {
    const target = normalizeRuntimeArtifactTarget(
      deployment.target as HostRuntimeArtifact,
    );
    if (!target) return;
    return {
      ...deployment,
      target_type: "artifact",
      target,
      desired_version,
      rollout_policy: deployment.rollout_policy,
      rollout_reason: `${deployment?.rollout_reason ?? ""}`.trim() || undefined,
      drain_deadline_seconds:
        deployment.drain_deadline_seconds == null
          ? undefined
          : Math.max(0, Math.floor(Number(deployment.drain_deadline_seconds))),
      metadata:
        deployment.metadata && typeof deployment.metadata === "object"
          ? deployment.metadata
          : undefined,
    };
  }
  return;
}

function normalizeRuntimeDeploymentUpserts(
  deployments: HostRuntimeDeploymentUpsert[],
): HostRuntimeDeploymentUpsert[] {
  const deduped = new Map<string, HostRuntimeDeploymentUpsert>();
  for (const deployment of deployments ?? []) {
    const normalized = normalizeRuntimeDeploymentUpsert(deployment);
    if (!normalized) continue;
    deduped.set(`${normalized.target_type}:${normalized.target}`, normalized);
  }
  return [...deduped.values()];
}

async function assertRuntimeDeploymentGlobalAccess(account_id?: string) {
  const owner = requireAccount(account_id);
  if (!(await isAdmin(owner))) {
    throw new Error("not authorized");
  }
  return owner;
}

function requestedByForRuntimeDeployments({
  account_id,
  row,
}: {
  account_id?: string;
  row?: any;
}): string {
  return (
    `${account_id ?? row?.metadata?.owner ?? row?.metadata?.owner_account_id ?? "system"}`.trim() ||
    "system"
  );
}

function normalizeHostPricingModel(
  value: unknown,
): HostPricingModel | undefined {
  if (value == null) return undefined;
  const normalized = `${value}`.trim().toLowerCase();
  if (normalized === "spot") return "spot";
  if (normalized === "on_demand" || normalized === "on-demand") {
    return "on_demand";
  }
  return undefined;
}

function normalizeHostInterruptionRestorePolicy(
  value: unknown,
): HostInterruptionRestorePolicy | undefined {
  if (value == null) return undefined;
  const normalized = `${value}`.trim().toLowerCase();
  if (normalized === "immediate") return "immediate";
  if (normalized === "none") return "none";
  return undefined;
}

function defaultInterruptionRestorePolicy(
  pricingModel?: HostPricingModel,
): HostInterruptionRestorePolicy {
  return pricingModel === "spot" ? "immediate" : "none";
}

const HOST_PROJECTS_DEFAULT_LIMIT = 200;
const HOST_PROJECTS_MAX_LIMIT = 5000;
const DEFAULT_SOFTWARE_BASE_URL = "https://software.cocalc.ai/software";
const SOFTWARE_HISTORY_MAX_LIMIT = 50;
const SOFTWARE_HISTORY_DEFAULT_LIMIT = 1;
const SOFTWARE_FETCH_TIMEOUT_MS = 8_000;
const HOST_ROOTFS_RPC_TIMEOUT_MS = 30 * 60 * 1000;
const HOST_DRAIN_DEFAULT_PARALLEL = 10;
const HOST_DRAIN_OWNER_MAX_PARALLEL = 15;
const HOST_ONLINE_WINDOW_MS = 2 * 60 * 1000;
const HOST_BOOTSTRAP_RECONCILE_TIMEOUT_MS = 20 * 60 * 1000;
const HOST_BOOTSTRAP_RECONCILE_POLL_MS = 5_000;
const HOST_RUNNING_STATUSES = new Set(["running", "active"]);

async function hostControlClient(host_id: string, timeout?: number) {
  return await getRoutedHostControlClient({
    host_id,
    timeout,
  });
}

type RootfsReleaseLifecycleRow = {
  release_id: string;
  runtime_image: string;
  gc_status: RootfsReleaseGcStatus | null;
};

async function runSshScript({
  target,
  script,
}: {
  target: string;
  script: string;
}): Promise<{ stdout: string; stderr: string }> {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=10",
    target,
    "bash",
    "-se",
  ];
  return await new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `ssh ${target} failed with code ${code ?? "?"}: ${stderr || stdout}`,
          ),
        );
      }
    });
    child.stdin.end(script);
  });
}

type HostBootstrapReconcileState = {
  deleted: boolean;
  status: string;
  bootstrap_status?: string;
  bootstrap_updated_at?: string;
  bootstrap_message?: string;
  lifecycle_summary_status?: string;
  lifecycle_summary_message?: string;
  lifecycle_current_operation?: string;
  lifecycle_last_error?: string;
  lifecycle_last_reconcile_started_at?: string;
  lifecycle_last_reconcile_finished_at?: string;
};

function parseTimestampMs(value?: string): number | undefined {
  const text = `${value ?? ""}`.trim();
  if (!text) return undefined;
  const ms = new Date(text).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function bootstrapErrorIsStale(state: HostBootstrapReconcileState): boolean {
  if (state.bootstrap_status !== "error") return false;
  const bootstrapUpdatedMs = parseTimestampMs(state.bootstrap_updated_at);
  if (state.lifecycle_summary_status === "in_sync") {
    const finishedMs = parseTimestampMs(
      state.lifecycle_last_reconcile_finished_at,
    );
    return (
      finishedMs != null &&
      (bootstrapUpdatedMs == null || bootstrapUpdatedMs <= finishedMs)
    );
  }
  if (state.lifecycle_summary_status === "reconciling") {
    const startedMs = parseTimestampMs(
      state.lifecycle_last_reconcile_started_at,
    );
    return (
      startedMs != null &&
      (bootstrapUpdatedMs == null || bootstrapUpdatedMs < startedMs)
    );
  }
  return false;
}

async function loadHostBootstrapReconcileState(
  host_id: string,
): Promise<HostBootstrapReconcileState | undefined> {
  const { rows } = await pool().query(
    `SELECT status, deleted, metadata FROM project_hosts WHERE id=$1 LIMIT 1`,
    [host_id],
  );
  const row = rows[0];
  if (!row) return undefined;
  const metadata = row.metadata ?? {};
  const bootstrap = metadata.bootstrap ?? {};
  const lifecycle = metadata.bootstrap_lifecycle ?? {};
  return {
    deleted: !!row.deleted,
    status: `${row.status ?? ""}`.trim(),
    bootstrap_status: `${bootstrap.status ?? ""}`.trim() || undefined,
    bootstrap_updated_at: `${bootstrap.updated_at ?? ""}`.trim() || undefined,
    bootstrap_message: `${bootstrap.message ?? ""}`.trim() || undefined,
    lifecycle_summary_status:
      `${lifecycle.summary_status ?? ""}`.trim() || undefined,
    lifecycle_summary_message:
      `${lifecycle.summary_message ?? ""}`.trim() || undefined,
    lifecycle_current_operation:
      `${lifecycle.current_operation ?? ""}`.trim() || undefined,
    lifecycle_last_error: `${lifecycle.last_error ?? ""}`.trim() || undefined,
    lifecycle_last_reconcile_started_at:
      `${lifecycle.last_reconcile_started_at ?? ""}`.trim() || undefined,
    lifecycle_last_reconcile_finished_at:
      `${lifecycle.last_reconcile_finished_at ?? ""}`.trim() || undefined,
  };
}

function hostBootstrapActivityChanged(
  baseline: HostBootstrapReconcileState,
  current: HostBootstrapReconcileState,
): boolean {
  return (
    current.bootstrap_status !== baseline.bootstrap_status ||
    current.bootstrap_updated_at !== baseline.bootstrap_updated_at ||
    current.bootstrap_message !== baseline.bootstrap_message ||
    current.lifecycle_summary_status !== baseline.lifecycle_summary_status ||
    current.lifecycle_summary_message !== baseline.lifecycle_summary_message ||
    current.lifecycle_current_operation !==
      baseline.lifecycle_current_operation ||
    current.lifecycle_last_error !== baseline.lifecycle_last_error ||
    current.lifecycle_last_reconcile_started_at !==
      baseline.lifecycle_last_reconcile_started_at ||
    current.lifecycle_last_reconcile_finished_at !==
      baseline.lifecycle_last_reconcile_finished_at
  );
}

function hostBootstrapReconcileSucceeded(
  state: HostBootstrapReconcileState,
): boolean {
  if (state.lifecycle_summary_status === "in_sync") {
    return true;
  }
  return state.bootstrap_status === "done";
}

function hostBootstrapReconcileFailure(
  state: HostBootstrapReconcileState,
): string | undefined {
  if (state.bootstrap_status === "error" && !bootstrapErrorIsStale(state)) {
    return (
      state.bootstrap_message ??
      state.lifecycle_last_error ??
      "bootstrap reconcile failed"
    );
  }
  if (state.lifecycle_summary_status === "error") {
    return (
      state.lifecycle_last_error ??
      state.lifecycle_summary_message ??
      "bootstrap reconcile failed"
    );
  }
  if (
    state.lifecycle_summary_status === "drifted" &&
    state.bootstrap_status === "done" &&
    state.lifecycle_current_operation !== "reconcile"
  ) {
    return (
      state.lifecycle_summary_message ??
      state.lifecycle_last_error ??
      "host software remains drifted after reconcile"
    );
  }
  return undefined;
}

async function waitForHostBootstrapReconcile({
  host_id,
  baseline,
}: {
  host_id: string;
  baseline: HostBootstrapReconcileState;
}): Promise<void> {
  const startedAt = Date.now();
  let sawActivity = false;
  while (Date.now() - startedAt < HOST_BOOTSTRAP_RECONCILE_TIMEOUT_MS) {
    const state = await loadHostBootstrapReconcileState(host_id);
    if (!state) {
      throw new Error("host not found");
    }
    if (state.deleted) {
      throw new Error("host deleted during bootstrap reconcile");
    }
    sawActivity ||= hostBootstrapActivityChanged(baseline, state);
    const failure = hostBootstrapReconcileFailure(state);
    if (failure) {
      throw new Error(failure);
    }
    if (sawActivity && hostBootstrapReconcileSucceeded(state)) {
      return;
    }
    await delay(HOST_BOOTSTRAP_RECONCILE_POLL_MS);
  }
  throw new Error("timeout waiting for host bootstrap reconcile");
}

async function waitForHostHeartbeatAfter({
  host_id,
  since,
}: {
  host_id: string;
  since: number;
}): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < HOST_BOOTSTRAP_RECONCILE_TIMEOUT_MS) {
    const { rows } = await pool().query(
      `SELECT deleted, last_seen FROM project_hosts WHERE id=$1 LIMIT 1`,
      [host_id],
    );
    const row = rows[0];
    if (!row || row.deleted) {
      throw new Error("host not found");
    }
    const lastSeen = row.last_seen
      ? new Date(row.last_seen as any).getTime()
      : 0;
    if (lastSeen && lastSeen >= since) {
      return;
    }
    await delay(HOST_BOOTSTRAP_RECONCILE_POLL_MS);
  }
  throw new Error("timeout waiting for host heartbeat");
}

function cloudHostSshTarget(row: {
  metadata?: Record<string, any>;
}): string | undefined {
  const runtime = row.metadata?.runtime ?? {};
  const machine = row.metadata?.machine ?? {};
  const publicIp =
    `${runtime.public_ip ?? machine.metadata?.public_ip ?? ""}`.trim();
  if (!publicIp) return undefined;
  const sshUser =
    `${runtime.ssh_user ?? machine.metadata?.ssh_user ?? "ubuntu"}`.trim();
  if (!sshUser) return undefined;
  return `${sshUser}@${publicIp}`;
}

function assertCloudHostBootstrapReconcileSupported(row: any): void {
  const machineCloud = normalizeProviderId(row?.metadata?.machine?.cloud);
  if (!machineCloud || machineCloud === "self-host") {
    throw new Error(
      "bootstrap reconcile is only supported for cloud hosts with ssh access",
    );
  }
  if (!cloudHostSshTarget(row)) {
    throw new Error(
      "bootstrap reconcile requires a reachable cloud ssh target for this host",
    );
  }
}

async function reconcileCloudHostBootstrapOverSsh(opts: {
  host_id: string;
  row: any;
}): Promise<void> {
  const target = cloudHostSshTarget(opts.row);
  if (!target) {
    logger.debug(
      "host upgrade: skip bootstrap reconcile (missing ssh target)",
      {
        host_id: opts.host_id,
      },
    );
    return;
  }
  const bootstrapBaseUrl = await siteURL();
  const bootstrapToken = await createProjectHostBootstrapToken(opts.host_id);
  const bootstrapScript = await buildCloudInitStartupScript(
    opts.row,
    bootstrapToken.token,
    bootstrapBaseUrl,
  );
  const baseline = await loadHostBootstrapReconcileState(opts.host_id);
  if (!baseline) {
    throw new Error("host not found");
  }
  const encodedBootstrapScript = Buffer.from(bootstrapScript, "utf8").toString(
    "base64",
  );
  const script = `
set -euo pipefail
BOOTSTRAP_DIR=""
for candidate in /mnt/cocalc/data/.host-bootstrap/bootstrap /home/ubuntu/cocalc-host/bootstrap /root/cocalc-host/bootstrap
do
  if [ -d "$candidate" ]; then
    BOOTSTRAP_DIR="$candidate"
    break
  fi
done
if [ -z "$BOOTSTRAP_DIR" ]; then
  echo "bootstrap directory not found" >&2
  exit 1
fi
BOOTSTRAP_SH="$BOOTSTRAP_DIR/bootstrap.sh"
python3 - "$BOOTSTRAP_SH" <<'PY'
import base64, sys
body = base64.b64decode("""${encodedBootstrapScript}""")
with open(sys.argv[1], "wb") as handle:
    handle.write(body)
PY
chmod 700 "$BOOTSTRAP_SH"
LOG_DIR="/mnt/cocalc/data/logs"
BOOTSTRAP_LOG="$LOG_DIR/bootstrap-reconcile.log"
sudo -n install -d -m 0755 "$LOG_DIR"
sudo -n touch "$BOOTSTRAP_LOG"
BOOTSTRAP_PID="$(sudo -n bash -lc 'nohup bash "$1" >>"$2" 2>&1 </dev/null & echo $!' -- "$BOOTSTRAP_SH" "$BOOTSTRAP_LOG")"
echo "started bootstrap reconcile pid=$BOOTSTRAP_PID log=$BOOTSTRAP_LOG"
`;
  logger.info("host upgrade: reconciling host bootstrap over ssh", {
    host_id: opts.host_id,
    target,
  });
  const { stdout, stderr } = await runSshScript({ target, script });
  if (stdout.trim()) {
    logger.info("host upgrade: bootstrap reconcile stdout", {
      host_id: opts.host_id,
      target,
      stdout,
    });
  }
  if (stderr.trim()) {
    logger.info("host upgrade: bootstrap reconcile stderr", {
      host_id: opts.host_id,
      target,
      stderr,
    });
  }
  await waitForHostBootstrapReconcile({
    host_id: opts.host_id,
    baseline,
  });
}

function logStatusUpdate(id: string, status: string, source: string) {
  const stack = new Error().stack;
  logger.debug("status update", {
    host_id: id,
    status,
    source,
    stack,
  });
}

async function loadRootfsReleaseLifecycleByImage(
  images: string[],
): Promise<Map<string, RootfsReleaseLifecycleRow>> {
  const managedImages = Array.from(
    new Set(images.filter((image) => isManagedRootfsImageName(image))),
  );
  if (managedImages.length === 0) {
    return new Map();
  }
  const { rows } = await pool().query<RootfsReleaseLifecycleRow>(
    `SELECT release_id, runtime_image, gc_status
     FROM rootfs_releases
     WHERE runtime_image = ANY($1::TEXT[])`,
    [managedImages],
  );
  return new Map(
    rows.map((row) => [
      `${row.runtime_image ?? ""}`.trim(),
      {
        ...row,
        runtime_image: `${row.runtime_image ?? ""}`.trim(),
        gc_status: row.gc_status ?? "active",
      },
    ]),
  );
}

async function enrichHostRootfsImages(
  entries: HostRootfsImage[],
): Promise<HostRootfsImage[]> {
  const lifecycleByImage = await loadRootfsReleaseLifecycleByImage(
    entries.map((entry) => entry.image),
  );
  return entries.map((entry) => {
    const lifecycle = lifecycleByImage.get(`${entry.image ?? ""}`.trim());
    const managed = isManagedRootfsImageName(entry.image);
    const release_gc_status = lifecycle?.gc_status ?? undefined;
    const centrally_deleted = release_gc_status === "deleted";
    const host_gc_eligible =
      centrally_deleted &&
      (entry.project_count ?? 0) === 0 &&
      (entry.running_project_count ?? 0) === 0;
    return {
      ...entry,
      managed,
      release_id: lifecycle?.release_id ?? entry.release_id,
      release_gc_status,
      centrally_deleted,
      host_gc_eligible,
    };
  });
}

function hostStatusValue(row: any): string {
  return `${row?.status ?? ""}`.trim().toLowerCase();
}

function hostLastSeenMs(row: any): number | undefined {
  if (!row?.last_seen) return undefined;
  const ts = new Date(row.last_seen as any).getTime();
  return Number.isFinite(ts) ? ts : undefined;
}

function computeHostOperationalAvailability(row: any): {
  operational: boolean;
  online: boolean;
  status: string;
  reason_unavailable?: string;
} {
  if (!row || row.deleted) {
    return {
      operational: false,
      online: false,
      status: hostStatusValue(row),
      reason_unavailable: "Host is deleted.",
    };
  }

  const status = hostStatusValue(row);
  if (!HOST_RUNNING_STATUSES.has(status)) {
    return {
      operational: false,
      online: false,
      status,
      reason_unavailable: `Host is ${status || "unknown"}; it must be running.`,
    };
  }

  const seenMs = hostLastSeenMs(row);
  if (seenMs == null) {
    return {
      operational: false,
      online: false,
      status,
      reason_unavailable: "Host has not sent a heartbeat recently.",
    };
  }

  const online = Date.now() - seenMs <= HOST_ONLINE_WINDOW_MS;
  if (!online) {
    return {
      operational: false,
      online: false,
      status,
      reason_unavailable: "Host heartbeat is stale; host appears offline.",
    };
  }

  return { operational: true, online: true, status };
}

function requireAccount(account_id?: string): string {
  if (!account_id) {
    throw new Error("must be signed in to manage hosts");
  }
  return account_id;
}

function parseDrainParallel(parallel?: number): number {
  if (parallel == null) {
    return HOST_DRAIN_DEFAULT_PARALLEL;
  }
  const n = Math.floor(Number(parallel));
  if (!Number.isFinite(n) || n < 1) {
    throw new Error("drain parallel must be a positive integer");
  }
  return n;
}

async function resolveDrainParallel(
  owner: string,
  parallel?: number,
): Promise<number> {
  const requested = parseDrainParallel(parallel);
  if (!(await isAdmin(owner)) && requested > HOST_DRAIN_OWNER_MAX_PARALLEL) {
    throw new Error(
      `drain parallel cannot exceed ${HOST_DRAIN_OWNER_MAX_PARALLEL} for non-admin users`,
    );
  }
  return requested;
}

async function resolveDrainMoveAccount({
  project_id,
  fallback_account_id,
}: {
  project_id: string;
  fallback_account_id: string;
}): Promise<string> {
  const { rows } = await pool().query<{ account_id: string }>(
    `
      SELECT u.key AS account_id
      FROM projects p
      JOIN LATERAL jsonb_each(COALESCE(p.users, '{}'::jsonb)) u(key, value) ON true
      WHERE p.project_id=$1
        AND p.deleted IS NOT true
        AND (u.value ->> 'group') IN ('owner', 'collaborator')
      ORDER BY
        CASE (u.value ->> 'group')
          WHEN 'owner' THEN 0
          WHEN 'collaborator' THEN 1
          ELSE 2
        END,
        u.key
      LIMIT 1
    `,
    [project_id],
  );
  const account_id = `${rows[0]?.account_id ?? ""}`.trim();
  return account_id || fallback_account_id;
}

function parseRow(
  row: any,
  opts: {
    scope?: Host["scope"];
    can_start?: boolean;
    can_place?: boolean;
    reason_unavailable?: string;
    backup_status?: HostBackupStatus;
    starred?: boolean;
    metrics_history?: HostMetricsHistory;
  } = {},
): Host {
  const parsePositiveInt = (value: unknown): number | undefined => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return Math.floor(parsed);
  };
  const parseNonNegativeNumber = (value: unknown): number | undefined => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return undefined;
    return parsed;
  };
  const normalizeBootstrap = (
    bootstrap: HostBootstrapStatus | undefined,
    lifecycle: HostBootstrapLifecycle | undefined,
  ): HostBootstrapStatus | undefined => {
    if (!bootstrap || !lifecycle) return bootstrap;
    const bootstrapUpdatedMs = parseTimestampMs(bootstrap.updated_at);
    const lifecycleStartedMs = parseTimestampMs(
      lifecycle.last_reconcile_started_at,
    );
    const lifecycleFinishedMs = parseTimestampMs(
      lifecycle.last_reconcile_finished_at,
    );
    if (
      lifecycle.summary_status === "in_sync" &&
      lifecycleFinishedMs != null &&
      (bootstrapUpdatedMs == null || bootstrapUpdatedMs <= lifecycleFinishedMs)
    ) {
      return {
        ...bootstrap,
        status: "done",
        updated_at:
          lifecycle.last_reconcile_finished_at ?? bootstrap.updated_at,
        message:
          lifecycle.summary_message ??
          bootstrap.message ??
          "Host software is in sync",
      };
    }
    if (
      lifecycle.summary_status === "reconciling" &&
      lifecycleStartedMs != null &&
      (bootstrapUpdatedMs == null || bootstrapUpdatedMs < lifecycleStartedMs)
    ) {
      return {
        ...bootstrap,
        status: "running",
        updated_at: lifecycle.last_reconcile_started_at ?? bootstrap.updated_at,
        message:
          lifecycle.summary_message ??
          bootstrap.message ??
          "Reconciling host software",
      };
    }
    return bootstrap;
  };
  const metadata = row.metadata ?? {};
  const software = metadata.software ?? {};
  const machine: HostMachine | undefined = metadata.machine;
  const rawCurrentMetrics = metadata.metrics?.current;
  const currentMetrics: HostCurrentMetrics | undefined =
    rawCurrentMetrics && typeof rawCurrentMetrics === "object"
      ? {
          ...(typeof rawCurrentMetrics.collected_at === "string"
            ? { collected_at: rawCurrentMetrics.collected_at }
            : {}),
          ...(parseNonNegativeNumber(rawCurrentMetrics.cpu_percent) != null
            ? {
                cpu_percent: parseNonNegativeNumber(
                  rawCurrentMetrics.cpu_percent,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(rawCurrentMetrics.load_1) != null
            ? { load_1: parseNonNegativeNumber(rawCurrentMetrics.load_1) }
            : {}),
          ...(parseNonNegativeNumber(rawCurrentMetrics.load_5) != null
            ? { load_5: parseNonNegativeNumber(rawCurrentMetrics.load_5) }
            : {}),
          ...(parseNonNegativeNumber(rawCurrentMetrics.load_15) != null
            ? { load_15: parseNonNegativeNumber(rawCurrentMetrics.load_15) }
            : {}),
          ...(parseNonNegativeNumber(rawCurrentMetrics.memory_total_bytes) !=
          null
            ? {
                memory_total_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.memory_total_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(rawCurrentMetrics.memory_used_bytes) !=
          null
            ? {
                memory_used_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.memory_used_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.memory_available_bytes,
          ) != null
            ? {
                memory_available_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.memory_available_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(rawCurrentMetrics.memory_used_percent) !=
          null
            ? {
                memory_used_percent: parseNonNegativeNumber(
                  rawCurrentMetrics.memory_used_percent,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(rawCurrentMetrics.swap_total_bytes) != null
            ? {
                swap_total_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.swap_total_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(rawCurrentMetrics.swap_used_bytes) != null
            ? {
                swap_used_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.swap_used_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.disk_device_total_bytes,
          ) != null
            ? {
                disk_device_total_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.disk_device_total_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.disk_device_used_bytes,
          ) != null
            ? {
                disk_device_used_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.disk_device_used_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.disk_unallocated_bytes,
          ) != null
            ? {
                disk_unallocated_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.disk_unallocated_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.btrfs_data_total_bytes,
          ) != null
            ? {
                btrfs_data_total_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.btrfs_data_total_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(rawCurrentMetrics.btrfs_data_used_bytes) !=
          null
            ? {
                btrfs_data_used_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.btrfs_data_used_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.btrfs_metadata_total_bytes,
          ) != null
            ? {
                btrfs_metadata_total_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.btrfs_metadata_total_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.btrfs_metadata_used_bytes,
          ) != null
            ? {
                btrfs_metadata_used_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.btrfs_metadata_used_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.btrfs_system_total_bytes,
          ) != null
            ? {
                btrfs_system_total_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.btrfs_system_total_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.btrfs_system_used_bytes,
          ) != null
            ? {
                btrfs_system_used_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.btrfs_system_used_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.btrfs_global_reserve_total_bytes,
          ) != null
            ? {
                btrfs_global_reserve_total_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.btrfs_global_reserve_total_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.btrfs_global_reserve_used_bytes,
          ) != null
            ? {
                btrfs_global_reserve_used_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.btrfs_global_reserve_used_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.disk_available_conservative_bytes,
          ) != null
            ? {
                disk_available_conservative_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.disk_available_conservative_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.disk_available_for_admission_bytes,
          ) != null
            ? {
                disk_available_for_admission_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.disk_available_for_admission_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(rawCurrentMetrics.reservation_bytes) !=
          null
            ? {
                reservation_bytes: parseNonNegativeNumber(
                  rawCurrentMetrics.reservation_bytes,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.assigned_project_count,
          ) != null
            ? {
                assigned_project_count: parseNonNegativeNumber(
                  rawCurrentMetrics.assigned_project_count,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(rawCurrentMetrics.running_project_count) !=
          null
            ? {
                running_project_count: parseNonNegativeNumber(
                  rawCurrentMetrics.running_project_count,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.starting_project_count,
          ) != null
            ? {
                starting_project_count: parseNonNegativeNumber(
                  rawCurrentMetrics.starting_project_count,
                ),
              }
            : {}),
          ...(parseNonNegativeNumber(
            rawCurrentMetrics.stopping_project_count,
          ) != null
            ? {
                stopping_project_count: parseNonNegativeNumber(
                  rawCurrentMetrics.stopping_project_count,
                ),
              }
            : {}),
        }
      : undefined;
  const rawBootstrap = metadata.bootstrap;
  const bootstrap: HostBootstrapStatus | undefined =
    rawBootstrap && typeof rawBootstrap === "object"
      ? {
          ...(typeof rawBootstrap.status === "string"
            ? { status: rawBootstrap.status }
            : {}),
          ...(typeof rawBootstrap.updated_at === "string"
            ? { updated_at: rawBootstrap.updated_at }
            : {}),
          ...(typeof rawBootstrap.message === "string"
            ? { message: rawBootstrap.message }
            : {}),
        }
      : undefined;
  const rawBootstrapLifecycle = metadata.bootstrap_lifecycle;
  const bootstrapLifecycle: HostBootstrapLifecycle | undefined =
    rawBootstrapLifecycle && typeof rawBootstrapLifecycle === "object"
      ? (() => {
          const parseLifecycleValue = (
            value: unknown,
          ): string | boolean | number | null | undefined => {
            if (typeof value === "string") {
              const trimmed = value.trim();
              return trimmed || undefined;
            }
            if (typeof value === "boolean") return value;
            if (typeof value === "number" && Number.isFinite(value)) {
              return value;
            }
            if (value === null) return null;
            return undefined;
          };
          const parseLifecycleStatus = (
            value: unknown,
          ):
            | HostBootstrapLifecycle["summary_status"]
            | HostBootstrapLifecycleItem["status"]
            | undefined => {
            const status = `${value ?? ""}`.trim();
            if (
              status === "in_sync" ||
              status === "drifted" ||
              status === "reconciling" ||
              status === "error" ||
              status === "unknown" ||
              status === "match" ||
              status === "drift" ||
              status === "missing" ||
              status === "disabled"
            ) {
              return status as
                | HostBootstrapLifecycle["summary_status"]
                | HostBootstrapLifecycleItem["status"];
            }
            return undefined;
          };
          const items = Array.isArray(rawBootstrapLifecycle.items)
            ? rawBootstrapLifecycle.items
                .map((item): HostBootstrapLifecycleItem | undefined => {
                  if (!item || typeof item !== "object") return undefined;
                  const key =
                    typeof item.key === "string" ? item.key.trim() : "";
                  const label =
                    typeof item.label === "string" ? item.label.trim() : "";
                  const status = parseLifecycleStatus(item.status);
                  if (!key || !label || !status) return undefined;
                  return {
                    key,
                    label,
                    status: status as HostBootstrapLifecycleItem["status"],
                    ...(parseLifecycleValue(item.desired) !== undefined
                      ? { desired: parseLifecycleValue(item.desired) }
                      : {}),
                    ...(parseLifecycleValue(item.installed) !== undefined
                      ? { installed: parseLifecycleValue(item.installed) }
                      : {}),
                    ...(typeof item.message === "string" && item.message.trim()
                      ? { message: item.message.trim() }
                      : {}),
                  };
                })
                .filter(
                  (item): item is HostBootstrapLifecycleItem =>
                    item !== undefined,
                )
            : [];
          const summaryStatus = parseLifecycleStatus(
            rawBootstrapLifecycle.summary_status,
          ) as HostBootstrapLifecycle["summary_status"] | undefined;
          if (!summaryStatus) return undefined;
          return {
            ...(typeof rawBootstrapLifecycle.bootstrap_dir === "string" &&
            rawBootstrapLifecycle.bootstrap_dir.trim()
              ? { bootstrap_dir: rawBootstrapLifecycle.bootstrap_dir.trim() }
              : {}),
            ...(typeof rawBootstrapLifecycle.desired_recorded_at === "string"
              ? {
                  desired_recorded_at:
                    rawBootstrapLifecycle.desired_recorded_at,
                }
              : {}),
            ...(typeof rawBootstrapLifecycle.installed_recorded_at === "string"
              ? {
                  installed_recorded_at:
                    rawBootstrapLifecycle.installed_recorded_at,
                }
              : {}),
            ...(typeof rawBootstrapLifecycle.current_operation === "string"
              ? { current_operation: rawBootstrapLifecycle.current_operation }
              : {}),
            ...(typeof rawBootstrapLifecycle.last_provision_result === "string"
              ? {
                  last_provision_result:
                    rawBootstrapLifecycle.last_provision_result,
                }
              : {}),
            ...(typeof rawBootstrapLifecycle.last_provision_started_at ===
            "string"
              ? {
                  last_provision_started_at:
                    rawBootstrapLifecycle.last_provision_started_at,
                }
              : {}),
            ...(typeof rawBootstrapLifecycle.last_provision_finished_at ===
            "string"
              ? {
                  last_provision_finished_at:
                    rawBootstrapLifecycle.last_provision_finished_at,
                }
              : {}),
            ...(typeof rawBootstrapLifecycle.last_reconcile_result === "string"
              ? {
                  last_reconcile_result:
                    rawBootstrapLifecycle.last_reconcile_result,
                }
              : {}),
            ...(typeof rawBootstrapLifecycle.last_reconcile_started_at ===
            "string"
              ? {
                  last_reconcile_started_at:
                    rawBootstrapLifecycle.last_reconcile_started_at,
                }
              : {}),
            ...(typeof rawBootstrapLifecycle.last_reconcile_finished_at ===
            "string"
              ? {
                  last_reconcile_finished_at:
                    rawBootstrapLifecycle.last_reconcile_finished_at,
                }
              : {}),
            ...(typeof rawBootstrapLifecycle.last_error === "string" &&
            rawBootstrapLifecycle.last_error.trim()
              ? { last_error: rawBootstrapLifecycle.last_error.trim() }
              : {}),
            summary_status: summaryStatus,
            ...(typeof rawBootstrapLifecycle.summary_message === "string" &&
            rawBootstrapLifecycle.summary_message.trim()
              ? {
                  summary_message: rawBootstrapLifecycle.summary_message.trim(),
                }
              : {}),
            drift_count:
              parseNonNegativeNumber(rawBootstrapLifecycle.drift_count) ?? 0,
            items,
          };
        })()
      : undefined;
  const rawStatus = String(row.status ?? "");
  const normalizedStatus =
    rawStatus === "active" ? "running" : rawStatus || "off";
  const normalizedBootstrap = normalizeBootstrap(bootstrap, bootstrapLifecycle);
  const pricingModel =
    normalizeHostPricingModel(metadata.pricing_model) ?? "on_demand";
  const interruptionRestorePolicy =
    normalizeHostInterruptionRestorePolicy(
      metadata.interruption_restore_policy,
    ) ?? defaultInterruptionRestorePolicy(pricingModel);
  const desiredState = desiredHostState({
    status: normalizedStatus,
    metadata,
  });
  return {
    id: row.id,
    name: row.name ?? "Host",
    owner: metadata.owner ?? "",
    region: row.region ?? "",
    size: metadata.size ?? "",
    host_cpu_count: parsePositiveInt(metadata.host_cpu_count),
    host_ram_gb: parsePositiveInt(metadata.host_ram_gb),
    gpu: !!metadata.gpu,
    status: normalizedStatus as HostStatus,
    reprovision_required: !!metadata.reprovision_required,
    version: row.version ?? software.project_host,
    project_host_build_id: software.project_host_build_id,
    project_bundle_version: software.project_bundle,
    project_bundle_build_id: software.project_bundle_build_id,
    tools_version: software.tools,
    host_session_id: metadata.host_session_id,
    host_session_started_at: metadata.host_session_started_at,
    metrics:
      currentMetrics || opts.metrics_history
        ? {
            ...(currentMetrics ? { current: currentMetrics } : {}),
            ...(opts.metrics_history ? { history: opts.metrics_history } : {}),
          }
        : undefined,
    machine,
    public_ip: metadata.runtime?.public_ip,
    last_error: metadata.last_error,
    last_error_at: metadata.last_error_at,
    projects: row.capacity?.projects ?? 0,
    last_seen: row.last_seen
      ? new Date(row.last_seen).toISOString()
      : undefined,
    tier: normalizeHostTier(row.tier),
    scope: opts.scope,
    can_start: opts.can_start,
    can_place: opts.can_place,
    reason_unavailable: opts.reason_unavailable,
    starred: opts.starred,
    pricing_model: pricingModel,
    interruption_restore_policy: interruptionRestorePolicy,
    desired_state: desiredState,
    last_action: metadata.last_action,
    last_action_at: metadata.last_action_at,
    last_action_status: metadata.last_action_status,
    last_action_error: metadata.last_action_error,
    provider_observed_at: metadata.runtime?.observed_at,
    deleted: row.deleted ? new Date(row.deleted).toISOString() : undefined,
    backup_status: opts.backup_status,
    bootstrap: normalizedBootstrap,
    bootstrap_lifecycle: bootstrapLifecycle,
  };
}

async function loadHostBackupStatus(
  hostIds: string[],
): Promise<Map<string, HostBackupStatus>> {
  if (!hostIds.length) return new Map();
  const { rows } = await pool().query<{
    host_id: string;
    total: string;
    provisioned: string;
    running: string;
    provisioned_up_to_date: string;
    provisioned_needs_backup: string;
  }>(
    `
      SELECT
        host_id,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE provisioned IS TRUE) AS provisioned,
        COUNT(*) FILTER (
          WHERE COALESCE(state->>'state', '') IN ('running','starting')
        ) AS running,
        COUNT(*) FILTER (
          WHERE provisioned IS TRUE
            AND COALESCE(state->>'state', '') NOT IN ('running','starting')
            AND last_backup IS NOT NULL
            AND (last_edited IS NULL OR last_edited <= last_backup)
        ) AS provisioned_up_to_date,
        COUNT(*) FILTER (
          WHERE provisioned IS TRUE
            AND COALESCE(state->>'state', '') NOT IN ('running','starting')
            AND (
              last_backup IS NULL
              OR (last_edited IS NOT NULL AND last_edited > last_backup)
            )
        ) AS provisioned_needs_backup
      FROM projects
      WHERE deleted IS NOT true
        AND host_id = ANY($1)
      GROUP BY host_id
    `,
    [hostIds],
  );
  const map = new Map<string, HostBackupStatus>();
  for (const row of rows) {
    map.set(row.host_id, {
      total: Number(row.total ?? 0),
      provisioned: Number(row.provisioned ?? 0),
      running: Number(row.running ?? 0),
      provisioned_up_to_date: Number(row.provisioned_up_to_date ?? 0),
      provisioned_needs_backup: Number(row.provisioned_needs_backup ?? 0),
    });
  }
  return map;
}

async function loadProjectIdsAssignedToHost(
  host_id: string,
): Promise<string[]> {
  const { rows } = await pool().query<{ project_id: string }>(
    `
      SELECT project_id
      FROM projects
      WHERE host_id=$1
        AND deleted IS NOT true
      ORDER BY COALESCE(last_edited, created) DESC NULLS LAST, project_id DESC
    `,
    [host_id],
  );
  return rows.map((row) => row.project_id);
}

async function loadOwnedHost(id: string, account_id?: string): Promise<any> {
  const owner = requireAccount(account_id);
  const { rows } = await pool().query(
    `SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL`,
    [id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("host not found");
  }
  if (row.metadata?.owner && row.metadata.owner !== owner) {
    throw new Error("not authorized");
  }
  return row;
}

async function loadHostForRootfsManagement(
  id: string,
  account_id?: string,
): Promise<any> {
  const owner = requireAccount(account_id);
  const { rows } = await pool().query(
    `SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL`,
    [id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("host not found");
  }
  if (await isAdmin(owner)) {
    return row;
  }
  if (row.metadata?.owner && row.metadata.owner !== owner) {
    throw new Error("not authorized");
  }
  return row;
}

async function loadHostForDrain(id: string, account_id?: string): Promise<any> {
  const owner = requireAccount(account_id);
  const { rows } = await pool().query(
    `SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL`,
    [id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("host not found");
  }
  if (await isAdmin(owner)) {
    return row;
  }
  if (row.metadata?.owner && row.metadata.owner !== owner) {
    throw new Error("not authorized");
  }
  return row;
}

async function loadHostForStartStop(
  id: string,
  account_id?: string,
): Promise<any> {
  const owner = requireAccount(account_id);
  const { rows } = await pool().query(
    `SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL`,
    [id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("host not found");
  }
  const metadata = row.metadata ?? {};
  const isOwner = metadata.owner === owner;
  if (isOwner) return row;
  const collaborators = (metadata.collaborators ?? []) as string[];
  const isCollab = collaborators.includes(owner);
  if (isCollab && !!metadata.host_collab_control) {
    return row;
  }
  throw new Error("not authorized");
}

async function loadHostForListing(
  id: string,
  account_id?: string,
): Promise<any> {
  const owner = requireAccount(account_id);
  const { rows } = await pool().query(
    `SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL`,
    [id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("host not found");
  }
  if (await isAdmin(owner)) {
    return row;
  }
  const metadata = row.metadata ?? {};
  const isOwner = metadata.owner === owner;
  if (isOwner) return row;
  const collaborators = (metadata.collaborators ?? []) as string[];
  const isCollab = collaborators.includes(owner);
  if (isCollab && !!metadata.host_collab_control) {
    return row;
  }
  throw new Error("not authorized");
}

type HostProjectsCursor = {
  last_edited: string | null;
  project_id: string;
};

function encodeHostProjectsCursor(cursor: HostProjectsCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64");
}

function decodeHostProjectsCursor(cursor: string): HostProjectsCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64").toString("utf8"),
    ) as HostProjectsCursor;
    if (!parsed?.project_id) {
      throw new Error("missing project_id");
    }
    return {
      project_id: String(parsed.project_id),
      last_edited:
        parsed.last_edited == null ? null : String(parsed.last_edited),
    };
  } catch (err) {
    throw new Error(`invalid cursor: ${err}`);
  }
}

function normalizeHostProjectsLimit(limit?: number): number {
  if (!limit || Number.isNaN(limit)) {
    return HOST_PROJECTS_DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(HOST_PROJECTS_MAX_LIMIT, Math.floor(limit)));
}

function normalizeDate(value: any): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return date.toISOString();
}

async function markHostActionPending(id: string, action: string) {
  await pool().query(
    `
      UPDATE project_hosts
      SET metadata = jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{last_action}', to_jsonb($2::text)
            ),
            '{last_action_at}', to_jsonb(NOW())
          ),
          '{last_action_status}', to_jsonb('pending'::text)
        ),
        '{last_action_error}', 'null'::jsonb
      ),
      updated=NOW()
      WHERE id=$1 AND deleted IS NULL
    `,
    [id, action],
  );
}

async function setHostDesiredState(
  id: string,
  desiredState: "running" | "stopped",
) {
  await pool().query(
    `
      UPDATE project_hosts
      SET metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{desired_state}',
            to_jsonb($2::text)
          ),
          updated = NOW()
      WHERE id=$1 AND deleted IS NULL
    `,
    [id, desiredState],
  );
}

async function markHostDeprovisioned(row: any, action: string) {
  const machine: HostMachine = row.metadata?.machine ?? {};
  const runtime = row.metadata?.runtime;
  const nextMetadata = { ...(row.metadata ?? {}) };
  nextMetadata.desired_state = "stopped";
  delete nextMetadata.runtime;
  delete nextMetadata.dns;
  delete nextMetadata.cloudflare_tunnel;
  delete nextMetadata.metrics;

  logStatusUpdate(row.id, "deprovisioned", "api");
  await revokeProjectHostTokensForHost(row.id, { purpose: "bootstrap" });
  await revokeProjectHostTokensForHost(row.id, { purpose: "master-conat" });
  try {
    if (await hasCloudflareTunnel()) {
      await deleteCloudflareTunnel({
        host_id: row.id,
        tunnel: row.metadata?.cloudflare_tunnel,
      });
    } else if (await hasDns()) {
      await deleteHostDns({ record_id: row.metadata?.dns?.record_id });
    }
  } catch (err) {
    console.warn("force deprovision cleanup failed", err);
  }

  await pool().query(
    `UPDATE project_hosts
       SET status=$2,
           public_url=NULL,
           internal_url=NULL,
           ssh_server=NULL,
           last_seen=$3,
           metadata=$4,
           updated=NOW()
    WHERE id=$1 AND deleted IS NULL`,
    [row.id, "deprovisioned", new Date(), nextMetadata],
  );
  await clearProjectHostMetrics({ host_id: row.id });
  await logCloudVmEvent({
    vm_id: row.id,
    action,
    status: "success",
    provider: normalizeProviderId(machine.cloud) ?? machine.cloud,
    spec: machine,
    runtime,
  });
}

async function loadHostForView(id: string, account_id?: string): Promise<any> {
  const owner = requireAccount(account_id);
  const { rows } = await pool().query(
    `SELECT * FROM project_hosts WHERE id=$1`,
    [id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("host not found");
  }
  const metadata = row.metadata ?? {};
  const isOwner = metadata.owner === owner;
  const collaborators = (metadata.collaborators ?? []) as string[];
  const isCollab = collaborators.includes(owner);
  if (isOwner || isCollab) return row;
  throw new Error("not authorized");
}

function normalizeHostTier(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

async function loadMembership(account_id: string) {
  return await resolveMembershipForAccount(account_id);
}

function requireCreateHosts(entitlements: any) {
  const canCreate = entitlements?.features?.create_hosts === true;
  if (!canCreate) {
    throw new Error("membership does not allow host creation");
  }
}

export {
  getBackupConfig,
  recordProjectBackup,
} from "@cocalc/server/project-backup";

export async function touchProject({
  host_id,
  project_id,
}: {
  host_id?: string;
  project_id: string;
}): Promise<void> {
  if (!host_id) {
    throw new Error("host_id must be specified");
  }
  if (!project_id) {
    throw new Error("project_id must be specified");
  }
  const { rowCount } = await pool().query(
    `
      UPDATE projects
      SET last_edited=NOW()
      WHERE project_id=$1
        AND host_id=$2
        AND deleted IS NOT true
    `,
    [project_id, host_id],
  );
  if (!rowCount) {
    logger.debug("touchProject ignored (host mismatch)", {
      host_id,
      project_id,
    });
    return;
  }
  await appendProjectOutboxEventForProject({
    event_type: "project.summary_changed",
    project_id,
    default_bay_id: getConfiguredBayId(),
  });
  await publishProjectAccountFeedEventsBestEffort({
    project_id,
    default_bay_id: getConfiguredBayId(),
  });
}

export async function getManagedRootfsReleaseArtifact({
  host_id,
  image,
}: {
  host_id?: string;
  image: string;
}) {
  if (!host_id) {
    throw new Error("host_id must be specified");
  }
  return await issueRootfsReleaseArtifactAccess({
    host_id,
    image,
  });
}

export async function recordManagedRootfsReleaseReplica({
  host_id,
  image,
  upload,
}: {
  host_id?: string;
  image: string;
  upload: Extract<RootfsUploadedArtifactResult, { backend: "rustic" }>;
}) {
  if (!host_id) {
    throw new Error("host_id must be specified");
  }
  return await recordManagedRootfsRusticReplica({ image, upload });
}

export async function listManagedRootfsReleaseLifecycle({
  host_id,
  images,
}: {
  host_id?: string;
  images: string[];
}): Promise<HostManagedRootfsReleaseLifecycle[]> {
  if (!host_id) {
    throw new Error("host_id must be specified");
  }
  const lifecycleByImage = await loadRootfsReleaseLifecycleByImage(
    images ?? [],
  );
  return Array.from(lifecycleByImage.values()).map((row) => ({
    image: row.runtime_image,
    release_id: row.release_id,
    gc_status: row.gc_status ?? undefined,
  }));
}

export async function claimPendingCopies({
  host_id,
  project_id,
  limit,
}: {
  host_id?: string;
  project_id?: string;
  limit?: number;
}): Promise<ProjectCopyRow[]> {
  if (!host_id) {
    throw new Error("host_id must be specified");
  }
  return await claimPendingCopiesDb({ host_id, project_id, limit });
}

export async function getProjectStartMetadata({
  host_id,
  project_id,
}: {
  host_id?: string;
  project_id: string;
}): Promise<{
  title?: string;
  users?: any;
  image?: string;
  authorized_keys?: string;
  run_quota?: any;
}> {
  if (!host_id) {
    throw new Error("host_id must be specified");
  }
  if (!project_id) {
    throw new Error("project_id must be specified");
  }
  const { rows } = await pool().query(
    `SELECT title, users, rootfs_image AS image, run_quota
       FROM projects
      WHERE project_id=$1
        AND host_id=$2
        AND deleted IS NOT true
      LIMIT 1`,
    [project_id, host_id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(
      `project ${project_id} is not assigned to host ${host_id} or is unavailable`,
    );
  }
  const keys = await sshKeys(project_id);
  const authorized_keys = Object.values(keys)
    .map((key: any) => key.value)
    .join("\n");
  const image = `${row.image ?? ""}`.trim() || DEFAULT_PROJECT_IMAGE;
  return {
    title: row.title ?? undefined,
    users: row.users ?? undefined,
    image,
    authorized_keys: authorized_keys || undefined,
    run_quota: row.run_quota ?? undefined,
  };
}

export async function updateCopyStatus({
  host_id,
  copy_id,
  src_project_id,
  src_path,
  dest_project_id,
  dest_path,
  status,
  last_error,
}: {
  host_id?: string;
  copy_id?: string;
  src_project_id?: string;
  src_path?: string;
  dest_project_id?: string;
  dest_path?: string;
  status: ProjectCopyState;
  last_error?: string;
}): Promise<void> {
  if (!host_id) {
    throw new Error("host_id must be specified");
  }
  if (
    !copy_id &&
    (!src_project_id || !src_path || !dest_project_id || !dest_path)
  ) {
    throw new Error("copy_id or copy key must be specified");
  }
  await updateCopyStatusDb({
    copy_id,
    key: {
      src_project_id: src_project_id ?? "",
      src_path: src_path ?? "",
      dest_project_id: dest_project_id ?? "",
      dest_path: dest_path ?? "",
    },
    status,
    last_error,
  });
}

async function assertHostCredentialProjectAccess({
  host_id,
  project_id,
  owner_account_id,
}: {
  host_id: string;
  project_id: string;
  owner_account_id?: string;
}): Promise<void> {
  const { rowCount } = await pool().query(
    `
      SELECT 1
      FROM projects
      WHERE project_id=$1
        AND host_id=$2
        AND deleted IS NOT true
        AND ($3::text IS NULL OR users ? $3::text)
      LIMIT 1
    `,
    [project_id, host_id, owner_account_id ?? null],
  );
  if (!rowCount) {
    throw new Error("host is not authorized for this credential project");
  }
}

async function assertAccountCanIssueProjectHostToken({
  account_id,
  host_id,
  project_id,
}: {
  account_id: string;
  host_id: string;
  project_id?: string;
}): Promise<void> {
  if (await isAdmin(account_id)) {
    return;
  }

  // If project_id is supplied, require collaborator access and verify placement.
  if (project_id) {
    await assertAccountProjectHostTokenProjectAccess({
      account_id,
      host_id,
      project_id,
    });
    return;
  }

  // Host owner/collaborator controls are also valid authorization paths.
  try {
    await loadHostForListing(host_id, account_id);
    return;
  } catch {
    // continue to project-based fallback check
  }

  // Fallback: allow if this account collaborates on any project hosted here.
  if (
    !(await hasAccountProjectHostTokenHostAccess({
      account_id,
      host_id,
    }))
  ) {
    throw new Error("not authorized for project-host access token");
  }
}

async function assertHostCanIssueProjectHostAgentToken({
  host_id,
  account_id,
  project_id,
}: {
  host_id: string;
  account_id: string;
  project_id: string;
}) {
  await assertProjectHostAgentTokenAccess({
    host_id,
    account_id,
    project_id,
  });
}

async function syncProjectUsersOnHostForBrowserAccess({
  account_id,
  project_id,
  expected_host_id,
}: {
  account_id: string;
  project_id: string;
  expected_host_id: string;
}): Promise<void> {
  const hostBay = await resolveHostBay(expected_host_id);
  if (hostBay && hostBay.bay_id !== getConfiguredBayId()) {
    return;
  }
  const ownership = await resolveProjectBay(project_id);
  if (ownership && ownership.bay_id !== getConfiguredBayId()) {
    const remote = await getInterBayBridge()
      .projectReference(ownership.bay_id, {
        timeout_ms: 15_000,
      })
      .get({
        account_id,
        project_id,
      });
    if (!remote) {
      throw new Error("not authorized for project-host access token");
    }
    if (remote.host_id !== expected_host_id) {
      throw new Error("project is not assigned to the requested host");
    }
    const client = await hostControlClient(expected_host_id);
    await client.updateProjectUsers({
      project_id,
      users: remote.users ?? {},
    });
    return;
  }
  await syncProjectUsersOnHost({
    project_id,
    expected_host_id,
  });
}

export async function issueProjectHostAuthToken({
  account_id,
  host_id,
  project_id,
  ttl_seconds,
}: {
  account_id?: string;
  host_id: string;
  project_id?: string;
  ttl_seconds?: number;
}): Promise<{
  host_id: string;
  token: string;
  expires_at: number;
}> {
  const owner = requireAccount(account_id);
  const hostBay = await resolveHostBay(host_id);
  if (hostBay && hostBay.bay_id !== getConfiguredBayId()) {
    return await getInterBayBridge()
      .projectHostAuthToken(hostBay.bay_id)
      .issue({
        account_id: owner,
        host_id,
        project_id,
        ttl_seconds,
      });
  }
  return await issueProjectHostAuthTokenLocal({
    account_id: owner,
    host_id,
    project_id,
    ttl_seconds,
  });
}

export async function issueProjectHostAuthTokenLocal({
  account_id,
  host_id,
  project_id,
  ttl_seconds,
}: {
  account_id?: string;
  host_id: string;
  project_id?: string;
  ttl_seconds?: number;
}): Promise<{
  host_id: string;
  token: string;
  expires_at: number;
}> {
  const owner = requireAccount(account_id);
  if (!host_id) {
    throw new Error("host_id must be specified");
  }
  if (await isBanned(owner)) {
    throw new Error("account is banned");
  }

  await assertAccountCanIssueProjectHostToken({
    account_id: owner,
    host_id,
    project_id,
  });
  if (project_id) {
    // Keep project-host local ACL up to date before issuing browser token.
    // This is best-effort fast path for grant/revoke propagation.
    await syncProjectUsersOnHostForBrowserAccess({
      account_id: owner,
      project_id,
      expected_host_id: host_id,
    });
  }

  const { token, expires_at } = issueProjectHostAuthTokenJwt({
    account_id: owner,
    host_id,
    ttl_seconds,
    // Hub signs with Ed25519 private key; project-host verifies with public key.
    private_key: getProjectHostAuthTokenPrivateKey(),
  });
  return { host_id, token, expires_at };
}

export async function issueProjectHostAgentAuthToken({
  host_id,
  account_id,
  project_id,
  ttl_seconds,
}: {
  host_id?: string;
  account_id: string;
  project_id: string;
  ttl_seconds?: number;
}): Promise<{
  host_id: string;
  token: string;
  expires_at: number;
}> {
  const resolvedHostId = `${host_id ?? ""}`.trim();
  if (!resolvedHostId) {
    throw new Error("host_id must be specified");
  }
  await assertHostCanIssueProjectHostAgentToken({
    host_id: resolvedHostId,
    account_id,
    project_id,
  });
  await syncProjectUsersOnHost({
    project_id,
    expected_host_id: resolvedHostId,
  });
  const { token, expires_at } = issueProjectHostAuthTokenJwt({
    account_id,
    host_id: resolvedHostId,
    ttl_seconds,
    private_key: getProjectHostAuthTokenPrivateKey(),
  });
  return { host_id: resolvedHostId, token, expires_at };
}

function normalizeExternalCredentialSelector({
  provider,
  kind,
  scope,
  owner_account_id,
  project_id,
  organization_id,
}: {
  provider: string;
  kind: string;
  scope: ExternalCredentialScope;
  owner_account_id?: string;
  project_id?: string;
  organization_id?: string;
}) {
  const normalizedProvider = `${provider ?? ""}`.trim().toLowerCase();
  const normalizedKind = `${kind ?? ""}`.trim().toLowerCase();
  const normalizedScope = `${scope ?? ""}`
    .trim()
    .toLowerCase() as ExternalCredentialScope;
  if (!normalizedProvider) throw new Error("provider must be specified");
  if (!normalizedKind) throw new Error("kind must be specified");
  if (
    normalizedScope !== "account" &&
    normalizedScope !== "project" &&
    normalizedScope !== "organization" &&
    normalizedScope !== "site"
  ) {
    throw new Error(`unsupported scope '${scope}'`);
  }
  if (normalizedScope === "site") {
    throw new Error("site scope is not writable via host API");
  }
  return {
    provider: normalizedProvider,
    kind: normalizedKind,
    scope: normalizedScope,
    owner_account_id,
    project_id,
    organization_id,
  };
}

export async function upsertExternalCredential({
  host_id,
  project_id,
  selector,
  payload,
  metadata,
}: {
  host_id?: string;
  project_id: string;
  selector: {
    provider: string;
    kind: string;
    scope: ExternalCredentialScope;
    owner_account_id?: string;
    project_id?: string;
    organization_id?: string;
  };
  payload: string;
  metadata?: Record<string, any>;
}): Promise<{ id: string; created: boolean }> {
  if (!host_id) {
    throw new Error("host_id must be specified");
  }
  if (!project_id) {
    throw new Error("project_id must be specified");
  }
  if (!selector) {
    throw new Error("selector must be specified");
  }

  const normalized = normalizeExternalCredentialSelector(selector);
  const selectorProjectId =
    normalized.project_id ??
    (normalized.scope === "project" ? project_id : undefined);
  if (normalized.scope === "account" && !normalized.owner_account_id) {
    throw new Error("owner_account_id must be specified for account scope");
  }
  if (normalized.scope === "organization" && !normalized.organization_id) {
    throw new Error("organization_id must be specified for organization scope");
  }
  if (normalized.scope === "project" && !selectorProjectId) {
    throw new Error("project_id must be specified for project scope");
  }

  await assertHostCredentialProjectAccess({
    host_id,
    project_id,
    owner_account_id: normalized.owner_account_id,
  });
  if (selectorProjectId && selectorProjectId !== project_id) {
    await assertHostCredentialProjectAccess({
      host_id,
      project_id: selectorProjectId,
      owner_account_id: normalized.owner_account_id,
    });
  }

  return await upsertExternalCredentialDb({
    selector: {
      provider: normalized.provider,
      kind: normalized.kind,
      scope: normalized.scope,
      owner_account_id: normalized.owner_account_id,
      project_id: selectorProjectId,
      organization_id: normalized.organization_id,
    },
    payload,
    metadata: metadata ?? {},
  });
}

export async function getExternalCredential({
  host_id,
  project_id,
  selector,
}: {
  host_id?: string;
  project_id: string;
  selector: {
    provider: string;
    kind: string;
    scope: ExternalCredentialScope;
    owner_account_id?: string;
    project_id?: string;
    organization_id?: string;
  };
}): Promise<
  | {
      id: string;
      payload: string;
      metadata: Record<string, any>;
      created: Date;
      updated: Date;
      revoked: Date | null;
      last_used: Date | null;
    }
  | undefined
> {
  if (!host_id) {
    throw new Error("host_id must be specified");
  }
  if (!project_id) {
    throw new Error("project_id must be specified");
  }
  if (!selector) {
    throw new Error("selector must be specified");
  }

  const normalized = normalizeExternalCredentialSelector(selector);
  const selectorProjectId =
    normalized.project_id ??
    (normalized.scope === "project" ? project_id : undefined);
  if (normalized.scope === "account" && !normalized.owner_account_id) {
    throw new Error("owner_account_id must be specified for account scope");
  }
  if (normalized.scope === "organization" && !normalized.organization_id) {
    throw new Error("organization_id must be specified for organization scope");
  }
  if (normalized.scope === "project" && !selectorProjectId) {
    throw new Error("project_id must be specified for project scope");
  }

  await assertHostCredentialProjectAccess({
    host_id,
    project_id,
    owner_account_id: normalized.owner_account_id,
  });
  if (selectorProjectId && selectorProjectId !== project_id) {
    await assertHostCredentialProjectAccess({
      host_id,
      project_id: selectorProjectId,
      owner_account_id: normalized.owner_account_id,
    });
  }

  const result = await getExternalCredentialDb({
    selector: {
      provider: normalized.provider,
      kind: normalized.kind,
      scope: normalized.scope,
      owner_account_id: normalized.owner_account_id,
      project_id: selectorProjectId,
      organization_id: normalized.organization_id,
    },
  });
  if (!result) {
    return undefined;
  }
  return {
    id: result.id,
    payload: result.payload,
    metadata: result.metadata,
    created: result.created,
    updated: result.updated,
    revoked: result.revoked,
    last_used: result.last_used,
  };
}

export async function hasExternalCredential({
  host_id,
  project_id,
  selector,
}: {
  host_id?: string;
  project_id: string;
  selector: {
    provider: string;
    kind: string;
    scope: ExternalCredentialScope;
    owner_account_id?: string;
    project_id?: string;
    organization_id?: string;
  };
}): Promise<boolean> {
  if (!host_id) {
    throw new Error("host_id must be specified");
  }
  if (!project_id) {
    throw new Error("project_id must be specified");
  }
  if (!selector) {
    throw new Error("selector must be specified");
  }

  const normalized = normalizeExternalCredentialSelector(selector);
  const selectorProjectId =
    normalized.project_id ??
    (normalized.scope === "project" ? project_id : undefined);
  if (normalized.scope === "account" && !normalized.owner_account_id) {
    throw new Error("owner_account_id must be specified for account scope");
  }
  if (normalized.scope === "organization" && !normalized.organization_id) {
    throw new Error("organization_id must be specified for organization scope");
  }
  if (normalized.scope === "project" && !selectorProjectId) {
    throw new Error("project_id must be specified for project scope");
  }

  await assertHostCredentialProjectAccess({
    host_id,
    project_id,
    owner_account_id: normalized.owner_account_id,
  });
  if (selectorProjectId && selectorProjectId !== project_id) {
    await assertHostCredentialProjectAccess({
      host_id,
      project_id: selectorProjectId,
      owner_account_id: normalized.owner_account_id,
    });
  }

  return await hasExternalCredentialDb({
    selector: {
      provider: normalized.provider,
      kind: normalized.kind,
      scope: normalized.scope,
      owner_account_id: normalized.owner_account_id,
      project_id: selectorProjectId,
      organization_id: normalized.organization_id,
    },
  });
}

export async function touchExternalCredential({
  host_id,
  project_id,
  selector,
}: {
  host_id?: string;
  project_id: string;
  selector: {
    provider: string;
    kind: string;
    scope: ExternalCredentialScope;
    owner_account_id?: string;
    project_id?: string;
    organization_id?: string;
  };
}): Promise<boolean> {
  if (!host_id) {
    throw new Error("host_id must be specified");
  }
  if (!project_id) {
    throw new Error("project_id must be specified");
  }
  if (!selector) {
    throw new Error("selector must be specified");
  }

  const normalized = normalizeExternalCredentialSelector(selector);
  const selectorProjectId =
    normalized.project_id ??
    (normalized.scope === "project" ? project_id : undefined);
  if (normalized.scope === "account" && !normalized.owner_account_id) {
    throw new Error("owner_account_id must be specified for account scope");
  }
  if (normalized.scope === "organization" && !normalized.organization_id) {
    throw new Error("organization_id must be specified for organization scope");
  }
  if (normalized.scope === "project" && !selectorProjectId) {
    throw new Error("project_id must be specified for project scope");
  }

  await assertHostCredentialProjectAccess({
    host_id,
    project_id,
    owner_account_id: normalized.owner_account_id,
  });
  if (selectorProjectId && selectorProjectId !== project_id) {
    await assertHostCredentialProjectAccess({
      host_id,
      project_id: selectorProjectId,
      owner_account_id: normalized.owner_account_id,
    });
  }

  return await touchExternalCredentialDb({
    selector: {
      provider: normalized.provider,
      kind: normalized.kind,
      scope: normalized.scope,
      owner_account_id: normalized.owner_account_id,
      project_id: selectorProjectId,
      organization_id: normalized.organization_id,
    },
  });
}

export async function getSiteOpenAiApiKey({
  host_id,
}: {
  host_id?: string;
}): Promise<{
  enabled: boolean;
  has_api_key: boolean;
  api_key?: string;
}> {
  if (!host_id) {
    throw new Error("host_id must be specified");
  }
  const settings = await getServerSettings();
  const enabled = to_bool(settings.openai_enabled);
  const apiKey = `${settings.openai_api_key ?? ""}`.trim();
  const has_api_key = apiKey.length > 0;
  return {
    enabled,
    has_api_key,
    api_key: enabled && has_api_key ? apiKey : undefined,
  };
}

function formatUsageLimitMessage({
  window,
  reset_in,
}: {
  window: "5h" | "7d";
  reset_in?: string;
}): string {
  const label = window === "5h" ? "5-hour" : "7-day";
  return `You have reached your ${label} LLM usage limit.${reset_in ? ` Limit resets in ${reset_in}.` : ""} Please try again later or upgrade your membership.`;
}

export async function checkCodexSiteUsageAllowance({
  host_id,
  project_id,
  account_id,
  model: _model,
}: {
  host_id?: string;
  project_id: string;
  account_id: string;
  model?: string;
}): Promise<{
  allowed: boolean;
  reason?: string;
  window?: "5h" | "7d";
  reset_in?: string;
}> {
  if (!host_id) {
    throw new Error("host_id must be specified");
  }
  if (!project_id) {
    throw new Error("project_id must be specified");
  }
  if (!account_id) {
    throw new Error("account_id must be specified");
  }
  await assertHostCredentialProjectAccess({
    host_id,
    project_id,
    owner_account_id: account_id,
  });

  const status = await getLLMUsageStatus({ account_id });
  for (const window of status.windows) {
    const limit = window.limit;
    if (limit == null) {
      continue;
    }
    // Deny once usage reaches the configured limit (not only after exceeding).
    if (limit <= 0 || window.used >= limit) {
      return {
        allowed: false,
        reason: formatUsageLimitMessage({
          window: window.window,
          reset_in: window.reset_in,
        }),
        window: window.window,
        reset_in: window.reset_in,
      };
    }
  }

  return { allowed: true };
}

function getCodexFallbackBillingModel(): LanguageModelCore {
  const configured = (
    process.env.COCALC_CODEX_SITE_USAGE_FALLBACK_MODEL ?? "gpt-5-mini"
  ).trim();
  if (isCoreLanguageModel(configured)) {
    return configured;
  }
  return "gpt-5-mini";
}

async function computeCodexSiteUsageUnits({
  model,
  prompt_tokens,
  completion_tokens,
}: {
  model?: string;
  prompt_tokens: number;
  completion_tokens: number;
}): Promise<{
  usage_units: number;
  billed_model: string;
}> {
  const normalized = `${model ?? ""}`.trim();
  if (isCoreLanguageModel(normalized)) {
    return {
      usage_units: await computeUsageUnits({
        model: normalized,
        prompt_tokens,
        completion_tokens,
      }),
      billed_model: normalized,
    };
  }
  const fallback = getCodexFallbackBillingModel();
  return {
    usage_units: await computeUsageUnits({
      model: fallback,
      prompt_tokens,
      completion_tokens,
    }),
    billed_model: fallback,
  };
}

export async function recordCodexSiteUsage({
  host_id,
  project_id,
  account_id,
  model,
  path,
  prompt_tokens,
  completion_tokens,
  total_time_s,
}: {
  host_id?: string;
  project_id: string;
  account_id: string;
  model?: string;
  path?: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_time_s: number;
}): Promise<{ usage_units: number }> {
  if (!host_id) {
    throw new Error("host_id must be specified");
  }
  if (!project_id) {
    throw new Error("project_id must be specified");
  }
  if (!account_id) {
    throw new Error("account_id must be specified");
  }
  await assertHostCredentialProjectAccess({
    host_id,
    project_id,
    owner_account_id: account_id,
  });

  const prompt = Math.max(0, Math.floor(prompt_tokens));
  const completion = Math.max(0, Math.floor(completion_tokens));
  const totalTokens = prompt + completion;
  const { usage_units, billed_model } = await computeCodexSiteUsageUnits({
    model,
    prompt_tokens: prompt,
    completion_tokens: completion,
  });

  await saveResponse({
    account_id,
    analytics_cookie: undefined,
    history: [],
    input: `[codex-site-key] model=${model ?? "unknown"}`,
    model: billed_model,
    output: "",
    path,
    project_id,
    prompt_tokens: prompt,
    system: "",
    tag: "codex-site-key",
    total_time_s: Math.max(0, Number(total_time_s) || 0),
    total_tokens: totalTokens,
    usage_units,
  });

  return { usage_units };
}

export async function listHosts({
  account_id,
  admin_view,
  include_deleted,
  catalog,
  show_all,
}: {
  account_id?: string;
  admin_view?: boolean;
  include_deleted?: boolean;
  catalog?: boolean;
  show_all?: boolean;
}): Promise<Host[]> {
  const owner = requireAccount(account_id);
  if (admin_view && !(await isAdmin(owner))) {
    throw new Error("not authorized");
  }
  const filters: string[] = [];
  const params: any[] = [];
  if (!admin_view) {
    filters.push(
      `(metadata->>'owner' = $${params.length + 1} OR tier IS NOT NULL)`,
    );
    params.push(owner);
  }
  if (!include_deleted) {
    filters.push("deleted IS NULL");
  }
  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const { rows } = await pool().query(
    `SELECT * FROM project_hosts ${whereClause} ORDER BY updated DESC NULLS LAST, created DESC NULLS LAST`,
    params,
  );
  const backupStatus = await loadHostBackupStatus(rows.map((row) => row.id));

  const membership = await loadMembership(owner);
  const userTier = getUserHostTier(membership.entitlements);

  const visibleRows: Array<{
    row: any;
    scope: Host["scope"];
    can_place: boolean;
    can_start: boolean;
    reason_unavailable?: string;
    starred: boolean;
  }> = [];
  for (const row of rows) {
    const metadata = row.metadata ?? {};
    const rowOwner = metadata.owner ?? "";
    const isOwner = rowOwner === owner;
    const collaborators = (metadata.collaborators ?? []) as string[];
    const isCollab = collaborators.includes(owner);
    const tier = normalizeHostTier(row.tier);
    const shared = tier != null;
    const starredBy = (row.starred_by ?? []) as string[];
    const starred = starredBy.includes(owner);

    const scope: Host["scope"] = isOwner
      ? "owned"
      : isCollab
        ? "collab"
        : shared
          ? "pool"
          : "shared";

    const placement = computePlacementPermission({
      tier,
      userTier,
      isOwner,
      isCollab,
    });
    const availability = computeHostOperationalAvailability(row);
    const can_place = placement.can_place && availability.operational;
    const reason_unavailable =
      placement.reason_unavailable ??
      (availability.operational ? undefined : availability.reason_unavailable);

    const can_start = isOwner || (isCollab && !!metadata.host_collab_control);

    const showAll = admin_view || catalog || show_all;
    // If catalog=false, filter out what user cannot place
    if (!showAll && !can_place) {
      continue;
    }

    visibleRows.push({
      row,
      scope,
      can_place,
      can_start,
      reason_unavailable,
      starred,
    });
  }
  const metricsHistory = await loadProjectHostMetricsHistory({
    host_ids: visibleRows.map(({ row }) => row.id),
    window_minutes: 60,
    max_points: 60,
  });

  return visibleRows.map(
    ({ row, scope, can_place, can_start, reason_unavailable, starred }) =>
      parseRow(row, {
        scope,
        can_place,
        can_start,
        reason_unavailable,
        backup_status: backupStatus.get(row.id),
        starred,
        metrics_history: metricsHistory.get(row.id),
      }),
  );
}

export async function resolveHostConnection({
  account_id,
  host_id,
}: {
  account_id?: string;
  host_id: string;
}): Promise<HostConnectionInfo> {
  const owner = requireAccount(account_id);
  if (!host_id) {
    throw new Error("host_id must be specified");
  }
  const local = await resolveHostConnectionLocal({
    account_id: owner,
    host_id,
    allowMissing: true,
  });
  if (local) {
    return local;
  }
  const hostBay = await resolveHostBay(host_id);
  if (!hostBay || hostBay.bay_id === getConfiguredBayId()) {
    throw new Error("host not found");
  }
  return await getInterBayBridge()
    .hostConnection(hostBay.bay_id)
    .get({ account_id: owner, host_id });
}

export async function resolveHostConnectionLocal({
  account_id,
  host_id,
  allowMissing = false,
}: {
  account_id?: string;
  host_id: string;
  allowMissing?: boolean;
}): Promise<HostConnectionInfo | undefined> {
  const owner = requireAccount(account_id);
  if (!host_id) {
    throw new Error("host_id must be specified");
  }
  const { rows } = await pool().query(
    `SELECT id, bay_id, name, public_url, internal_url, ssh_server, metadata, tier, status, last_seen
     FROM project_hosts
     WHERE id=$1 AND deleted IS NULL`,
    [host_id],
  );
  const row = rows[0];
  if (!row) {
    if (allowMissing) {
      return undefined;
    }
    throw new Error("host not found");
  }
  const metadata = row.metadata ?? {};
  const rowOwner = metadata.owner ?? "";
  const collaborators = (metadata.collaborators ?? []) as string[];
  const isOwner = rowOwner === owner;
  const isCollab = collaborators.includes(owner);
  const isShared = row.tier != null;
  const membership = await loadMembership(owner);
  const userTier = getUserHostTier(membership.entitlements);
  const placement = computePlacementPermission({
    tier: row.tier,
    userTier,
    isOwner,
    isCollab,
  });
  if (!isOwner && !isCollab && !isShared) {
    const { rows: projectRows } = await pool().query(
      `SELECT 1
       FROM projects
       WHERE host_id=$1 AND users ? $2
       LIMIT 1`,
      [host_id, owner],
    );
    if (!projectRows.length) {
      throw new Error("not authorized");
    }
  }
  const machine = metadata?.machine ?? {};
  const selfHostMode = machine?.metadata?.self_host_mode;
  const effectiveSelfHostMode =
    machine?.cloud === "self-host" && !selfHostMode ? "local" : selfHostMode;
  const isLocalSelfHost =
    machine?.cloud === "self-host" && effectiveSelfHostMode === "local";

  let connect_url: string | null = null;
  let ssh_server: string | null = row.ssh_server ?? null;
  let local_proxy = false;
  let ready = false;
  const availability = computeHostOperationalAvailability(row);
  const normalizedStatus =
    row.status === "active" ? "running" : (row.status ?? null);
  const pricingModel =
    normalizeHostPricingModel(metadata.pricing_model) ?? "on_demand";
  const interruptionRestorePolicy =
    normalizeHostInterruptionRestorePolicy(
      metadata.interruption_restore_policy,
    ) ?? defaultInterruptionRestorePolicy(pricingModel);
  const lastSeenIso = row.last_seen
    ? new Date(row.last_seen).toISOString()
    : undefined;
  if (isLocalSelfHost) {
    local_proxy = true;
    ready = !!metadata?.self_host?.http_tunnel_port;
    const sshPort = metadata?.self_host?.ssh_tunnel_port;
    if (sshPort) {
      const sshHost = resolveOnPremHost();
      ssh_server = `${sshHost}:${sshPort}`;
    }
  } else {
    connect_url = row.public_url ?? row.internal_url ?? null;
    ready = !!connect_url;
  }

  const response = {
    host_id: row.id,
    bay_id:
      typeof row.bay_id === "string" && row.bay_id.trim()
        ? row.bay_id.trim()
        : null,
    name: row.name ?? null,
    can_place: placement.can_place,
    region: row.region ?? null,
    size: typeof metadata?.size === "string" ? metadata.size : null,
    ssh_server,
    connect_url,
    host_session_id:
      typeof metadata?.host_session_id === "string" &&
      metadata.host_session_id.trim()
        ? metadata.host_session_id.trim()
        : undefined,
    local_proxy,
    ready,
    status: normalizedStatus,
    tier: typeof row.tier === "number" ? row.tier : null,
    pricing_model: pricingModel,
    interruption_restore_policy: interruptionRestorePolicy,
    desired_state: desiredHostState({
      status: normalizedStatus ?? undefined,
      metadata,
    }),
    last_seen: lastSeenIso,
    online: availability.online,
    reason_unavailable: availability.operational
      ? undefined
      : availability.reason_unavailable,
  };
  return response as HostConnectionInfo;
}

export async function listHostProjects({
  account_id,
  id,
  limit,
  cursor,
  risk_only,
  state_filter,
}: {
  account_id?: string;
  id: string;
  limit?: number;
  cursor?: string;
  risk_only?: boolean;
  state_filter?: "all" | "running" | "stopped" | "unprovisioned";
}): Promise<HostProjectsResponse> {
  const host = await loadHostForListing(id, account_id);
  const cappedLimit = normalizeHostProjectsLimit(limit);
  const runningStatesSql = `COALESCE(state->>'state', '') IN ('running','starting')`;
  const needsBackupSql = `
    ${runningStatesSql}
    OR (
      provisioned IS TRUE
      AND (
        last_backup IS NULL
        OR (last_edited IS NOT NULL AND last_edited > last_backup)
      )
    )
  `;

  const params: any[] = [id];
  const filters: string[] = ["deleted IS NOT true", "host_id = $1"];
  const normalizedStateFilter =
    `${state_filter ?? "all"}`.trim().toLowerCase() || "all";

  if (normalizedStateFilter === "running") {
    filters.push(`(${runningStatesSql})`);
  } else if (normalizedStateFilter === "stopped") {
    filters.push(`(provisioned IS TRUE AND NOT (${runningStatesSql}))`);
  } else if (normalizedStateFilter === "unprovisioned") {
    filters.push(`(provisioned IS NOT TRUE)`);
  } else if (normalizedStateFilter !== "all") {
    throw new Error(
      "invalid state_filter; expected all, running, stopped, or unprovisioned",
    );
  }

  if (risk_only) {
    filters.push(`(${needsBackupSql})`);
  }

  if (cursor) {
    const decoded = decodeHostProjectsCursor(cursor);
    const cursorDate =
      decoded.last_edited == null ? new Date(0) : new Date(decoded.last_edited);
    if (Number.isNaN(cursorDate.valueOf())) {
      throw new Error("invalid cursor timestamp");
    }
    params.push(cursorDate);
    params.push(decoded.project_id);
    filters.push(
      `(COALESCE(last_edited, to_timestamp(0)) < $${
        params.length - 1
      } OR (COALESCE(last_edited, to_timestamp(0)) = $${
        params.length - 1
      } AND project_id < $${params.length}))`,
    );
  }

  params.push(cappedLimit + 1);
  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const { rows } = await pool().query<{
    project_id: string;
    title: string | null;
    state: string | null;
    provisioned: boolean | null;
    last_edited: Date | null;
    last_backup: Date | null;
    needs_backup: boolean;
    collab_count: string;
  }>(
    `
      SELECT
        project_id,
        LEFT(COALESCE(title, ''), 80) AS title,
        COALESCE(state->>'state', '') AS state,
        provisioned,
        last_edited,
        last_backup,
        (${needsBackupSql}) AS needs_backup,
        COALESCE(
          (
            SELECT COUNT(*)
            FROM jsonb_object_keys(COALESCE(users::jsonb, '{}'::jsonb))
          ),
          0
        ) AS collab_count
      FROM projects
      ${whereClause}
      ORDER BY COALESCE(last_edited, to_timestamp(0)) DESC, project_id DESC
      LIMIT $${params.length}
    `,
    params,
  );

  let next_cursor: string | undefined;
  let trimmed = rows;
  if (rows.length > cappedLimit) {
    trimmed = rows.slice(0, cappedLimit);
    const last = trimmed[trimmed.length - 1];
    next_cursor = encodeHostProjectsCursor({
      project_id: last.project_id,
      last_edited: normalizeDate(last.last_edited),
    });
  }

  const summaryMap = await loadHostBackupStatus([id]);
  const summary = summaryMap.get(id) ?? {
    total: 0,
    provisioned: 0,
    running: 0,
    provisioned_up_to_date: 0,
    provisioned_needs_backup: 0,
  };

  const resultRows: HostProjectRow[] = trimmed.map((row) => ({
    project_id: row.project_id,
    title: row.title ?? "",
    state: row.state ?? "",
    provisioned: row.provisioned ?? null,
    last_edited: normalizeDate(row.last_edited),
    last_backup: normalizeDate(row.last_backup),
    needs_backup: !!row.needs_backup,
    collab_count: Number(row.collab_count ?? 0),
  }));

  return {
    rows: resultRows,
    summary,
    next_cursor,
    host_last_seen: normalizeDate(host.last_seen) ?? undefined,
  };
}

export async function getCatalog({
  account_id,
  provider,
}: {
  account_id?: string;
  provider?: string;
}): Promise<HostCatalog> {
  requireAccount(account_id);
  const cloud = provider ?? "gcp";
  if (cloud === "self-host") {
    const { rows } = await pool().query<{
      connector_id: string;
      name: string | null;
      last_seen: Date | null;
      metadata: any;
    }>(
      `SELECT connector_id, name, last_seen, metadata
         FROM self_host_connectors
        WHERE account_id=$1 AND revoked IS NOT TRUE
        ORDER BY created DESC`,
      [account_id],
    );
    const connectors = rows.map((row) => ({
      id: row.connector_id,
      name: row.name ?? undefined,
      last_seen: row.last_seen ? row.last_seen.toISOString() : undefined,
      version: row.metadata?.version,
    }));
    const { project_hosts_self_host_alpha_enabled } = await getServerSettings();
    const modes = (await hasCloudflareTunnel())
      ? ["cloudflare", "local"]
      : ["local"];
    const kinds = ["direct"];
    if (project_hosts_self_host_alpha_enabled) {
      kinds.push("multipass");
    }
    return {
      provider: cloud,
      entries: [
        {
          kind: "connectors",
          scope: "account",
          payload: connectors,
        },
        {
          kind: "self_host_modes",
          scope: "account",
          payload: modes,
        },
        {
          kind: "self_host_kinds",
          scope: "account",
          payload: kinds,
        },
      ],
      provider_capabilities: Object.fromEntries(
        listServerProviders().map((entry) => [
          entry.id,
          entry.entry.capabilities,
        ]),
      ),
    };
  }
  const { rows } = await pool().query(
    `SELECT kind, scope, payload
       FROM cloud_catalog_cache
      WHERE provider=$1`,
    [cloud],
  );

  const catalog: HostCatalog = {
    provider: cloud,
    entries: rows.map((row) => ({
      kind: row.kind,
      scope: row.scope,
      payload: row.payload,
    })),
    provider_capabilities: Object.fromEntries(
      listServerProviders().map((entry) => [
        entry.id,
        entry.entry.capabilities,
      ]),
    ),
  };

  return catalog;
}

export async function updateCloudCatalog({
  account_id,
  provider,
}: {
  account_id?: string;
  provider?: string;
}): Promise<void> {
  const owner = requireAccount(account_id);
  if (!(await isAdmin(owner))) {
    throw new Error("not authorized");
  }
  await refreshCloudCatalogNow({
    provider: provider as ProviderId | undefined,
  });
}

export async function getHostLog({
  account_id,
  id,
  limit,
}: {
  account_id?: string;
  id: string;
  limit?: number;
}): Promise<
  {
    id: string;
    vm_id: string;
    ts?: string | null;
    action: string;
    status: string;
    provider?: string | null;
    spec?: Record<string, any> | null;
    error?: string | null;
  }[]
> {
  await loadHostForView(id, account_id);
  const entries = await listCloudVmLog({ vm_id: id, limit });
  return entries.map((entry) => ({
    id: entry.id,
    vm_id: entry.vm_id,
    ts: entry.ts ? entry.ts.toISOString() : null,
    action: entry.action,
    status: entry.status,
    provider: entry.provider ?? null,
    spec: entry.spec ?? null,
    error: entry.error ?? null,
  }));
}

function normalizeHostRuntimeLogLines(lines?: number): number {
  const n = Number(lines ?? 200);
  if (!Number.isFinite(n)) return 200;
  return Math.max(1, Math.min(5000, Math.floor(n)));
}

export async function getHostRuntimeLog({
  account_id,
  id,
  lines,
}: {
  account_id?: string;
  id: string;
  lines?: number;
}): Promise<{ host_id: string; source: string; lines: number; text: string }> {
  await loadOwnedHost(id, account_id);
  const client = await hostControlClient(id);
  const response = await client.getRuntimeLog({
    lines: normalizeHostRuntimeLogLines(lines),
  });
  return {
    host_id: id,
    source: response.source,
    lines: response.lines,
    text: response.text,
  };
}

export async function getHostMetricsHistory({
  account_id,
  id,
  window_minutes,
  max_points,
}: {
  account_id?: string;
  id: string;
  window_minutes?: number;
  max_points?: number;
}): Promise<HostMetricsHistory> {
  const host = await loadHostForListing(id, account_id);
  const history = await loadProjectHostMetricsHistory({
    host_ids: [host.id],
    window_minutes,
    max_points,
  });
  return (
    history.get(host.id) ?? {
      window_minutes: Math.max(5, Math.floor(Number(window_minutes ?? 60))),
      point_count: 0,
      points: [],
    }
  );
}

export async function listHostRootfsImages({
  account_id,
  id,
}: {
  account_id?: string;
  id: string;
}): Promise<HostRootfsImage[]> {
  const row = await loadHostForRootfsManagement(id, account_id);
  const availability = computeHostOperationalAvailability(row);
  if (!availability.operational) {
    throw new Error(
      availability.reason_unavailable ??
        "host must be running to inspect RootFS cache",
    );
  }
  const client = await hostControlClient(id, HOST_ROOTFS_RPC_TIMEOUT_MS);
  return await enrichHostRootfsImages(await client.listRootfsImages());
}

export async function pullHostRootfsImage({
  account_id,
  id,
  image,
}: {
  account_id?: string;
  id: string;
  image: string;
}): Promise<HostRootfsImage> {
  const row = await loadHostForRootfsManagement(id, account_id);
  const availability = computeHostOperationalAvailability(row);
  if (!availability.operational) {
    throw new Error(
      availability.reason_unavailable ??
        "host must be running to pull RootFS images",
    );
  }
  const client = await hostControlClient(id, HOST_ROOTFS_RPC_TIMEOUT_MS);
  try {
    return await client.pullRootfsImage({ image });
  } catch (err) {
    const autoGrow = await maybeAutoGrowHostDiskForReservationFailure({
      host_id: id,
      err,
    });
    if (autoGrow.grown) {
      return await client.pullRootfsImage({ image });
    }
    throw err;
  }
}

export async function deleteHostRootfsImage({
  account_id,
  id,
  image,
}: {
  account_id?: string;
  id: string;
  image: string;
}): Promise<{ removed: boolean }> {
  const row = await loadHostForRootfsManagement(id, account_id);
  const availability = computeHostOperationalAvailability(row);
  if (!availability.operational) {
    throw new Error(
      availability.reason_unavailable ??
        "host must be running to delete RootFS images",
    );
  }
  const client = await hostControlClient(id, HOST_ROOTFS_RPC_TIMEOUT_MS);
  return await client.deleteRootfsImage({ image });
}

export async function gcDeletedHostRootfsImages({
  account_id,
  id,
}: {
  account_id?: string;
  id: string;
}): Promise<HostRootfsGcResult> {
  const row = await loadHostForRootfsManagement(id, account_id);
  const availability = computeHostOperationalAvailability(row);
  if (!availability.operational) {
    throw new Error(
      availability.reason_unavailable ??
        "host must be running to garbage collect RootFS images",
    );
  }
  const client = await hostControlClient(id, HOST_ROOTFS_RPC_TIMEOUT_MS);
  const entries = await enrichHostRootfsImages(await client.listRootfsImages());
  const items: HostRootfsGcResult["items"] = [];
  for (const entry of entries) {
    if (!entry.host_gc_eligible) {
      items.push({
        image: entry.image,
        status: "skipped",
        reason: entry.managed
          ? entry.release_gc_status === "deleted"
            ? "image is still referenced on this host"
            : entry.release_gc_status
              ? `central release status is ${entry.release_gc_status}`
              : "central release is still active"
          : "image is not managed by the RootFS release registry",
      });
      continue;
    }
    try {
      const result = await client.deleteRootfsImage({ image: entry.image });
      items.push({
        image: entry.image,
        status: result.removed ? "removed" : "skipped",
        reason: result.removed ? undefined : "image was not present in cache",
      });
    } catch (err) {
      items.push({
        image: entry.image,
        status: "failed",
        reason: err instanceof Error ? err.message : `${err}`,
      });
    }
  }
  return {
    scanned: entries.length,
    removed: items.filter((item) => item.status === "removed").length,
    skipped: items.filter((item) => item.status === "skipped").length,
    failed: items.filter((item) => item.status === "failed").length,
    items,
  };
}

export async function listHostSshAuthorizedKeys({
  account_id,
  id,
}: {
  account_id?: string;
  id: string;
}): Promise<{
  host_id: string;
  user: string;
  home: string;
  path: string;
  keys: string[];
}> {
  await loadOwnedHost(id, account_id);
  const client = await hostControlClient(id);
  const response = await client.listHostSshAuthorizedKeys();
  return {
    host_id: id,
    user: response.user,
    home: response.home,
    path: response.path,
    keys: response.keys ?? [],
  };
}

export async function addHostSshAuthorizedKey({
  account_id,
  id,
  public_key,
}: {
  account_id?: string;
  id: string;
  public_key: string;
}): Promise<{
  host_id: string;
  user: string;
  home: string;
  path: string;
  keys: string[];
  added: boolean;
}> {
  await loadOwnedHost(id, account_id);
  const client = await hostControlClient(id);
  const response = await client.addHostSshAuthorizedKey({ public_key });
  return {
    host_id: id,
    user: response.user,
    home: response.home,
    path: response.path,
    keys: response.keys ?? [],
    added: !!response.added,
  };
}

export async function removeHostSshAuthorizedKey({
  account_id,
  id,
  public_key,
}: {
  account_id?: string;
  id: string;
  public_key: string;
}): Promise<{
  host_id: string;
  user: string;
  home: string;
  path: string;
  keys: string[];
  removed: boolean;
}> {
  await loadOwnedHost(id, account_id);
  const client = await hostControlClient(id);
  const response = await client.removeHostSshAuthorizedKey({ public_key });
  return {
    host_id: id,
    user: response.user,
    home: response.home,
    path: response.path,
    keys: response.keys ?? [],
    removed: !!response.removed,
  };
}

export async function createHost({
  account_id,
  name,
  region,
  size,
  gpu = false,
  pricing_model,
  interruption_restore_policy,
  machine,
}: {
  account_id?: string;
  name: string;
  region: string;
  size: string;
  gpu?: boolean;
  pricing_model?: HostPricingModel;
  interruption_restore_policy?: HostInterruptionRestorePolicy;
  machine?: Host["machine"];
}): Promise<Host> {
  const owner = requireAccount(account_id);
  const membership = await loadMembership(owner);
  requireCreateHosts(membership.entitlements);
  const id = randomUUID();
  const machineCloud = normalizeProviderId(machine?.cloud);
  const isSelfHost = machineCloud === "self-host";
  const normalizedPricingModel = normalizeHostPricingModel(pricing_model);
  if (pricing_model != null && !normalizedPricingModel) {
    throw new Error(`invalid pricing_model '${pricing_model}'`);
  }
  const normalizedRestorePolicy = normalizeHostInterruptionRestorePolicy(
    interruption_restore_policy,
  );
  if (interruption_restore_policy != null && !normalizedRestorePolicy) {
    throw new Error(
      `invalid interruption_restore_policy '${interruption_restore_policy}'`,
    );
  }
  const pricingModel = normalizedPricingModel ?? "on_demand";
  const interruptionRestorePolicy =
    normalizedRestorePolicy ?? defaultInterruptionRestorePolicy(pricingModel);
  const initialStatus = machineCloud && !isSelfHost ? "starting" : "off";
  const initialDesiredState: "running" | "stopped" =
    machineCloud && !isSelfHost ? "running" : "stopped";
  const rawSelfHostMode = machine?.metadata?.self_host_mode;
  const selfHostMode =
    rawSelfHostMode === "cloudflare" || rawSelfHostMode === "local"
      ? rawSelfHostMode
      : undefined;
  if (isSelfHost && rawSelfHostMode && !selfHostMode) {
    throw new Error(`invalid self_host_mode '${rawSelfHostMode}'`);
  }
  const rawSelfHostKind = machine?.metadata?.self_host_kind;
  const selfHostKind =
    rawSelfHostKind === "direct" || rawSelfHostKind === "multipass"
      ? rawSelfHostKind
      : undefined;
  if (isSelfHost && rawSelfHostKind && !selfHostKind) {
    throw new Error(`invalid self_host_kind '${rawSelfHostKind}'`);
  }
  const effectiveSelfHostKind = isSelfHost
    ? (selfHostKind ?? "direct")
    : undefined;
  if (isSelfHost && selfHostMode === "cloudflare") {
    if (!(await hasCloudflareTunnel())) {
      throw new Error("cloudflare tunnel is not configured");
    }
  }
  const { project_hosts_bootstrap_channel, project_hosts_bootstrap_version } =
    await getServerSettings();
  const requestedBootstrapChannel =
    typeof machine?.metadata?.bootstrap_channel === "string"
      ? machine.metadata.bootstrap_channel.trim()
      : "";
  const requestedBootstrapVersion =
    typeof machine?.metadata?.bootstrap_version === "string"
      ? machine.metadata.bootstrap_version.trim()
      : "";
  const bootstrapChannel =
    requestedBootstrapChannel ||
    project_hosts_bootstrap_channel?.trim() ||
    "latest";
  const bootstrapVersion =
    requestedBootstrapVersion || project_hosts_bootstrap_version?.trim() || "";
  let resolvedRegion = region;
  let connectorId: string | undefined;
  if (isSelfHost) {
    const connector = await createConnectorRecord({
      account_id: owner,
      host_id: id,
      name,
    });
    connectorId = connector.connector_id;
    resolvedRegion = connectorId;
  }
  const normalizedMachine = normalizeMachineGpuInPlace(
    {
      ...(machine ?? {}),
      ...(machineCloud ? { cloud: machineCloud } : {}),
      ...(connectorId
        ? {
            metadata: {
              ...(machine?.metadata ?? {}),
              connector_id: connectorId,
              ...(selfHostMode ? { self_host_mode: selfHostMode } : {}),
              ...(effectiveSelfHostKind
                ? { self_host_kind: effectiveSelfHostKind }
                : {}),
            },
          }
        : {}),
    },
    gpu,
  );
  const gpuEnabled = machineHasGpu(normalizedMachine);

  await pool().query(
    `INSERT INTO project_hosts (id, name, region, status, metadata, created, updated, last_seen, bay_id)
     VALUES ($1,$2,$3,$4,$5,NOW(),NOW(),$6,$7)`,
    [
      id,
      name,
      resolvedRegion,
      initialStatus,
      {
        owner,
        size,
        gpu: gpuEnabled,
        pricing_model: pricingModel,
        interruption_restore_policy: interruptionRestorePolicy,
        desired_state: initialDesiredState,
        machine: normalizedMachine,
        ...(machineCloud && !isSelfHost
          ? {
              bootstrap: {
                status: "queued",
                updated_at: new Date().toISOString(),
                message: "Waiting for cloud host bootstrap",
              },
            }
          : {}),
        ...(bootstrapChannel ? { bootstrap_channel: bootstrapChannel } : {}),
        ...(bootstrapVersion ? { bootstrap_version: bootstrapVersion } : {}),
      },
      null,
      getConfiguredBayId(),
    ],
  );
  if (machineCloud && !isSelfHost) {
    await enqueueCloudVmWork({
      vm_id: id,
      action: "provision",
      payload: { provider: machineCloud },
    });
  }
  const { rows } = await pool().query(
    `SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new Error("host not found after create");
  return parseRow(row, {
    scope: "owned",
    can_start: true,
    can_place: true,
  });
}

async function createHostLro({
  kind,
  row,
  account_id,
  input,
  dedupe_key,
}: {
  kind: HostLroKind;
  row: { id: string };
  account_id?: string;
  input: any;
  dedupe_key?: string;
}): Promise<HostLroResponse> {
  const op = await createLro({
    kind,
    scope_type: "host",
    scope_id: row.id,
    created_by: account_id,
    routing: "hub",
    input,
    dedupe_key,
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
      detail: input,
    },
  }).catch(() => {});
  return {
    op_id: op.op_id,
    scope_type: "host",
    scope_id: row.id,
    service: PERSIST_SERVICE,
    stream_name: lroStreamName(op.op_id),
    kind,
  };
}

export async function startHost({
  account_id,
  id,
}: {
  account_id?: string;
  id: string;
}): Promise<HostLroResponse> {
  const row = await loadHostForStartStop(id, account_id);
  return await createHostLro({
    kind: HOST_START_LRO_KIND,
    row,
    account_id,
    input: { id: row.id, account_id },
    dedupe_key: `${HOST_START_LRO_KIND}:${row.id}`,
  });
}

export async function startHostInternal({
  account_id,
  id,
}: {
  account_id?: string;
  id: string;
}): Promise<Host> {
  const row = await loadHostForStartStop(id, account_id);
  const metadata = row.metadata ?? {};
  const owner = metadata.owner ?? account_id;
  const machine: HostMachine = metadata.machine ?? {};
  const machineCloud = normalizeProviderId(machine.cloud);
  const sshTarget = String(machine.metadata?.self_host_ssh_target ?? "").trim();
  if (machineCloud === "self-host" && sshTarget && owner) {
    await ensureSelfHostReverseTunnel({
      host_id: row.id,
      ssh_target: sshTarget,
    });
    const { rows: connectorRows } = await pool().query<{
      connector_id: string;
      last_seen: Date | null;
    }>(
      `SELECT connector_id, last_seen
         FROM self_host_connectors
        WHERE host_id=$1 AND revoked IS NOT TRUE
        ORDER BY last_seen DESC NULLS LAST
        LIMIT 1`,
      [row.id],
    );
    const connectorRow = connectorRows[0];
    const lastSeen = connectorRow?.last_seen;
    const connectorOnline =
      !!lastSeen && Date.now() - lastSeen.getTime() < 2 * 60 * 1000;
    if (!connectorOnline) {
      const tokenInfo = await createPairingTokenForHost({
        account_id: owner,
        host_id: row.id,
        ttlMs: 30 * 60 * 1000,
      });
      const { project_hosts_self_host_connector_version } =
        await getServerSettings();
      const connectorVersion =
        project_hosts_self_host_connector_version?.trim() || undefined;
      const { rows: metaRows } = await pool().query<{ metadata: any }>(
        `SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL`,
        [row.id],
      );
      const updatedMetadata = metaRows[0]?.metadata ?? metadata;
      const reversePort = Number(
        updatedMetadata?.self_host?.ssh_reverse_port ?? 0,
      );
      if (!reversePort) {
        throw new Error("self-host ssh reverse port missing");
      }
      await runConnectorInstallOverSsh({
        host_id: row.id,
        ssh_target: sshTarget,
        pairing_token: tokenInfo.token,
        name: row.name ?? undefined,
        ssh_port: reversePort,
        version: connectorVersion,
      });
    }
  }
  if (machineCloud === "self-host" && row.region && owner) {
    await ensureConnectorRecord({
      connector_id: row.region,
      account_id: owner,
      host_id: row.id,
      name: row.name ?? undefined,
    });
  }
  const { rows: metaRowsFinal } = await pool().query<{ metadata: any }>(
    `SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL`,
    [row.id],
  );
  const nextMetadata = metaRowsFinal[0]?.metadata ?? metadata;
  nextMetadata.desired_state = "running";
  if (nextMetadata?.self_host?.auto_start_pending) {
    const nextSelfHost = {
      ...(nextMetadata.self_host ?? {}),
      auto_start_pending: false,
      auto_start_cleared_at: new Date().toISOString(),
    };
    nextMetadata.self_host = nextSelfHost;
  }
  if (nextMetadata?.bootstrap) {
    // bootstrap should be idempotent and we bootstrap on EVERY start
    delete nextMetadata.bootstrap;
  }
  if (machineCloud && machineCloud !== "self-host") {
    nextMetadata.bootstrap = {
      status: "queued",
      updated_at: new Date().toISOString(),
      message: "Waiting for cloud host bootstrap",
    };
  }
  logStatusUpdate(id, "starting", "api");
  await pool().query(
    `UPDATE project_hosts SET status=$2, last_seen=$3, metadata=$4, updated=NOW() WHERE id=$1 AND deleted IS NULL`,
    [id, "starting", null, nextMetadata],
  );
  if (!machineCloud) {
    logStatusUpdate(id, "running", "api");
    await pool().query(
      `UPDATE project_hosts SET status=$2, last_seen=$3, updated=NOW() WHERE id=$1 AND deleted IS NULL`,
      [id, "running", new Date()],
    );
  } else {
    await markHostActionPending(id, "start");
    await enqueueCloudVmWork({
      vm_id: id,
      action: "start",
      payload: { provider: machineCloud },
    });
  }
  const { rows } = await pool().query(
    `SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL`,
    [id],
  );
  if (!rows[0]) throw new Error("host not found");
  return parseRow(rows[0]);
}

export async function stopHost({
  account_id,
  id,
  skip_backups,
}: {
  account_id?: string;
  id: string;
  skip_backups?: boolean;
}): Promise<HostLroResponse> {
  const row = await loadHostForStartStop(id, account_id);
  return await createHostLro({
    kind: HOST_STOP_LRO_KIND,
    row,
    account_id,
    input: { id: row.id, account_id, skip_backups: !!skip_backups },
    dedupe_key: `${HOST_STOP_LRO_KIND}:${row.id}`,
  });
}

export async function stopHostInternal({
  account_id,
  id,
}: {
  account_id?: string;
  id: string;
}): Promise<Host> {
  const row = await loadHostForStartStop(id, account_id);
  const metadata = row.metadata ?? {};
  const nextMetadata = { ...metadata, desired_state: "stopped" };
  const machine: HostMachine = metadata.machine ?? {};
  const machineCloud = normalizeProviderId(machine.cloud);
  logStatusUpdate(id, "stopping", "api");
  await pool().query(
    `UPDATE project_hosts SET status=$2, last_seen=$3, metadata=$4, updated=NOW() WHERE id=$1 AND deleted IS NULL`,
    [id, "stopping", null, nextMetadata],
  );
  if (!machineCloud) {
    logStatusUpdate(id, "off", "api");
    await pool().query(
      `UPDATE project_hosts SET status=$2, last_seen=$3, metadata=$4, updated=NOW() WHERE id=$1 AND deleted IS NULL`,
      [id, "off", null, nextMetadata],
    );
  } else {
    await markHostActionPending(id, "stop");
    await enqueueCloudVmWork({
      vm_id: id,
      action: "stop",
      payload: { provider: machineCloud },
    });
  }
  const { rows } = await pool().query(
    `SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL`,
    [id],
  );
  if (!rows[0]) throw new Error("host not found");
  return parseRow(rows[0]);
}

export async function restartHost({
  account_id,
  id,
  mode,
}: {
  account_id?: string;
  id: string;
  mode?: "reboot" | "hard";
}): Promise<HostLroResponse> {
  const row = await loadHostForStartStop(id, account_id);
  return await createHostLro({
    kind: HOST_RESTART_LRO_KIND,
    row,
    account_id,
    input: { id: row.id, account_id, mode },
    dedupe_key: `${HOST_RESTART_LRO_KIND}:${row.id}:${mode ?? "reboot"}`,
  });
}

export async function restartHostInternal({
  account_id,
  id,
  mode,
}: {
  account_id?: string;
  id: string;
  mode?: "reboot" | "hard";
}): Promise<Host> {
  const row = await loadHostForStartStop(id, account_id);
  if (row.status === "deprovisioned") {
    throw new Error("host is not provisioned");
  }
  if (!["running", "error"].includes(row.status)) {
    throw new Error("host must be running to restart");
  }
  const metadata = row.metadata ?? {};
  metadata.desired_state = "running";
  const owner = metadata.owner ?? account_id;
  const machine: HostMachine = metadata.machine ?? {};
  const machineCloud = normalizeProviderId(machine.cloud);
  const provider = machineCloud ? getServerProvider(machineCloud) : undefined;
  const caps = provider?.entry.capabilities;
  const wantsHard = mode === "hard";
  if (machineCloud && caps) {
    const supported = wantsHard
      ? caps.supportsHardRestart
      : caps.supportsRestart;
    if (!supported) {
      throw new Error(
        wantsHard ? "hard reboot is not supported" : "reboot is not supported",
      );
    }
  }
  if (machineCloud === "self-host" && row.region && owner) {
    await ensureConnectorRecord({
      connector_id: row.region,
      account_id: owner,
      host_id: row.id,
      name: row.name ?? undefined,
    });
  }
  logStatusUpdate(id, "restarting", "api");
  await pool().query(
    `UPDATE project_hosts SET status=$2, last_seen=$3, metadata=$4, updated=NOW() WHERE id=$1 AND deleted IS NULL`,
    [id, "restarting", null, metadata],
  );
  if (!machineCloud) {
    logStatusUpdate(id, "running", "api");
    await pool().query(
      `UPDATE project_hosts SET status=$2, last_seen=$3, metadata=$4, updated=NOW() WHERE id=$1 AND deleted IS NULL`,
      [id, "running", new Date(), metadata],
    );
  } else {
    await markHostActionPending(
      id,
      mode === "hard" ? "hard_restart" : "restart",
    );
    await enqueueCloudVmWork({
      vm_id: id,
      action: mode === "hard" ? "hard_restart" : "restart",
      payload: { provider: machineCloud },
    });
  }
  const { rows } = await pool().query(
    `SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL`,
    [id],
  );
  if (!rows[0]) throw new Error("host not found");
  return parseRow(rows[0]);
}

export async function drainHost({
  account_id,
  id,
  dest_host_id,
  force,
  allow_offline,
  parallel,
}: {
  account_id?: string;
  id: string;
  dest_host_id?: string;
  force?: boolean;
  allow_offline?: boolean;
  parallel?: number;
}): Promise<HostLroResponse> {
  const owner = requireAccount(account_id);
  const row = await loadHostForDrain(id, owner);
  const destination = `${dest_host_id ?? ""}`.trim() || undefined;
  const drainParallel = await resolveDrainParallel(owner, parallel);
  if (destination === row.id) {
    throw new Error("destination host must differ from source host");
  }
  if (destination) {
    await loadHostForListing(destination, owner);
  }
  return await createHostLro({
    kind: HOST_DRAIN_LRO_KIND,
    row,
    account_id: owner,
    input: {
      id: row.id,
      account_id: owner,
      dest_host_id: destination,
      force: !!force,
      allow_offline: !!allow_offline,
      parallel: drainParallel,
    },
    dedupe_key: `${HOST_DRAIN_LRO_KIND}:${row.id}:${destination ?? "auto"}:${force ? "force" : "safe"}:${allow_offline ? "allow-offline" : "strict"}:p${drainParallel}`,
  });
}

export async function drainHostInternal({
  account_id,
  id,
  dest_host_id,
  force,
  allow_offline,
  parallel,
  shouldCancel,
  onProgress,
}: {
  account_id?: string;
  id: string;
  dest_host_id?: string;
  force?: boolean;
  allow_offline?: boolean;
  parallel?: number;
  shouldCancel?: () => Promise<boolean>;
  onProgress?: (update: {
    message: string;
    detail?: Record<string, any>;
    progress?: number;
  }) => Promise<void> | void;
}): Promise<HostDrainResult> {
  const owner = requireAccount(account_id);
  const row = await loadHostForDrain(id, owner);
  const drainParallel = await resolveDrainParallel(owner, parallel);
  const destination = `${dest_host_id ?? ""}`.trim() || undefined;
  if (destination === row.id) {
    throw new Error("destination host must differ from source host");
  }
  if (destination) {
    await loadHostForListing(destination, owner);
  }

  const projectIds = await loadProjectIdsAssignedToHost(row.id);
  const total = projectIds.length;
  const resultBase = {
    host_id: row.id,
    mode: force ? "force" : "move",
    total,
    moved: 0,
    unassigned: 0,
    failed: 0,
    parallel: drainParallel,
    ...(destination ? { dest_host_id: destination } : {}),
  } satisfies HostDrainResult;

  if (!total) {
    await onProgress?.({
      message: "host already drained",
      detail: { host_id: row.id, total: 0 },
      progress: 100,
    });
    return resultBase;
  }

  const canceled = async () => {
    if (!shouldCancel) return false;
    return await shouldCancel();
  };

  if (force) {
    if (await canceled()) {
      throw new Error("host drain canceled");
    }
    await onProgress?.({
      message: "force-unassigning workspaces",
      detail: { host_id: row.id, total },
      progress: 20,
    });
    const { rows } = await pool().query<{ project_id: string }>(
      `
        UPDATE projects
        SET host_id=NULL
        WHERE host_id=$1
          AND deleted IS NOT true
        RETURNING project_id
      `,
      [row.id],
    );
    for (const moved of rows) {
      await notifyProjectHostUpdate({ project_id: moved.project_id });
    }
    await onProgress?.({
      message: "force-unassign complete",
      detail: { host_id: row.id, total, unassigned: rows.length },
      progress: 100,
    });
    return {
      ...resultBase,
      unassigned: rows.length,
      failed: Math.max(0, total - rows.length),
    };
  }

  const maxParallel = Math.max(1, Math.min(drainParallel, total));
  let moved = 0;
  let completed = 0;
  let nextIndex = 0;
  let firstError: Error | undefined;

  await onProgress?.({
    message: "starting host drain",
    detail: {
      host_id: row.id,
      total,
      parallel: maxParallel,
      dest_host_id: destination,
    },
    progress: 5,
  });

  const worker = async () => {
    while (true) {
      if (firstError) return;
      if (await canceled()) {
        firstError = new Error("host drain canceled");
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      if (index >= total) return;
      const project_id = projectIds[index];
      try {
        const moveAccountId = await resolveDrainMoveAccount({
          project_id,
          fallback_account_id: owner,
        });
        await moveProjectToHost(
          {
            project_id,
            account_id: moveAccountId,
            dest_host_id: destination,
            allow_offline: !!allow_offline,
            start_dest: true,
            stop_dest_after_start: true,
          },
          { shouldCancel },
        );
        moved += 1;
        completed += 1;
        const started = Math.min(total, nextIndex);
        const in_flight = Math.max(0, started - completed);
        await onProgress?.({
          message: `drained ${completed}/${total}`,
          detail: {
            host_id: row.id,
            project_id,
            moved,
            completed,
            total,
            parallel: maxParallel,
            in_flight,
            dest_host_id: destination,
          },
          progress: Math.min(
            95,
            Math.max(5, Math.round((completed / total) * 95)),
          ),
        });
      } catch (err) {
        completed += 1;
        if (await canceled()) {
          firstError = new Error("host drain canceled");
        } else if (!firstError) {
          firstError = new Error(
            `failed to drain workspace ${project_id}: ${
              err instanceof Error ? err.message : `${err}`
            }`,
          );
        }
        await onProgress?.({
          message: "host drain failed",
          detail: {
            host_id: row.id,
            project_id,
            completed,
            total,
            parallel: maxParallel,
            error: `${err}`,
          },
          progress: Math.min(
            95,
            Math.max(5, Math.round((completed / total) * 95)),
          ),
        });
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: maxParallel }, () => worker()));

  if (firstError) {
    throw firstError;
  }

  await onProgress?.({
    message: "host drain complete",
    detail: {
      host_id: row.id,
      total,
      moved,
      parallel: maxParallel,
      dest_host_id: destination,
    },
    progress: 100,
  });
  return {
    ...resultBase,
    moved,
    failed: Math.max(0, total - moved),
  };
}

export async function forceDeprovisionHost({
  account_id,
  id,
}: {
  account_id?: string;
  id: string;
}): Promise<HostLroResponse> {
  const row = await loadOwnedHost(id, account_id);
  const machineCloud = normalizeProviderId(row.metadata?.machine?.cloud);
  if (machineCloud !== "self-host") {
    throw new Error("force deprovision is only supported for self-hosted VMs");
  }
  return await createHostLro({
    kind: HOST_FORCE_DEPROVISION_LRO_KIND,
    row,
    account_id,
    input: { id: row.id, account_id },
    dedupe_key: `${HOST_FORCE_DEPROVISION_LRO_KIND}:${row.id}`,
  });
}

export async function forceDeprovisionHostInternal({
  account_id,
  id,
}: {
  account_id?: string;
  id: string;
}): Promise<void> {
  const row = await loadOwnedHost(id, account_id);
  const machineCloud = normalizeProviderId(row.metadata?.machine?.cloud);
  if (machineCloud !== "self-host") {
    throw new Error("force deprovision is only supported for self-hosted VMs");
  }
  await markHostDeprovisioned(row, "force_deprovision");
}

export async function removeSelfHostConnector({
  account_id,
  id,
}: {
  account_id?: string;
  id: string;
}): Promise<HostLroResponse> {
  const row = await loadOwnedHost(id, account_id);
  const machineCloud = normalizeProviderId(row.metadata?.machine?.cloud);
  if (machineCloud !== "self-host") {
    throw new Error("host is not self-hosted");
  }
  return await createHostLro({
    kind: HOST_REMOVE_CONNECTOR_LRO_KIND,
    row,
    account_id,
    input: { id: row.id, account_id },
    dedupe_key: `${HOST_REMOVE_CONNECTOR_LRO_KIND}:${row.id}`,
  });
}

export async function removeSelfHostConnectorInternal({
  account_id,
  id,
}: {
  account_id?: string;
  id: string;
}): Promise<void> {
  const row = await loadOwnedHost(id, account_id);
  const machineCloud = normalizeProviderId(row.metadata?.machine?.cloud);
  if (machineCloud !== "self-host") {
    throw new Error("host is not self-hosted");
  }
  await markHostDeprovisioned(row, "remove_connector");
  const connectorId =
    row.region ??
    row.metadata?.machine?.metadata?.connector_id ??
    row.metadata?.machine?.metadata?.connectorId;
  if (typeof connectorId === "string" && connectorId) {
    await revokeConnector({
      connector_id: connectorId,
      account_id,
    });
  }
}

export async function renameHost({
  account_id,
  id,
  name,
}: {
  account_id?: string;
  id: string;
  name: string;
}): Promise<Host> {
  const row = await loadOwnedHost(id, account_id);
  const cleaned = name?.trim();
  if (!cleaned) {
    throw new Error("name must be provided");
  }
  await pool().query(
    `UPDATE project_hosts SET name=$2, updated=NOW() WHERE id=$1 AND deleted IS NULL`,
    [id, cleaned],
  );
  const { rows } = await pool().query(
    `SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL`,
    [id],
  );
  if (!rows[0]) throw new Error("host not found");
  await logCloudVmEvent({
    vm_id: id,
    action: "rename",
    status: "success",
    provider: normalizeProviderId(row?.metadata?.machine?.cloud),
    spec: { before: { name: row?.name ?? null }, after: { name: cleaned } },
  });
  return parseRow(rows[0]);
}

export async function setHostStar({
  account_id,
  id,
  starred,
}: {
  account_id?: string;
  id: string;
  starred: boolean;
}): Promise<void> {
  const owner = requireAccount(account_id);
  const { rows } = await pool().query(
    `SELECT id, metadata, tier, deleted, starred_by
     FROM project_hosts
     WHERE id=$1`,
    [id],
  );
  const row = rows[0];
  if (!row || row.deleted) {
    throw new Error("host not found");
  }
  const metadata = row.metadata ?? {};
  const rowOwner = metadata.owner ?? "";
  const collaborators = (metadata.collaborators ?? []) as string[];
  const isOwner = rowOwner === owner;
  const isCollab = collaborators.includes(owner);
  const shared = row.tier != null;
  const isAdminUser = await isAdmin(owner);
  if (!isOwner && !isCollab && !shared && !isAdminUser) {
    throw new Error("not authorized");
  }
  const current = (row.starred_by ?? []) as string[];
  const next = new Set(current);
  if (starred) {
    next.add(owner);
  } else {
    next.delete(owner);
  }
  await pool().query(
    `UPDATE project_hosts
     SET starred_by=$2, updated=NOW()
     WHERE id=$1`,
    [id, [...next]],
  );
}

export async function updateHostMachine({
  account_id,
  id,
  cloud,
  cpu,
  ram_gb,
  disk_gb,
  disk_type,
  machine_type,
  gpu_type,
  gpu_count,
  storage_mode,
  region,
  zone,
  self_host_ssh_target,
  auto_grow_enabled,
  auto_grow_max_disk_gb,
  auto_grow_growth_step_gb,
  auto_grow_min_grow_interval_minutes,
  pricing_model,
  interruption_restore_policy,
}: {
  account_id?: string;
  id: string;
  cloud?: HostMachine["cloud"];
  cpu?: number;
  ram_gb?: number;
  disk_gb?: number;
  disk_type?: HostMachine["disk_type"];
  machine_type?: HostMachine["machine_type"];
  gpu_type?: HostMachine["gpu_type"];
  gpu_count?: number;
  storage_mode?: HostMachine["storage_mode"];
  region?: string;
  zone?: string;
  self_host_ssh_target?: string;
  auto_grow_enabled?: boolean;
  auto_grow_max_disk_gb?: number;
  auto_grow_growth_step_gb?: number;
  auto_grow_min_grow_interval_minutes?: number;
  pricing_model?: HostPricingModel;
  interruption_restore_policy?: HostInterruptionRestorePolicy;
}): Promise<Host> {
  const row = await loadOwnedHost(id, account_id);
  const metadata = row.metadata ?? {};
  const machine: HostMachine = metadata.machine ?? {};
  const machineCloud = normalizeProviderId(machine.cloud);
  const isSelfHost = machineCloud === "self-host";
  const isDeprovisioned = row.status === "deprovisioned";
  let nextMachine: HostMachine = {
    ...machine,
    metadata: { ...(machine.metadata ?? {}) },
  };
  let changed = false;
  let nonDiskChange = false;
  let regionChanged = false;
  let zoneChanged = false;
  let storageModeChanged = false;
  let diskTypeChanged = false;
  let machineChanged = false;
  let nextRegion = row.region ?? "";
  const requestedCloudRaw = typeof cloud === "string" ? cloud : undefined;
  const requestedCloud = normalizeProviderId(requestedCloudRaw);
  const cloudChanged =
    requestedCloudRaw !== undefined && requestedCloud !== machineCloud;
  const buildConfigSpec = (
    specMachine: HostMachine,
    regionValue: string | null | undefined,
  ) => ({
    cloud: normalizeProviderId(specMachine.cloud) ?? specMachine.cloud ?? null,
    name: row.name ?? null,
    region: regionValue ?? null,
    zone: specMachine.zone ?? null,
    machine_type: specMachine.machine_type ?? null,
    gpu_type: specMachine.gpu_type ?? null,
    gpu_count: specMachine.gpu_count ?? null,
    cpu: specMachine.metadata?.cpu ?? null,
    ram_gb: specMachine.metadata?.ram_gb ?? null,
    disk_gb: specMachine.disk_gb ?? null,
    disk_type: specMachine.disk_type ?? null,
    storage_mode: specMachine.storage_mode ?? null,
    auto_grow: specMachine.metadata?.auto_grow ?? null,
    pricing_model:
      normalizeHostPricingModel(metadata.pricing_model) ?? "on_demand",
    interruption_restore_policy:
      normalizeHostInterruptionRestorePolicy(
        metadata.interruption_restore_policy,
      ) ??
      defaultInterruptionRestorePolicy(
        normalizeHostPricingModel(metadata.pricing_model),
      ),
  });
  const beforeSpec = buildConfigSpec(machine, row.region);

  const parsePositiveInt = (value: unknown, label: string) => {
    if (value == null) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`${label} must be a positive number`);
    }
    return Math.floor(parsed);
  };
  const parseBooleanLike = (value: unknown, label: string) => {
    if (value == null) return undefined;
    if (typeof value === "boolean") return value;
    if (value === 1 || value === "1" || value === "true") return true;
    if (value === 0 || value === "0" || value === "false") return false;
    throw new Error(`${label} must be a boolean`);
  };

  const nextCpu = parsePositiveInt(cpu, "cpu");
  const nextRam = parsePositiveInt(ram_gb, "ram_gb");
  const nextDisk = parsePositiveInt(disk_gb, "disk_gb");
  const nextGpuCount = parsePositiveInt(gpu_count, "gpu_count");
  const nextAutoGrowEnabled = parseBooleanLike(
    auto_grow_enabled,
    "auto_grow_enabled",
  );
  const nextAutoGrowMaxDisk = parsePositiveInt(
    auto_grow_max_disk_gb,
    "auto_grow_max_disk_gb",
  );
  const nextAutoGrowGrowthStep = parsePositiveInt(
    auto_grow_growth_step_gb,
    "auto_grow_growth_step_gb",
  );
  const nextAutoGrowMinInterval = parsePositiveInt(
    auto_grow_min_grow_interval_minutes,
    "auto_grow_min_grow_interval_minutes",
  );
  const currentPricingModel =
    normalizeHostPricingModel(metadata.pricing_model) ?? "on_demand";
  const requestedPricingModel = normalizeHostPricingModel(pricing_model);
  if (pricing_model != null && !requestedPricingModel) {
    throw new Error(`invalid pricing_model '${pricing_model}'`);
  }
  const nextPricingModel = requestedPricingModel ?? currentPricingModel;
  const currentInterruptionRestorePolicy =
    normalizeHostInterruptionRestorePolicy(
      metadata.interruption_restore_policy,
    ) ?? defaultInterruptionRestorePolicy(currentPricingModel);
  const requestedInterruptionRestorePolicy =
    normalizeHostInterruptionRestorePolicy(interruption_restore_policy);
  if (
    interruption_restore_policy != null &&
    !requestedInterruptionRestorePolicy
  ) {
    throw new Error(
      `invalid interruption_restore_policy '${interruption_restore_policy}'`,
    );
  }
  const nextInterruptionRestorePolicy =
    requestedInterruptionRestorePolicy ??
    (requestedPricingModel
      ? defaultInterruptionRestorePolicy(nextPricingModel)
      : currentInterruptionRestorePolicy);

  if (cloudChanged) {
    if (!isDeprovisioned) {
      throw new Error("provider can only be changed when deprovisioned");
    }
    nextMachine = {
      cloud: requestedCloud,
      metadata: {},
    };
    changed = true;
    nonDiskChange = true;
    machineChanged = true;
    storageModeChanged = true;
    diskTypeChanged = true;
  }

  if (nextCpu != null && nextCpu !== machine.metadata?.cpu) {
    nextMachine.metadata = { ...(nextMachine.metadata ?? {}), cpu: nextCpu };
    changed = true;
    nonDiskChange = true;
  }
  if (nextRam != null && nextRam !== machine.metadata?.ram_gb) {
    nextMachine.metadata = { ...(nextMachine.metadata ?? {}), ram_gb: nextRam };
    changed = true;
    nonDiskChange = true;
  }
  if (isSelfHost && typeof self_host_ssh_target === "string") {
    const nextTarget = self_host_ssh_target.trim();
    const currentTarget = String(machine.metadata?.self_host_ssh_target ?? "");
    if (nextTarget !== currentTarget) {
      nextMachine.metadata = {
        ...(nextMachine.metadata ?? {}),
        self_host_ssh_target: nextTarget || undefined,
      };
      changed = true;
      nonDiskChange = true;
    }
  }
  if (nextDisk != null) {
    const currentDisk = Number(machine.disk_gb);
    if (
      !isDeprovisioned &&
      Number.isFinite(currentDisk) &&
      currentDisk > 0 &&
      nextDisk < currentDisk
    ) {
      throw new Error("disk size can only increase");
    }
    if (nextDisk !== nextMachine.disk_gb) {
      nextMachine.disk_gb = nextDisk;
      changed = true;
    }
  }
  if (
    typeof machine_type === "string" &&
    machine_type !== nextMachine.machine_type
  ) {
    nextMachine.machine_type = machine_type || undefined;
    changed = true;
    nonDiskChange = true;
    machineChanged = true;
  }
  if (typeof gpu_type === "string" && gpu_type !== nextMachine.gpu_type) {
    if (gpu_type === "none") {
      nextMachine.gpu_type = undefined;
      nextMachine.gpu_count = 0;
    } else {
      nextMachine.gpu_type = gpu_type || undefined;
    }
    changed = true;
    nonDiskChange = true;
    machineChanged = true;
  }
  if (nextGpuCount != null && nextGpuCount !== nextMachine.gpu_count) {
    nextMachine.gpu_count = nextGpuCount;
    changed = true;
    nonDiskChange = true;
    machineChanged = true;
  }
  if (
    typeof storage_mode === "string" &&
    storage_mode !== nextMachine.storage_mode
  ) {
    nextMachine.storage_mode = storage_mode;
    changed = true;
    nonDiskChange = true;
    storageModeChanged = true;
  }
  if (typeof disk_type === "string" && disk_type !== nextMachine.disk_type) {
    nextMachine.disk_type = disk_type;
    changed = true;
    nonDiskChange = true;
    diskTypeChanged = true;
  }
  if (typeof zone === "string" && zone && zone !== nextMachine.zone) {
    nextMachine.zone = zone;
    changed = true;
    nonDiskChange = true;
    zoneChanged = true;
  }
  if (typeof region === "string" && region && region !== row.region) {
    nextRegion = region;
    changed = true;
    nonDiskChange = true;
    regionChanged = true;
  }
  const currentAutoGrow = {
    ...((machine.metadata?.auto_grow ?? {}) as Record<string, any>),
  };
  const nextAutoGrow = {
    ...((nextMachine.metadata?.auto_grow ?? {}) as Record<string, any>),
  };
  let autoGrowChanged = false;
  if (
    nextAutoGrowEnabled !== undefined &&
    nextAutoGrowEnabled !== currentAutoGrow.enabled
  ) {
    nextAutoGrow.enabled = nextAutoGrowEnabled;
    autoGrowChanged = true;
  }
  if (
    nextAutoGrowMaxDisk != null &&
    nextAutoGrowMaxDisk !== currentAutoGrow.max_disk_gb
  ) {
    nextAutoGrow.max_disk_gb = nextAutoGrowMaxDisk;
    autoGrowChanged = true;
  }
  if (
    nextAutoGrowGrowthStep != null &&
    nextAutoGrowGrowthStep !== currentAutoGrow.growth_step_gb
  ) {
    nextAutoGrow.growth_step_gb = nextAutoGrowGrowthStep;
    autoGrowChanged = true;
  }
  if (
    nextAutoGrowMinInterval != null &&
    nextAutoGrowMinInterval !== currentAutoGrow.min_grow_interval_minutes
  ) {
    nextAutoGrow.min_grow_interval_minutes = nextAutoGrowMinInterval;
    autoGrowChanged = true;
  }
  if (autoGrowChanged) {
    const effectiveDisk = nextDisk ?? nextMachine.disk_gb;
    if (
      nextAutoGrow.max_disk_gb != null &&
      effectiveDisk != null &&
      nextAutoGrow.max_disk_gb < effectiveDisk
    ) {
      throw new Error(
        "auto-grow max disk must be at least the configured disk",
      );
    }
    nextMachine.metadata = {
      ...(nextMachine.metadata ?? {}),
      auto_grow: nextAutoGrow,
    };
    changed = true;
  }

  if (nextPricingModel !== currentPricingModel) {
    metadata.pricing_model = nextPricingModel;
    changed = true;
  }
  if (nextInterruptionRestorePolicy !== currentInterruptionRestorePolicy) {
    metadata.interruption_restore_policy = nextInterruptionRestorePolicy;
    changed = true;
  }

  if (!changed) {
    return parseRow(row);
  }

  normalizeMachineGpuInPlace(nextMachine);

  if (isDeprovisioned) {
    const nextMetadata = { ...metadata, machine: nextMachine };
    if (machine_type) {
      nextMetadata.size = machine_type;
    }
    nextMetadata.gpu = machineHasGpu(nextMachine);
    delete nextMetadata.reprovision_required;
    await pool().query(
      `UPDATE project_hosts SET region=$2, metadata=$3, updated=NOW() WHERE id=$1 AND deleted IS NULL`,
      [row.id, nextRegion, nextMetadata],
    );
    const { rows } = await pool().query(
      `SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL`,
      [row.id],
    );
    if (!rows[0]) throw new Error("host not found");
    await logCloudVmEvent({
      vm_id: row.id,
      action: "update_config",
      status: "success",
      provider: normalizeProviderId(nextMachine.cloud),
      spec: {
        before: beforeSpec,
        after: buildConfigSpec(nextMachine, nextRegion),
      },
    });
    return parseRow(rows[0]);
  }

  if (!isDeprovisioned && (regionChanged || zoneChanged)) {
    throw new Error("region/zone can only be changed when deprovisioned");
  }

  if (!isDeprovisioned && (storageModeChanged || diskTypeChanged)) {
    throw new Error("disk type/storage mode changes require deprovisioning");
  }

  const canEditErroredReprovision =
    row.status === "error" && !!metadata.reprovision_required;
  const requiresReprovision =
    !isSelfHost &&
    nonDiskChange &&
    (row.status === "off" || canEditErroredReprovision);

  if (
    !isSelfHost &&
    nonDiskChange &&
    row.status !== "off" &&
    !canEditErroredReprovision
  ) {
    throw new Error(
      "host must be stopped before changing CPU/RAM/machine type",
    );
  }

  if (
    !isSelfHost &&
    nextDisk == null &&
    !requiresReprovision &&
    !autoGrowChanged
  ) {
    return parseRow(row);
  }

  let resizeWarning: string | undefined;
  let runtime = metadata.runtime ?? {};
  if (!runtime.instance_id && machineCloud === "gcp") {
    const zone = runtime.zone ?? nextMachine.zone ?? machine.zone ?? undefined;
    if (zone) {
      const prefix = getProviderPrefix(machineCloud, await getServerSettings());
      const provider = getServerProvider(machineCloud);
      const normalizeName = provider?.normalizeName ?? gcpSafeName;
      const baseName = row.id.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
      runtime = {
        ...runtime,
        instance_id: normalizeName(prefix, baseName),
        zone,
      };
    }
  }
  const instanceName =
    runtime.metadata?.instance_name ?? runtime.instance_id ?? undefined;
  if (isSelfHost) {
    const connectorId =
      row.region ??
      machine.metadata?.connector_id ??
      machine.metadata?.connectorId ??
      undefined;
    if (connectorId && instanceName) {
      const payload: Record<string, any> = {
        host_id: row.id,
        name: instanceName,
      };
      if (nextCpu != null) payload.cpus = nextCpu;
      if (nextRam != null) payload.mem_gb = nextRam;
      if (nextDisk != null) payload.disk_gb = nextDisk;
      await sendSelfHostCommand({
        connector_id: connectorId,
        action: "resize",
        payload,
        timeoutMs: SELF_HOST_RESIZE_TIMEOUT_MS,
      });
    }
  } else if (machineCloud && nextDisk != null) {
    const provider = getServerProvider(machineCloud);
    if (!provider?.entry.capabilities.supportsDiskResize) {
      throw new Error("disk resize is not supported for this provider");
    }
    const diskResizeRequiresStop = (
      provider.entry.capabilities as { diskResizeRequiresStop?: boolean }
    ).diskResizeRequiresStop;
    if (nextMachine.storage_mode === "ephemeral") {
      throw new Error("disk resize is only available for persistent storage");
    }
    if (diskResizeRequiresStop && row.status !== "off") {
      throw new Error("disk resize requires the host to be stopped");
    }
    if (!runtime.instance_id) {
      throw new Error("host is not provisioned");
    }
    const { entry, creds } = await getProviderContext(machineCloud, {
      region: row.region,
    });
    await entry.provider.resizeDisk(runtime, nextDisk, creds);
    if (row.status !== "off") {
      const client = await hostControlClient(row.id);
      try {
        await client.growBtrfs({ disk_gb: nextDisk });
      } catch (err) {
        resizeWarning =
          "disk resized in cloud, but filesystem resize failed; reboot or run /usr/local/sbin/cocalc-grow-btrfs";
        console.warn("growBtrfs failed after disk resize", err);
      }
    }
  }

  const nextMetadata = {
    ...metadata,
    machine: nextMachine,
    ...(requiresReprovision ? { reprovision_required: true } : {}),
    ...(machineChanged ? { gpu: machineHasGpu(nextMachine) } : {}),
    ...(resizeWarning
      ? {
          last_action: "resize_disk",
          last_action_status: `warning: ${resizeWarning}`,
          last_action_error: resizeWarning,
          last_action_at: new Date().toISOString(),
        }
      : {}),
  };
  if (machineChanged && nextMachine.machine_type) {
    nextMetadata.size = nextMachine.machine_type;
  }
  await pool().query(
    `UPDATE project_hosts SET region=$2, metadata=$3, updated=NOW() WHERE id=$1 AND deleted IS NULL`,
    [row.id, nextRegion, nextMetadata],
  );
  const { rows } = await pool().query(
    `SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL`,
    [row.id],
  );
  if (!rows[0]) throw new Error("host not found");
  await logCloudVmEvent({
    vm_id: row.id,
    action: "update_config",
    status: "success",
    provider: normalizeProviderId(nextMachine.cloud),
    spec: {
      before: beforeSpec,
      after: buildConfigSpec(nextMachine, nextRegion),
    },
  });
  return parseRow(rows[0]);
}

export async function upgradeHostSoftware({
  account_id,
  id,
  targets,
  base_url,
}: {
  account_id?: string;
  id: string;
  targets: HostSoftwareUpgradeTarget[];
  base_url?: string;
}): Promise<HostLroResponse> {
  assertProjectHostUpgradeIsExclusive(targets);
  const row = await loadHostForStartStop(id, account_id);
  assertHostRunningForUpgrade(row);
  return await createHostLro({
    kind: HOST_UPGRADE_LRO_KIND,
    row,
    account_id,
    input: { id: row.id, account_id, targets, base_url },
    dedupe_key: hostUpgradeDedupeKey({
      hostId: row.id,
      targets,
      baseUrl: base_url,
    }),
  });
}

export async function reconcileHostSoftware({
  account_id,
  id,
}: {
  account_id?: string;
  id: string;
}): Promise<HostLroResponse> {
  const row = await loadHostForStartStop(id, account_id);
  assertHostRunningForUpgrade(row);
  assertCloudHostBootstrapReconcileSupported(row);
  return await createHostLro({
    kind: HOST_RECONCILE_LRO_KIND,
    row,
    account_id,
    input: { id: row.id, account_id },
    dedupe_key: `${HOST_RECONCILE_LRO_KIND}:${row.id}`,
  });
}

export async function listHostRuntimeDeployments({
  account_id,
  scope_type,
  id,
}: {
  account_id?: string;
  scope_type: HostRuntimeDeploymentScopeType;
  id?: string;
}): Promise<HostRuntimeDeploymentRecord[]> {
  if (scope_type === "global") {
    await assertRuntimeDeploymentGlobalAccess(account_id);
    return await listProjectHostRuntimeDeployments({ scope_type: "global" });
  }
  const row = await loadHostForRootfsManagement(id ?? "", account_id);
  return await listProjectHostRuntimeDeployments({
    scope_type: "host",
    host_id: row.id,
  });
}

async function getHostRuntimeDeploymentStatusInternal({
  id,
  row,
}: {
  id: string;
  row: any;
}): Promise<HostRuntimeDeploymentStatus> {
  const [configured, effective] = await Promise.all([
    listProjectHostRuntimeDeployments({
      scope_type: "host",
      host_id: row.id,
    }),
    loadEffectiveProjectHostRuntimeDeployments({ host_id: row.id }),
  ]);
  let observed_artifacts = observedRuntimeArtifactsFromMetadata(row);
  let observed_components: HostManagedComponentStatus[] | undefined;
  const observation_errors: string[] = [];
  if (HOST_RUNNING_STATUSES.has(`${row?.status ?? ""}`.toLowerCase())) {
    try {
      const client = await hostControlClient(id, 15_000);
      const [componentsResult, artifactsResult] = await Promise.allSettled([
        client.getManagedComponentStatus(),
        client.getInstalledRuntimeArtifacts(),
      ]);
      if (componentsResult.status === "fulfilled") {
        observed_components = componentsResult.value;
      } else {
        observation_errors.push(
          `components: ${componentsResult.reason?.message ?? componentsResult.reason}`,
        );
      }
      if (artifactsResult.status === "fulfilled") {
        observed_artifacts = observedRuntimeArtifactsFromMetadata({
          metadata: {
            software_inventory: artifactsResult.value,
            software: row?.metadata?.software,
          },
        });
      } else if (observed_artifacts.length === 0) {
        observation_errors.push(
          `artifacts: ${artifactsResult.reason?.message ?? artifactsResult.reason}`,
        );
      }
    } catch (err) {
      observation_errors.push(`${(err as Error)?.message ?? err}`);
    }
  } else {
    observation_errors.push("host is not currently running");
  }
  return {
    host_id: row.id,
    configured,
    effective,
    observed_artifacts,
    observed_components,
    observed_targets: summarizeObservedRuntimeDeployments({
      effective,
      observed_artifacts,
      observed_components,
    }),
    rollback_targets: summarizeRollbackTargets({
      row,
      effective,
      observed_artifacts,
      observed_components,
    }),
    observation_error: observation_errors.join("; ") || undefined,
  };
}

export async function getHostRuntimeDeploymentStatus({
  account_id,
  id,
}: {
  account_id?: string;
  id: string;
}): Promise<HostRuntimeDeploymentStatus> {
  const row = await loadHostForListing(id, account_id);
  return await getHostRuntimeDeploymentStatusInternal({ id, row });
}

export async function setHostRuntimeDeployments({
  account_id,
  scope_type,
  id,
  deployments,
  replace,
}: {
  account_id?: string;
  scope_type: HostRuntimeDeploymentScopeType;
  id?: string;
  deployments: HostRuntimeDeploymentUpsert[];
  replace?: boolean;
}): Promise<HostRuntimeDeploymentRecord[]> {
  const normalized = normalizeRuntimeDeploymentUpserts(deployments);
  if (scope_type === "global") {
    const requested_by = await assertRuntimeDeploymentGlobalAccess(account_id);
    const result = await setProjectHostRuntimeDeployments({
      scope_type: "global",
      deployments: normalized,
      requested_by,
      replace,
    });
    const runningHostIds =
      await listRunningHostIdsForAutomaticRuntimeDeploymentReconcile();
    await bestEffortQueueAutomaticArtifactDeploymentReconcileForHosts({
      host_ids: runningHostIds,
    });
    await bestEffortQueueAutomaticRuntimeDeploymentReconcileForHosts({
      host_ids: runningHostIds,
      reason: AUTOMATIC_RUNTIME_DEPLOYMENT_RECONCILE_REASON,
    });
    return result;
  }
  const row = await loadHostForRootfsManagement(id ?? "", account_id);
  const result = await setProjectHostRuntimeDeployments({
    scope_type: "host",
    host_id: row.id,
    deployments: normalized,
    requested_by: requestedByForRuntimeDeployments({ account_id, row }),
    replace,
  });
  await bestEffortQueueAutomaticArtifactDeploymentReconcileForHosts({
    host_ids: [row.id],
  });
  await bestEffortQueueAutomaticRuntimeDeploymentReconcileForHosts({
    host_ids: [row.id],
    reason: AUTOMATIC_RUNTIME_DEPLOYMENT_RECONCILE_REASON,
  });
  return result;
}

export async function reconcileHostRuntimeDeployments({
  account_id,
  id,
  components,
  reason,
}: {
  account_id?: string;
  id: string;
  components?: ManagedComponentKind[];
  reason?: string;
}): Promise<HostLroResponse> {
  const row = await loadHostForStartStop(id, account_id);
  assertHostRunningForUpgrade(row);
  return await createHostLro({
    kind: HOST_RECONCILE_RUNTIME_DEPLOYMENTS_LRO_KIND,
    row,
    account_id,
    input: { id: row.id, account_id, components, reason },
    dedupe_key: `${HOST_RECONCILE_RUNTIME_DEPLOYMENTS_LRO_KIND}:${row.id}:${JSON.stringify(
      {
        components: normalizeManagedComponentKindsForDedupe(components ?? []),
        reason: `${reason ?? ""}`.trim() || null,
      },
    )}`,
  });
}

export async function ensureAutomaticHostRuntimeDeploymentsReconcile({
  host_id,
  reason,
}: {
  host_id: string;
  reason?: string;
}): Promise<
  | {
      queued: false;
      host_id: string;
      reason:
        | "host_missing"
        | "host_not_running"
        | "no_reconcile_needed"
        | "observation_failed";
      observation_error?: string;
    }
  | {
      queued: true;
      host_id: string;
      components: ManagedComponentKind[];
      op_id: string;
    }
> {
  const row = await loadHostRowForRuntimeDeploymentsInternal(host_id);
  if (!row) {
    return { queued: false, host_id, reason: "host_missing" };
  }
  if (!HOST_RUNNING_STATUSES.has(`${row?.status ?? ""}`.toLowerCase())) {
    return { queued: false, host_id: row.id, reason: "host_not_running" };
  }
  const status = await getHostRuntimeDeploymentStatusInternal({
    id: row.id,
    row,
  });
  if (status.observation_error && !(status.observed_components ?? []).length) {
    return {
      queued: false,
      host_id: row.id,
      reason: "observation_failed",
      observation_error: status.observation_error,
    };
  }
  const plan = computeHostRuntimeDeploymentReconcilePlan({
    row,
    status,
  });
  if (!plan.reconciled_components.length) {
    return { queued: false, host_id: row.id, reason: "no_reconcile_needed" };
  }
  const op = await createHostLro({
    kind: HOST_RECONCILE_RUNTIME_DEPLOYMENTS_LRO_KIND,
    row,
    input: {
      id: row.id,
      components: plan.reconciled_components,
      reason: reason ?? AUTOMATIC_RUNTIME_DEPLOYMENT_RECONCILE_REASON,
    },
    dedupe_key: `${HOST_RECONCILE_RUNTIME_DEPLOYMENTS_LRO_KIND}:${row.id}:${JSON.stringify(
      {
        components: normalizeManagedComponentKindsForDedupe(
          plan.reconciled_components,
        ),
        reason:
          `${reason ?? AUTOMATIC_RUNTIME_DEPLOYMENT_RECONCILE_REASON}`.trim() ||
          null,
      },
    )}`,
  });
  return {
    queued: true,
    host_id: row.id,
    components: plan.reconciled_components,
    op_id: op.op_id,
  };
}

function computeAutomaticArtifactUpgradeTargets({
  status,
}: {
  status: HostRuntimeDeploymentStatus;
}): HostSoftwareUpgradeTarget[] {
  const observedTargets = new Map(
    (status.observed_targets ?? [])
      .filter((target) => target.target_type === "artifact")
      .map((target) => [target.target as HostRuntimeArtifact, target]),
  );
  const targets: HostSoftwareUpgradeTarget[] = [];
  for (const deployment of status.effective ?? []) {
    if (deployment.target_type !== "artifact") continue;
    const target = deployment.target as HostRuntimeArtifact;
    if (target === "project-host" || target === "bootstrap-environment") {
      continue;
    }
    const observed = observedTargets.get(target);
    const observedState = observed?.observed_version_state;
    if (observedState === "aligned" || observedState === "unsupported") {
      continue;
    }
    targets.push({
      artifact: target,
      version: deployment.desired_version,
    });
  }
  return targets;
}

export async function ensureAutomaticHostArtifactDeploymentsReconcile({
  host_id,
}: {
  host_id: string;
}): Promise<
  | {
      queued: false;
      host_id: string;
      reason:
        | "host_missing"
        | "host_not_running"
        | "no_reconcile_needed"
        | "observation_failed";
      observation_error?: string;
    }
  | {
      queued: true;
      host_id: string;
      targets: HostSoftwareUpgradeTarget[];
      op_id: string;
    }
> {
  const row = await loadHostRowForRuntimeDeploymentsInternal(host_id);
  if (!row) {
    return { queued: false, host_id, reason: "host_missing" };
  }
  if (!HOST_RUNNING_STATUSES.has(`${row?.status ?? ""}`.toLowerCase())) {
    return { queued: false, host_id: row.id, reason: "host_not_running" };
  }
  const status = await getHostRuntimeDeploymentStatusInternal({
    id: row.id,
    row,
  });
  if (status.observation_error && !(status.observed_artifacts ?? []).length) {
    return {
      queued: false,
      host_id: row.id,
      reason: "observation_failed",
      observation_error: status.observation_error,
    };
  }
  const targets = computeAutomaticArtifactUpgradeTargets({ status });
  if (!targets.length) {
    return { queued: false, host_id: row.id, reason: "no_reconcile_needed" };
  }
  const op = await createHostLro({
    kind: HOST_UPGRADE_LRO_KIND,
    row,
    input: {
      id: row.id,
      targets,
    },
    dedupe_key: hostUpgradeDedupeKey({
      hostId: row.id,
      targets,
    }),
  });
  return {
    queued: true,
    host_id: row.id,
    targets,
    op_id: op.op_id,
  };
}

async function listRunningHostIdsForAutomaticRuntimeDeploymentReconcile(): Promise<
  string[]
> {
  const { rows } = await pool().query<{ id: string }>(
    `SELECT id
     FROM project_hosts
     WHERE deleted IS NULL
       AND LOWER(COALESCE(status, '')) = ANY($1::text[])`,
    [[...HOST_RUNNING_STATUSES]],
  );
  return rows
    .map((row) => `${row?.id ?? ""}`.trim())
    .filter((id) => id.length > 0);
}

async function bestEffortQueueAutomaticRuntimeDeploymentReconcileForHosts({
  host_ids,
  reason,
}: {
  host_ids: string[];
  reason?: string;
}): Promise<void> {
  const uniqueHostIds = Array.from(
    new Set(
      (host_ids ?? [])
        .map((host_id) => `${host_id ?? ""}`.trim())
        .filter((host_id) => host_id.length > 0),
    ),
  );
  if (!uniqueHostIds.length) return;
  const settled = await Promise.allSettled(
    uniqueHostIds.map((host_id) =>
      ensureAutomaticHostRuntimeDeploymentsReconcile({ host_id, reason }),
    ),
  );
  settled.forEach((result, index) => {
    if (result.status === "rejected") {
      logger.warn("automatic runtime deployment reconcile enqueue failed", {
        host_id: uniqueHostIds[index],
        reason: `${result.reason}`,
      });
    }
  });
}

async function bestEffortQueueAutomaticArtifactDeploymentReconcileForHosts({
  host_ids,
}: {
  host_ids: string[];
}): Promise<void> {
  const uniqueHostIds = Array.from(
    new Set(
      (host_ids ?? [])
        .map((host_id) => `${host_id ?? ""}`.trim())
        .filter((host_id) => host_id.length > 0),
    ),
  );
  if (!uniqueHostIds.length) return;
  const settled = await Promise.allSettled(
    uniqueHostIds.map((host_id) =>
      ensureAutomaticHostArtifactDeploymentsReconcile({ host_id }),
    ),
  );
  settled.forEach((result, index) => {
    if (result.status === "rejected") {
      logger.warn("automatic artifact deployment reconcile enqueue failed", {
        host_id: uniqueHostIds[index],
        reason: `${result.reason}`,
      });
    }
  });
}

export async function rollbackHostRuntimeDeployments({
  account_id,
  id,
  target_type,
  target,
  version,
  last_known_good,
  reason,
}: {
  account_id?: string;
  id: string;
  target_type: "component" | "artifact";
  target: HostRuntimeDeploymentTarget;
  version?: string;
  last_known_good?: boolean;
  reason?: string;
}): Promise<HostLroResponse> {
  const row = await loadHostForStartStop(id, account_id);
  assertHostRunningForUpgrade(row);
  const normalizedTarget =
    target_type === "component"
      ? normalizeManagedComponentKindsForDedupe([
          target as ManagedComponentKind,
        ])[0]
      : normalizeRuntimeArtifactTarget(target as HostRuntimeArtifact);
  if (!normalizedTarget) {
    throw new Error("invalid rollback target");
  }
  const rollbackVersion = `${version ?? ""}`.trim() || null;
  return await createHostLro({
    kind: HOST_ROLLBACK_RUNTIME_DEPLOYMENTS_LRO_KIND,
    row,
    account_id,
    input: {
      id: row.id,
      account_id,
      target_type,
      target: normalizedTarget,
      version: rollbackVersion,
      last_known_good: !!last_known_good,
      reason,
    },
    dedupe_key: `${HOST_ROLLBACK_RUNTIME_DEPLOYMENTS_LRO_KIND}:${row.id}:${JSON.stringify(
      {
        target_type,
        target: normalizedTarget,
        version: rollbackVersion,
        last_known_good: !!last_known_good,
        reason: `${reason ?? ""}`.trim() || null,
      },
    )}`,
  });
}

export async function getHostManagedComponentStatus({
  account_id,
  id,
}: {
  account_id?: string;
  id: string;
}): Promise<HostManagedComponentStatus[]> {
  const row = await loadHostForStartStop(id, account_id);
  assertHostRunningForUpgrade(row);
  const client = await hostControlClient(id, 30_000);
  return await client.getManagedComponentStatus();
}

export async function rolloutHostManagedComponents({
  account_id,
  id,
  components,
  reason,
}: {
  account_id?: string;
  id: string;
  components: ManagedComponentKind[];
  reason?: string;
}): Promise<HostLroResponse> {
  const row = await loadHostForStartStop(id, account_id);
  assertHostRunningForUpgrade(row);
  return await createHostLro({
    kind: HOST_ROLLOUT_MANAGED_COMPONENTS_LRO_KIND,
    row,
    account_id,
    input: { id: row.id, account_id, components, reason },
    dedupe_key: hostManagedComponentRolloutDedupeKey({
      hostId: row.id,
      components,
      reason,
    }),
  });
}

export async function upgradeHostConnector({
  account_id,
  id,
  version,
}: {
  account_id?: string;
  id: string;
  version?: string;
}): Promise<void> {
  const row = await loadHostForStartStop(id, account_id);
  const metadata = row.metadata ?? {};
  const machine = metadata.machine ?? {};
  if (machine.cloud !== "self-host") {
    throw new Error("host is not self-hosted");
  }
  const sshTarget = String(machine.metadata?.self_host_ssh_target ?? "").trim();
  if (!sshTarget) {
    throw new Error("missing self-host ssh target");
  }
  const owner = metadata.owner ?? account_id;
  if (!owner) {
    throw new Error("missing host owner");
  }
  const reversePort = await ensureSelfHostReverseTunnel({
    host_id: row.id,
    ssh_target: sshTarget,
  });
  const tokenInfo = await createPairingTokenForHost({
    account_id: owner,
    host_id: row.id,
    ttlMs: 30 * 60 * 1000,
  });
  const { project_hosts_self_host_connector_version } =
    await getServerSettings();
  const connectorVersion =
    version?.trim() ||
    project_hosts_self_host_connector_version?.trim() ||
    undefined;
  await runConnectorInstallOverSsh({
    host_id: row.id,
    ssh_target: sshTarget,
    pairing_token: tokenInfo.token,
    name: row.name ?? undefined,
    ssh_port: reversePort,
    version: connectorVersion,
  });
}

export async function reconcileHostSoftwareInternal({
  account_id,
  id,
}: {
  account_id?: string;
  id: string;
}): Promise<void> {
  const row = await loadHostForStartStop(id, account_id);
  assertHostRunningForUpgrade(row);
  assertCloudHostBootstrapReconcileSupported(row);
  await reconcileCloudHostBootstrapOverSsh({ host_id: id, row });
}

function assertHostRunningForUpgrade(row: any) {
  const status = String(row.status ?? "");
  if (status !== "active" && status !== "running") {
    throw new Error("host must be running to upgrade software");
  }
}

function deploymentObservedVersionState({
  desired_version,
  running_versions,
}: {
  desired_version: string;
  running_versions: string[];
}): HostRuntimeDeploymentObservedVersionState {
  if (!desired_version || running_versions.length === 0) {
    return "unknown";
  }
  if (running_versions.length > 1) {
    return "mixed";
  }
  return running_versions[0] === desired_version ? "aligned" : "drifted";
}

function componentDeploymentObservedVersionState({
  deployment,
  observed_component,
  observed_artifact,
}: {
  deployment: HostRuntimeDeploymentRecord;
  observed_component: HostManagedComponentStatus;
  observed_artifact?: HostRuntimeArtifactObservation;
}): HostRuntimeDeploymentObservedVersionState {
  const desiredArtifactVersion = `${deployment.desired_version ?? ""}`.trim();
  if (
    !desiredArtifactVersion ||
    observed_component.running_versions.length === 0
  ) {
    return "unknown";
  }
  const currentArtifactVersion =
    `${observed_artifact?.current_version ?? ""}`.trim();
  const currentArtifactBuildId =
    `${observed_artifact?.current_build_id ?? ""}`.trim();
  if (
    currentArtifactVersion &&
    currentArtifactVersion === desiredArtifactVersion &&
    currentArtifactBuildId
  ) {
    return deploymentObservedVersionState({
      desired_version: currentArtifactBuildId,
      running_versions: observed_component.running_versions,
    });
  }
  return deploymentObservedVersionState({
    desired_version: desiredArtifactVersion,
    running_versions: observed_component.running_versions,
  });
}

function sortVersionsDescending(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) =>
    a < b ? 1 : a > b ? -1 : 0,
  );
}

function observedRuntimeArtifactsFromMetadata(
  row: any,
): HostRuntimeArtifactObservation[] {
  const inventory = Array.isArray(row?.metadata?.software_inventory)
    ? row.metadata.software_inventory
    : [];
  const normalizedInventory = inventory
    .map((entry: any) => {
      const artifact = `${entry?.artifact ?? ""}`.trim() as HostRuntimeArtifact;
      if (
        artifact !== "project-host" &&
        artifact !== "project-bundle" &&
        artifact !== "tools"
      ) {
        return undefined;
      }
      return {
        artifact,
        current_version: `${entry?.current_version ?? ""}`.trim() || undefined,
        current_build_id:
          `${entry?.current_build_id ?? ""}`.trim() || undefined,
        installed_versions: sortVersionsDescending(
          Array.isArray(entry?.installed_versions)
            ? entry.installed_versions.map((value: any) =>
                `${value ?? ""}`.trim(),
              )
            : [],
        ),
        referenced_versions: Array.isArray(entry?.referenced_versions)
          ? entry.referenced_versions
              .map((reference: any) => {
                const version = `${reference?.version ?? ""}`.trim();
                const project_count = Math.max(
                  0,
                  Math.floor(Number(reference?.project_count ?? 0) || 0),
                );
                if (!version || project_count <= 0) return undefined;
                return {
                  version,
                  project_count,
                };
              })
              .filter(
                (
                  reference,
                ): reference is {
                  version: string;
                  project_count: number;
                } => reference != null,
              )
          : undefined,
      } satisfies HostRuntimeArtifactObservation;
    })
    .filter((entry): entry is HostRuntimeArtifactObservation => entry != null);
  const existing = new Map<HostRuntimeArtifact, HostRuntimeArtifactObservation>(
    normalizedInventory.map((entry) => [entry.artifact, entry]),
  );
  const software = row?.metadata?.software ?? {};
  const fallbacks: HostRuntimeArtifactObservation[] = [
    {
      artifact: "project-host",
      current_version: `${software?.project_host ?? ""}`.trim() || undefined,
      current_build_id:
        `${software?.project_host_build_id ?? ""}`.trim() || undefined,
      installed_versions: sortVersionsDescending(
        `${software?.project_host ?? ""}`.trim()
          ? [`${software.project_host}`.trim()]
          : [],
      ),
    },
    {
      artifact: "project-bundle",
      current_version: `${software?.project_bundle ?? ""}`.trim() || undefined,
      current_build_id:
        `${software?.project_bundle_build_id ?? ""}`.trim() || undefined,
      installed_versions: sortVersionsDescending(
        `${software?.project_bundle ?? ""}`.trim()
          ? [`${software.project_bundle}`.trim()]
          : [],
      ),
    },
    {
      artifact: "tools",
      current_version: `${software?.tools ?? ""}`.trim() || undefined,
      installed_versions: sortVersionsDescending(
        `${software?.tools ?? ""}`.trim() ? [`${software.tools}`.trim()] : [],
      ),
    },
  ];
  for (const fallback of fallbacks) {
    if (!existing.has(fallback.artifact)) {
      existing.set(fallback.artifact, fallback);
    }
  }
  return [...existing.values()].sort((a, b) =>
    a.artifact < b.artifact ? -1 : a.artifact > b.artifact ? 1 : 0,
  );
}

function observedRuntimeArtifactVersionState({
  desired_version,
  current_version,
  installed_versions,
}: {
  desired_version: string;
  current_version?: string;
  installed_versions: string[];
}): HostRuntimeDeploymentObservedVersionState {
  if (!desired_version) {
    return "unknown";
  }
  if (current_version && current_version === desired_version) {
    return "aligned";
  }
  if (installed_versions.includes(desired_version)) {
    return "drifted";
  }
  if (current_version || installed_versions.length > 0) {
    return "missing";
  }
  return "unobserved";
}

function deploymentArtifactForRollback({
  deployment,
  observed_components,
}: {
  deployment: HostRuntimeDeploymentRecord;
  observed_components?: HostManagedComponentStatus[];
}): HostRuntimeArtifact {
  if (deployment.target_type === "artifact") {
    return deployment.target as HostRuntimeArtifact;
  }
  const component = (observed_components ?? []).find(
    (entry) => entry.component === deployment.target,
  );
  return (component?.artifact ?? "project-host") as HostRuntimeArtifact;
}

function lastKnownGoodArtifactVersion(
  row: any,
  artifact: HostRuntimeArtifact,
): string | undefined {
  const runtimeDeployments =
    row?.metadata?.runtime_deployments?.last_known_good_versions ?? {};
  const legacy = row?.metadata?.last_known_good_versions ?? {};
  return (
    `${runtimeDeployments?.[artifact] ?? legacy?.[artifact] ?? ""}`.trim() ||
    undefined
  );
}

function summarizeRollbackTargets({
  row,
  effective,
  observed_artifacts,
  observed_components,
}: {
  row: any;
  effective: HostRuntimeDeploymentRecord[];
  observed_artifacts?: HostRuntimeArtifactObservation[];
  observed_components?: HostManagedComponentStatus[];
}): HostRuntimeRollbackTarget[] {
  const artifacts = new Map(
    (observed_artifacts ?? []).map((artifact) => [artifact.artifact, artifact]),
  );
  return effective.map((deployment) => {
    const artifact = deploymentArtifactForRollback({
      deployment,
      observed_components,
    });
    const observed = artifacts.get(artifact);
    const retained_versions = sortVersionsDescending(
      observed?.installed_versions ?? [],
    );
    const current_version = observed?.current_version;
    const previous_version = retained_versions.find(
      (version) => version !== current_version,
    );
    return {
      target_type: deployment.target_type,
      target: deployment.target,
      artifact,
      desired_version: deployment.desired_version,
      current_version,
      previous_version,
      last_known_good_version: lastKnownGoodArtifactVersion(row, artifact),
      retained_versions,
    };
  });
}

function resolveRollbackVersion({
  rollbackTarget,
  version,
  last_known_good,
}: {
  rollbackTarget: HostRuntimeRollbackTarget;
  version?: string;
  last_known_good?: boolean;
}): {
  rollback_version: string;
  rollback_source: HostRuntimeDeploymentRollbackResult["rollback_source"];
} {
  const explicit = `${version ?? ""}`.trim();
  if (explicit) {
    return {
      rollback_version: explicit,
      rollback_source: "explicit_version",
    };
  }
  if (last_known_good) {
    const candidate = `${rollbackTarget.last_known_good_version ?? ""}`.trim();
    if (!candidate) {
      throw new Error("last known good version is not available");
    }
    return {
      rollback_version: candidate,
      rollback_source: "last_known_good",
    };
  }
  const previous = `${rollbackTarget.previous_version ?? ""}`.trim();
  if (!previous) {
    throw new Error("previous rollback version is not available");
  }
  return {
    rollback_version: previous,
    rollback_source: "previous_version",
  };
}

function summarizeObservedRuntimeDeployments({
  effective,
  observed_artifacts,
  observed_components,
}: {
  effective: HostRuntimeDeploymentRecord[];
  observed_artifacts?: HostRuntimeArtifactObservation[];
  observed_components?: HostManagedComponentStatus[];
}): HostRuntimeDeploymentObservedTarget[] {
  const components = new Map(
    (observed_components ?? []).map((component) => [
      component.component,
      component,
    ]),
  );
  const artifacts = new Map(
    (observed_artifacts ?? []).map((artifact) => [artifact.artifact, artifact]),
  );
  return effective.map((deployment) => {
    if (deployment.target_type !== "component") {
      if (deployment.target === "bootstrap-environment") {
        return {
          target_type: deployment.target_type,
          target: deployment.target,
          desired_version: deployment.desired_version,
          rollout_policy: deployment.rollout_policy,
          observed_version_state: "unsupported",
        };
      }
      const observed = artifacts.get(deployment.target as HostRuntimeArtifact);
      if (!observed) {
        return {
          target_type: deployment.target_type,
          target: deployment.target,
          desired_version: deployment.desired_version,
          rollout_policy: deployment.rollout_policy,
          observed_version_state: "unobserved",
        };
      }
      return {
        target_type: deployment.target_type,
        target: deployment.target,
        desired_version: deployment.desired_version,
        rollout_policy: deployment.rollout_policy,
        observed_version_state: observedRuntimeArtifactVersionState({
          desired_version: deployment.desired_version,
          current_version: observed.current_version,
          installed_versions: observed.installed_versions,
        }),
        current_version: observed.current_version,
        current_build_id: observed.current_build_id,
        installed_versions: observed.installed_versions,
      };
    }
    const observed = components.get(deployment.target as ManagedComponentKind);
    if (!observed) {
      return {
        target_type: deployment.target_type,
        target: deployment.target,
        desired_version: deployment.desired_version,
        rollout_policy: deployment.rollout_policy,
        observed_version_state: "unobserved",
      };
    }
    const observedArtifact = artifacts.get(
      (observed.artifact ?? "project-host") as HostRuntimeArtifact,
    );
    return {
      target_type: deployment.target_type,
      target: deployment.target,
      desired_version: deployment.desired_version,
      rollout_policy: deployment.rollout_policy,
      observed_runtime_state: observed.runtime_state,
      observed_version_state: componentDeploymentObservedVersionState({
        deployment,
        observed_component: observed,
        observed_artifact: observedArtifact,
      }),
      running_versions: observed.running_versions,
      running_pids: observed.running_pids,
      enabled: observed.enabled,
      managed: observed.managed,
    };
  });
}

function installedProjectHostArtifactVersion(row: any): string | undefined {
  const version =
    `${row?.metadata?.software?.project_host ?? row?.version ?? ""}`.trim() ||
    undefined;
  return version;
}

async function setLastKnownGoodArtifactVersionInternal({
  host_id,
  row,
  artifact,
  version,
}: {
  host_id: string;
  row: any;
  artifact: HostRuntimeArtifact;
  version?: string;
}): Promise<void> {
  const normalizedVersion = `${version ?? ""}`.trim();
  if (!normalizedVersion) return;
  const metadata = { ...(row?.metadata ?? {}) };
  const runtimeDeployments = { ...(metadata.runtime_deployments ?? {}) };
  const lastKnownGoodVersions = {
    ...(runtimeDeployments.last_known_good_versions ?? {}),
  };
  if (lastKnownGoodVersions[artifact] === normalizedVersion) return;
  lastKnownGoodVersions[artifact] = normalizedVersion;
  runtimeDeployments.last_known_good_versions = lastKnownGoodVersions;
  metadata.runtime_deployments = runtimeDeployments;
  await pool().query(
    `UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1 AND deleted IS NULL`,
    [host_id, metadata],
  );
}

export async function rollbackProjectHostOverSshInternal({
  account_id,
  id,
  version,
  reason,
}: {
  account_id?: string;
  id: string;
  version: string;
  reason?: string;
}): Promise<{
  host_id: string;
  rollback_version: string;
}> {
  const row = await loadHostForStartStop(id, account_id);
  const rollbackVersion = `${version ?? ""}`.trim();
  if (!rollbackVersion) {
    throw new Error("rollback version is required");
  }
  const metadata = { ...(row?.metadata ?? {}) };
  const software = { ...(metadata.software ?? {}) } as Record<string, string>;
  software.project_host = rollbackVersion;
  delete software.project_host_build_id;
  metadata.software = software;
  const requested_by = requestedByForRuntimeDeployments({ account_id, row });
  await pool().query(
    `UPDATE project_hosts SET metadata=$2, version=$3, updated=NOW() WHERE id=$1 AND deleted IS NULL`,
    [row.id, metadata, rollbackVersion],
  );
  await setLastKnownGoodArtifactVersionInternal({
    host_id: row.id,
    row: {
      ...row,
      metadata,
    },
    artifact: "project-host",
    version: rollbackVersion,
  });
  await setProjectHostRuntimeDeployments({
    scope_type: "host",
    host_id: row.id,
    requested_by,
    replace: false,
    deployments: [
      {
        target_type: "artifact",
        target: "project-host",
        desired_version: rollbackVersion,
        rollout_reason: reason,
      },
      {
        target_type: "component",
        target: "project-host",
        desired_version: rollbackVersion,
        rollout_policy: DEFAULT_RUNTIME_DEPLOYMENT_POLICY["project-host"],
        rollout_reason: reason,
      },
    ],
  });
  await reconcileCloudHostBootstrapOverSsh({
    host_id: row.id,
    row: {
      ...row,
      version: rollbackVersion,
      metadata,
    },
  });
  return {
    host_id: row.id,
    rollback_version: rollbackVersion,
  };
}

function targetKeyForRuntimeDeployment(opts: {
  target_type: HostRuntimeDeploymentRecord["target_type"];
  target: HostRuntimeDeploymentRecord["target"];
}): string {
  return `${opts.target_type}:${opts.target}`;
}

function computeHostRuntimeDeploymentReconcilePlan({
  row,
  status,
  components,
}: {
  row: any;
  status: HostRuntimeDeploymentStatus;
  components?: ManagedComponentKind[];
}): Pick<
  HostRuntimeDeploymentReconcileResult,
  "requested_components" | "reconciled_components" | "decisions"
> {
  const effectiveComponentTargets = new Map(
    (status.effective ?? [])
      .filter(
        (deployment) =>
          deployment.target_type === "component" &&
          DEFAULT_RUNTIME_DEPLOYMENT_POLICY[
            deployment.target as ManagedComponentKind
          ] != null,
      )
      .map((deployment) => [
        deployment.target as ManagedComponentKind,
        deployment,
      ]),
  );
  const observedComponents = new Map(
    (status.observed_components ?? []).map((component) => [
      component.component,
      component,
    ]),
  );
  const observedTargets = new Map(
    (status.observed_targets ?? [])
      .filter((target) => target.target_type === "component")
      .map((target) => [target.target as ManagedComponentKind, target]),
  );
  const requestedComponents = (components ?? []).length
    ? normalizeManagedComponentKindsForDedupe(components ?? [])
    : [...effectiveComponentTargets.keys()].sort();
  const currentArtifactVersion = installedProjectHostArtifactVersion(row);
  const decisions: HostRuntimeDeploymentReconcileResult["decisions"] = [];
  const reconciled_components: ManagedComponentKind[] = [];

  for (const component of requestedComponents) {
    const deployment = effectiveComponentTargets.get(component);
    if (!deployment) {
      decisions.push({
        component,
        decision: "skip",
        reason: "no_desired_component_target",
      });
      continue;
    }
    const observed = observedComponents.get(component);
    const observedTarget = observedTargets.get(component);
    const artifact = `${observed?.artifact ?? "project-host"}`.trim();
    if (!observed) {
      decisions.push({
        component,
        decision: "skip",
        reason: "unobserved_component",
        artifact,
        desired_version: deployment.desired_version,
      });
      continue;
    }
    if (!observed.managed) {
      decisions.push({
        component,
        decision: "skip",
        reason: "unmanaged_component",
        artifact,
        desired_version: deployment.desired_version,
      });
      continue;
    }
    if (!observed.enabled) {
      decisions.push({
        component,
        decision: "skip",
        reason: "disabled_component",
        artifact,
        desired_version: deployment.desired_version,
      });
      continue;
    }
    if (artifact !== "project-host") {
      decisions.push({
        component,
        decision: "skip",
        reason: "unsupported_artifact",
        artifact,
        desired_version: deployment.desired_version,
      });
      continue;
    }
    if (!currentArtifactVersion) {
      decisions.push({
        component,
        decision: "skip",
        reason: "missing_installed_artifact_version",
        artifact,
        desired_version: deployment.desired_version,
      });
      continue;
    }
    if (deployment.desired_version !== currentArtifactVersion) {
      decisions.push({
        component,
        decision: "skip",
        reason: "artifact_version_mismatch",
        artifact,
        desired_version: deployment.desired_version,
        current_artifact_version: currentArtifactVersion,
        observed_version_state: observedTarget?.observed_version_state,
        running_versions: observed.running_versions,
      });
      continue;
    }
    if (observedTarget?.observed_version_state === "aligned") {
      decisions.push({
        component,
        decision: "skip",
        reason: "already_aligned",
        artifact,
        desired_version: deployment.desired_version,
        current_artifact_version: currentArtifactVersion,
        observed_version_state: observedTarget.observed_version_state,
        running_versions: observed.running_versions,
      });
      continue;
    }
    decisions.push({
      component,
      decision: "rollout",
      reason: `${observedTarget?.observed_version_state ?? "drifted"}`,
      artifact,
      desired_version: deployment.desired_version,
      current_artifact_version: currentArtifactVersion,
      observed_version_state: observedTarget?.observed_version_state,
      running_versions: observed.running_versions,
    });
    reconciled_components.push(component);
  }

  return {
    ...(components?.length
      ? { requested_components: requestedComponents }
      : {}),
    reconciled_components,
    decisions,
  };
}

async function loadHostRowForRuntimeDeploymentsInternal(
  host_id: string,
): Promise<any | undefined> {
  const { rows } = await pool().query(
    `SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL LIMIT 1`,
    [host_id],
  );
  return rows[0];
}

export async function reconcileHostRuntimeDeploymentsInternal({
  account_id,
  id,
  components,
  reason,
}: {
  account_id?: string;
  id: string;
  components?: ManagedComponentKind[];
  reason?: string;
}): Promise<HostRuntimeDeploymentReconcileResult> {
  const row = await loadHostForStartStop(id, account_id);
  assertHostRunningForUpgrade(row);
  const status = await getHostRuntimeDeploymentStatus({ account_id, id });
  const plan = computeHostRuntimeDeploymentReconcilePlan({
    row,
    status,
    components,
  });

  const result: HostRuntimeDeploymentReconcileResult = {
    host_id: row.id,
    ...plan,
  };
  if (!plan.reconciled_components.length) {
    return result;
  }
  const rollout = await rolloutHostManagedComponentsInternal({
    account_id,
    id,
    components: plan.reconciled_components,
    reason,
  });
  return {
    ...result,
    rollout_results: rollout.results ?? [],
  };
}

export async function rollbackHostRuntimeDeploymentsInternal({
  account_id,
  id,
  target_type,
  target,
  version,
  last_known_good,
  reason,
}: {
  account_id?: string;
  id: string;
  target_type: "component" | "artifact";
  target: HostRuntimeDeploymentTarget;
  version?: string;
  last_known_good?: boolean;
  reason?: string;
}): Promise<HostRuntimeDeploymentRollbackResult> {
  const row = await loadHostForStartStop(id, account_id);
  assertHostRunningForUpgrade(row);
  const status = await getHostRuntimeDeploymentStatus({ account_id, id });
  const effectiveTargets = new Map(
    (status.effective ?? []).map((deployment) => [
      targetKeyForRuntimeDeployment({
        target_type: deployment.target_type,
        target: deployment.target,
      }),
      deployment,
    ]),
  );
  const rollbackTargets = new Map(
    (status.rollback_targets ?? []).map((rollbackTarget) => [
      targetKeyForRuntimeDeployment({
        target_type: rollbackTarget.target_type,
        target: rollbackTarget.target,
      }),
      rollbackTarget,
    ]),
  );
  const key = targetKeyForRuntimeDeployment({ target_type, target });
  const deployment = effectiveTargets.get(key);
  const rollbackTarget = rollbackTargets.get(key);
  if (!deployment || !rollbackTarget) {
    throw new Error("rollback target is not configured");
  }
  const { rollback_version, rollback_source } = resolveRollbackVersion({
    rollbackTarget,
    version,
    last_known_good,
  });
  const artifact = rollbackTarget.artifact;
  if (artifact === "bootstrap-environment") {
    throw new Error("bootstrap-environment rollback is not implemented");
  }
  const requested_by = requestedByForRuntimeDeployments({ account_id, row });
  const updatedDeployments = await setProjectHostRuntimeDeployments({
    scope_type: "host",
    host_id: row.id,
    requested_by,
    replace: false,
    deployments: [
      {
        target_type: deployment.target_type,
        target: deployment.target,
        desired_version: rollback_version,
        rollout_policy: deployment.rollout_policy,
        drain_deadline_seconds: deployment.drain_deadline_seconds,
        rollout_reason:
          `${reason ?? deployment.rollout_reason ?? ""}`.trim() || undefined,
        metadata: deployment.metadata,
      },
    ],
  });
  const updatedDeployment = updatedDeployments.find(
    (entry) => entry.target_type === target_type && entry.target === target,
  );
  let upgrade_results: HostRuntimeDeploymentRollbackResult["upgrade_results"];
  let reconcile_result:
    | HostRuntimeDeploymentRollbackResult["reconcile_result"]
    | undefined;
  let managed_component_rollout:
    | HostRuntimeDeploymentRollbackResult["managed_component_rollout"]
    | undefined;
  const currentArtifactVersion =
    `${rollbackTarget.current_version ?? ""}`.trim();
  if (currentArtifactVersion !== rollback_version) {
    const upgrade = await upgradeHostSoftwareInternal({
      account_id,
      id: row.id,
      targets: [{ artifact, version: rollback_version }],
    });
    upgrade_results = upgrade.results ?? [];
  }
  if (target_type === "artifact") {
    if (
      target === "project-host" &&
      currentArtifactVersion !== rollback_version
    ) {
      const rollout = await rolloutHostManagedComponentsInternal({
        account_id,
        id: row.id,
        components: ["project-host"],
        reason: reason ?? "runtime_rollback",
      });
      managed_component_rollout = rollout.results ?? [];
    }
  } else {
    if (artifact !== "project-host") {
      throw new Error(`component rollback for ${artifact} is not implemented`);
    }
    reconcile_result = await reconcileHostRuntimeDeploymentsInternal({
      account_id,
      id: row.id,
      components: [target as ManagedComponentKind],
      reason: reason ?? "runtime_rollback",
    });
  }
  return {
    host_id: row.id,
    target_type,
    target,
    artifact,
    rollback_version,
    rollback_source,
    deployment: updatedDeployment,
    ...(upgrade_results ? { upgrade_results } : {}),
    ...(reconcile_result ? { reconcile_result } : {}),
    ...(managed_component_rollout ? { managed_component_rollout } : {}),
  };
}

function mapUpgradeArtifact(
  artifact: string,
): "project_host" | "project_bundle" | "tools" | undefined {
  if (artifact === "project-host") return "project_host";
  if (artifact === "project" || artifact === "project-bundle") {
    return "project_bundle";
  }
  if (artifact === "tools") return "tools";
  return undefined;
}

function canonicalizeSoftwareArtifact(
  artifact: HostSoftwareArtifact,
): "project-host" | "project" | "tools" {
  if (artifact === "project-bundle") return "project";
  return artifact;
}

function extractVersionFromSoftwareUrl(
  artifact: "project-host" | "project" | "tools",
  url?: string,
): string | undefined {
  if (!url) return undefined;
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(new RegExp(`/${artifact}/([^/]+)/`));
    return match?.[1];
  } catch {
    return undefined;
  }
}

function normalizeSoftwareOs(value?: string): "linux" | "darwin" {
  const raw = `${value ?? "linux"}`.trim().toLowerCase();
  if (raw === "darwin" || raw === "macos" || raw === "osx") return "darwin";
  return "linux";
}

function normalizeSoftwareArch(value?: string): "amd64" | "arm64" {
  const raw = `${value ?? "amd64"}`.trim().toLowerCase();
  if (raw === "arm64" || raw === "aarch64") return "arm64";
  return "amd64";
}

function normalizeSoftwareChannels(
  channels?: HostSoftwareChannel[],
): HostSoftwareChannel[] {
  const values = (channels ?? ["latest"]).map((channel) =>
    channel === "staging" ? "staging" : "latest",
  );
  return Array.from(new Set(values));
}

function normalizeSoftwareArtifacts(
  artifacts?: HostSoftwareArtifact[],
): HostSoftwareArtifact[] {
  const defaults: HostSoftwareArtifact[] = ["project-host", "project", "tools"];
  if (!artifacts?.length) return defaults;
  const out: HostSoftwareArtifact[] = [];
  for (const artifact of artifacts) {
    if (
      artifact === "project-host" ||
      artifact === "project" ||
      artifact === "project-bundle" ||
      artifact === "tools"
    ) {
      out.push(artifact);
    }
  }
  return out.length ? Array.from(new Set(out)) : defaults;
}

function normalizeHostUpgradeTargetsForDedupe(
  targets: HostSoftwareUpgradeTarget[],
): Array<{
  artifact: HostSoftwareArtifact;
  channel: HostSoftwareChannel | null;
  version: string | null;
}> {
  return [...(targets ?? [])]
    .map((target) => ({
      artifact: canonicalizeSoftwareArtifact(target.artifact),
      channel: target.version
        ? null
        : ((target.channel === "staging"
            ? "staging"
            : "latest") as HostSoftwareChannel),
      version: target.version?.trim() || null,
    }))
    .sort((a, b) =>
      `${a.artifact}:${a.channel ?? ""}:${a.version ?? ""}`.localeCompare(
        `${b.artifact}:${b.channel ?? ""}:${b.version ?? ""}`,
      ),
    );
}

function assertProjectHostUpgradeIsExclusive(
  targets: HostSoftwareUpgradeTarget[],
): void {
  const normalizedTargets = normalizeHostUpgradeTargetsForDedupe(targets);
  const includesProjectHost = normalizedTargets.some(
    (target) => target.artifact === "project-host",
  );
  if (!includesProjectHost || normalizedTargets.length <= 1) {
    return;
  }
  throw new Error(
    "project-host upgrades must be requested separately from other artifacts",
  );
}

function hostUpgradeDedupeKey({
  hostId,
  targets,
  baseUrl,
}: {
  hostId: string;
  targets: HostSoftwareUpgradeTarget[];
  baseUrl?: string;
}): string {
  const normalizedBaseUrl = `${baseUrl ?? ""}`.trim() || null;
  return `${HOST_UPGRADE_LRO_KIND}:${hostId}:${JSON.stringify({
    base_url: normalizedBaseUrl,
    targets: normalizeHostUpgradeTargetsForDedupe(targets),
  })}`;
}

function normalizeManagedComponentKindsForDedupe(
  components: ManagedComponentKind[],
): ManagedComponentKind[] {
  return [...new Set(components ?? [])].sort();
}

export function rolloutComponentsForUpgradeResults(
  results: HostSoftwareUpgradeResponse["results"],
): ManagedComponentKind[] {
  const components = new Set<ManagedComponentKind>();
  for (const result of results ?? []) {
    if (result.artifact === "project-host" && result.status === "updated") {
      components.add("project-host");
    }
  }
  return [...components];
}

function runtimeDeploymentsForUpgradeResults(
  results: HostSoftwareUpgradeResponse["results"],
): HostRuntimeDeploymentUpsert[] {
  const deployments: HostRuntimeDeploymentUpsert[] = [];
  for (const result of results ?? []) {
    const target = normalizeRuntimeArtifactTarget(result.artifact);
    if (!target || !`${result.version ?? ""}`.trim()) continue;
    deployments.push({
      target_type: "artifact",
      target,
      desired_version: result.version,
    });
  }
  return normalizeRuntimeDeploymentUpserts(deployments);
}

function runtimeDeploymentsForComponentRollout({
  components,
  desired_version,
  reason,
}: {
  components: ManagedComponentKind[];
  desired_version?: string;
  reason?: string;
}): HostRuntimeDeploymentUpsert[] {
  const version = `${desired_version ?? ""}`.trim();
  if (!version) return [];
  return normalizeRuntimeDeploymentUpserts(
    (components ?? []).map((component) => ({
      target_type: "component",
      target: component,
      desired_version: version,
      rollout_policy: DEFAULT_RUNTIME_DEPLOYMENT_POLICY[component],
      rollout_reason: reason,
    })),
  );
}

function hostManagedComponentRolloutDedupeKey({
  hostId,
  components,
  reason,
}: {
  hostId: string;
  components: ManagedComponentKind[];
  reason?: string;
}): string {
  return `${HOST_ROLLOUT_MANAGED_COMPONENTS_LRO_KIND}:${hostId}:${JSON.stringify(
    {
      components: normalizeManagedComponentKindsForDedupe(components),
      reason: `${reason ?? ""}`.trim() || null,
    },
  )}`;
}

async function fetchSoftwareManifest(url: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOFTWARE_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return await response.json();
}

async function fetchSoftwareManifestMaybe(
  url: string,
): Promise<any | undefined> {
  try {
    return await fetchSoftwareManifest(url);
  } catch {
    return undefined;
  }
}

function softwareVersionsIndexUrl({
  baseUrl,
  artifact,
  channel,
  os,
  arch,
}: {
  baseUrl: string;
  artifact: "project-host" | "project" | "tools";
  channel: HostSoftwareChannel;
  os: "linux" | "darwin";
  arch: "amd64" | "arm64";
}): string {
  if (artifact === "tools") {
    return `${baseUrl}/${artifact}/versions-${channel}-${os}-${arch}.json`;
  }
  return `${baseUrl}/${artifact}/versions-${channel}-${os}.json`;
}

function normalizePublishedVersionRows(index: any): any[] {
  if (Array.isArray(index?.versions)) {
    return index.versions;
  }
  if (Array.isArray(index)) {
    return index;
  }
  return [];
}

function softwareVersionRowKey({
  version,
  url,
}: {
  version?: string;
  url?: string;
}): string {
  const v = `${version ?? ""}`.trim();
  if (v) return `v:${v}`;
  const u = `${url ?? ""}`.trim();
  if (u) return `u:${u}`;
  return "";
}

function mapPublishedVersionRow({
  artifact,
  channel,
  os,
  arch,
  canonical,
  row,
}: {
  artifact: HostSoftwareArtifact;
  channel: HostSoftwareChannel;
  os: "linux" | "darwin";
  arch: "amd64" | "arm64";
  canonical: "project-host" | "project" | "tools";
  row: any;
}): HostSoftwareAvailableVersion | undefined {
  const url = typeof row?.url === "string" ? row.url : undefined;
  let version = typeof row?.version === "string" ? row.version : undefined;
  if (!version && url) {
    version = extractVersionFromSoftwareUrl(canonical, url);
  }
  const available = !!url;
  if (!available && !version) return undefined;
  return {
    artifact,
    channel,
    os,
    arch,
    version,
    url,
    sha256: typeof row?.sha256 === "string" ? row.sha256 : undefined,
    available,
    error: available ? undefined : "version entry missing url",
  };
}

async function resolvePublishedSoftwareRows({
  baseUrl,
  artifact,
  channel,
  os,
  arch,
  limit,
  latest,
}: {
  baseUrl: string;
  artifact: HostSoftwareArtifact;
  channel: HostSoftwareChannel;
  os: "linux" | "darwin";
  arch: "amd64" | "arm64";
  limit: number;
  latest: HostSoftwareAvailableVersion;
}): Promise<HostSoftwareAvailableVersion[]> {
  if (limit <= 1) return [latest];
  const canonical = canonicalizeSoftwareArtifact(artifact);
  const indexUrl = softwareVersionsIndexUrl({
    baseUrl,
    artifact: canonical,
    channel,
    os,
    arch,
  });
  const index = await fetchSoftwareManifestMaybe(indexUrl);
  if (!index) return [latest];
  const rows: HostSoftwareAvailableVersion[] = [latest];
  const seen = new Set<string>();
  const latestKey = softwareVersionRowKey(latest);
  if (latestKey) seen.add(latestKey);
  for (const candidate of normalizePublishedVersionRows(index)) {
    const mapped = mapPublishedVersionRow({
      artifact,
      channel,
      os,
      arch,
      canonical,
      row: candidate,
    });
    if (!mapped) continue;
    const key = softwareVersionRowKey(mapped);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    rows.push(mapped);
    if (rows.length >= limit) break;
  }
  return rows;
}

async function resolveLatestSoftwareRow({
  softwareBaseUrl,
  artifact,
  channel,
  targetOs,
  targetArch,
}: {
  softwareBaseUrl: string;
  artifact: HostSoftwareArtifact;
  channel: HostSoftwareChannel;
  targetOs: "linux" | "darwin";
  targetArch: "amd64" | "arm64";
}): Promise<HostSoftwareAvailableVersion> {
  const canonical = canonicalizeSoftwareArtifact(artifact);
  const manifestUrl =
    canonical === "tools"
      ? `${softwareBaseUrl}/${canonical}/${channel}-${targetOs}-${targetArch}.json`
      : `${softwareBaseUrl}/${canonical}/${channel}-${targetOs}.json`;
  try {
    const manifest = await fetchSoftwareManifest(manifestUrl);
    const resolvedUrl =
      typeof manifest?.url === "string" ? manifest.url : undefined;
    const resolvedVersion = extractVersionFromSoftwareUrl(
      canonical,
      resolvedUrl,
    );
    return {
      artifact,
      channel,
      os: targetOs,
      arch: targetArch,
      version: resolvedVersion,
      url: resolvedUrl,
      sha256:
        typeof manifest?.sha256 === "string" ? manifest.sha256 : undefined,
      available: !!resolvedUrl,
      error: resolvedUrl ? undefined : "manifest missing url",
    };
  } catch (err) {
    return {
      artifact,
      channel,
      os: targetOs,
      arch: targetArch,
      available: false,
      error: `${err instanceof Error ? err.message : err}`,
    };
  }
}

function normalizeSoftwareHistoryLimit(value?: number): number {
  const n = Number(value ?? SOFTWARE_HISTORY_DEFAULT_LIMIT);
  if (!Number.isFinite(n)) return SOFTWARE_HISTORY_DEFAULT_LIMIT;
  return Math.max(1, Math.min(SOFTWARE_HISTORY_MAX_LIMIT, Math.floor(n)));
}

async function resolveHostSoftwareBaseUrl(base_url?: string): Promise<string> {
  let requestedBaseUrl = base_url;
  if (requestedBaseUrl) {
    try {
      const parsed = new URL(requestedBaseUrl);
      const host = parsed.hostname.toLowerCase();
      if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host === "[::1]"
      ) {
        const publicSite = (await siteURL()).replace(/\/+$/, "");
        requestedBaseUrl = `${publicSite}/software`;
      } else {
        const path = parsed.pathname.replace(/\/+$/, "");
        if (!path) {
          parsed.pathname = "/software";
          parsed.search = "";
          parsed.hash = "";
          requestedBaseUrl = parsed.toString();
        }
      }
    } catch {
      // keep provided value as-is if it is not a valid URL
    }
  }
  const { project_hosts_software_base_url } = await getServerSettings();
  const forcedSoftwareBaseUrl =
    process.env.COCALC_PROJECT_HOST_SOFTWARE_BASE_URL_FORCE?.trim() ||
    undefined;
  return (
    requestedBaseUrl ??
    forcedSoftwareBaseUrl ??
    project_hosts_software_base_url ??
    process.env.COCALC_PROJECT_HOST_SOFTWARE_BASE_URL ??
    DEFAULT_SOFTWARE_BASE_URL
  );
}

function isLoopbackHostName(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]"
  );
}

function isLoopbackSoftwareBaseUrl(value: string): boolean {
  try {
    return isLoopbackHostName(new URL(value).hostname);
  } catch {
    return false;
  }
}

function isLocalSelfHost(row: any): boolean {
  const machine: HostMachine = row?.metadata?.machine ?? {};
  if (machine.cloud !== "self-host") return false;
  const mode = machine.metadata?.self_host_mode;
  return !mode || mode === "local";
}

async function resolveReachableUpgradeBaseUrl({
  row,
  baseUrl,
}: {
  row: any;
  baseUrl: string;
}): Promise<string> {
  if (!isLoopbackSoftwareBaseUrl(baseUrl)) {
    return baseUrl;
  }
  if (isLocalSelfHost(row)) {
    return baseUrl;
  }
  let replacement = DEFAULT_SOFTWARE_BASE_URL;
  try {
    const publicSite = (await siteURL()).replace(/\/+$/, "");
    const candidate = `${publicSite}/software`;
    if (!isLoopbackSoftwareBaseUrl(candidate)) {
      replacement = candidate;
    }
  } catch {
    // keep default replacement
  }
  logger.warn(
    "upgrade host software: replaced loopback base url for remote host",
    {
      host_id: row.id,
      requested: baseUrl,
      effective: replacement,
    },
  );
  return replacement;
}

export async function listHostSoftwareVersions({
  account_id,
  base_url,
  artifacts,
  channels,
  os,
  arch,
  history_limit,
}: {
  account_id?: string;
  base_url?: string;
  artifacts?: HostSoftwareArtifact[];
  channels?: HostSoftwareChannel[];
  os?: "linux" | "darwin";
  arch?: "amd64" | "arm64";
  history_limit?: number;
}): Promise<HostSoftwareAvailableVersion[]> {
  requireAccount(account_id);
  const softwareBaseUrl = (await resolveHostSoftwareBaseUrl(base_url)).replace(
    /\/+$/,
    "",
  );
  const targetOs = normalizeSoftwareOs(os);
  const targetArch = normalizeSoftwareArch(arch);
  const artifactList = normalizeSoftwareArtifacts(artifacts);
  const channelList = normalizeSoftwareChannels(channels);
  const historyLimit = normalizeSoftwareHistoryLimit(history_limit);
  const rows: HostSoftwareAvailableVersion[] = [];
  for (const artifact of artifactList) {
    for (const channel of channelList) {
      const latest = await resolveLatestSoftwareRow({
        softwareBaseUrl,
        artifact,
        channel,
        targetOs,
        targetArch,
      });
      if (!latest.available) {
        rows.push(latest);
        continue;
      }
      const resolved = await resolvePublishedSoftwareRows({
        baseUrl: softwareBaseUrl,
        artifact,
        channel,
        os: targetOs,
        arch: targetArch,
        limit: historyLimit,
        latest,
      });
      rows.push(...resolved);
    }
  }
  return rows;
}

export async function upgradeHostSoftwareInternal({
  account_id,
  id,
  targets,
  base_url,
}: {
  account_id?: string;
  id: string;
  targets: HostSoftwareUpgradeTarget[];
  base_url?: string;
}): Promise<HostSoftwareUpgradeResponse> {
  assertProjectHostUpgradeIsExclusive(targets);
  const HOST_UPGRADE_RPC_TIMEOUT_MS = 10 * 60 * 1000;
  const row = await loadHostForStartStop(id, account_id);
  assertHostRunningForUpgrade(row);
  const availability = computeHostOperationalAvailability(row);
  const requestedProjectHostUpgrade = targets.some(
    (target) => target.artifact === "project-host",
  );
  const supportsBootstrapFallback =
    requestedProjectHostUpgrade &&
    targets.every(
      (target) =>
        !target.version &&
        ((target.channel ?? "latest") as HostSoftwareChannel) === "latest",
    );
  const resolvedBaseUrl = await resolveHostSoftwareBaseUrl(base_url);
  const effectiveBaseUrl = await resolveReachableUpgradeBaseUrl({
    row,
    baseUrl: resolvedBaseUrl,
  });
  if (!availability.online && supportsBootstrapFallback) {
    logger.warn(
      "host upgrade: host heartbeat is stale; using bootstrap reconcile fallback",
      {
        host_id: id,
        targets,
        reason: availability.reason_unavailable,
      },
    );
    await reconcileCloudHostBootstrapOverSsh({ host_id: id, row });
    return { results: [] };
  }
  const client = await hostControlClient(id, HOST_UPGRADE_RPC_TIMEOUT_MS);
  let response: HostSoftwareUpgradeResponse;
  try {
    response = await client.upgradeSoftware({
      targets,
      base_url: effectiveBaseUrl,
      restart_project_host: false,
    });
  } catch (err) {
    if (!supportsBootstrapFallback) {
      throw err;
    }
    logger.warn("host upgrade: host control upgrade failed; retry via ssh", {
      host_id: id,
      targets,
      err: `${err}`,
    });
    await reconcileCloudHostBootstrapOverSsh({ host_id: id, row });
    return { results: [] };
  }
  const results = response.results ?? [];
  if (results.length) {
    const metadata = row.metadata ?? {};
    const software = { ...(metadata.software ?? {}) } as Record<string, string>;
    for (const result of results) {
      const key = mapUpgradeArtifact(result.artifact);
      if (key) {
        software[key] = result.version;
      }
    }
    const nextMetadata = { ...metadata, software };
    const nextVersion = software.project_host ?? row.version ?? null;
    await pool().query(
      `UPDATE project_hosts SET metadata=$2, version=$3, updated=NOW() WHERE id=$1 AND deleted IS NULL`,
      [row.id, nextMetadata, nextVersion],
    );
  }
  const runtimeDeployments = runtimeDeploymentsForUpgradeResults(results);
  if (runtimeDeployments.length) {
    await setProjectHostRuntimeDeployments({
      scope_type: "host",
      host_id: row.id,
      requested_by: requestedByForRuntimeDeployments({ account_id, row }),
      deployments: runtimeDeployments,
      replace: false,
    });
  }
  return response;
}

export async function rolloutHostManagedComponentsInternal({
  account_id,
  id,
  components,
  reason,
}: {
  account_id?: string;
  id: string;
  components: HostManagedComponentRolloutRequest["components"];
  reason?: string;
}): Promise<HostManagedComponentRolloutResponse> {
  const row = await loadHostForStartStop(id, account_id);
  assertHostRunningForUpgrade(row);
  const client = await hostControlClient(id, 60_000);
  const rolloutStartedAt = Date.now();
  const response = await client.rolloutManagedComponents({
    components,
    reason,
  });
  if (components.includes("project-host")) {
    const baselineSeen = row?.last_seen
      ? new Date(row.last_seen as any).getTime()
      : 0;
    const since = Math.max(baselineSeen, rolloutStartedAt);
    await waitForHostHeartbeatAfter({ host_id: id, since });
  }
  const desiredVersion =
    `${row?.metadata?.software?.project_host ?? row?.version ?? ""}`.trim() ||
    undefined;
  if (components.includes("project-host") && desiredVersion) {
    await setLastKnownGoodArtifactVersionInternal({
      host_id: row.id,
      row,
      artifact: "project-host",
      version: desiredVersion,
    });
  }
  const runtimeDeployments = runtimeDeploymentsForComponentRollout({
    components,
    desired_version: desiredVersion,
    reason,
  });
  if (runtimeDeployments.length) {
    await setProjectHostRuntimeDeployments({
      scope_type: "host",
      host_id: row.id,
      requested_by: requestedByForRuntimeDeployments({ account_id, row }),
      deployments: runtimeDeployments,
      replace: false,
    });
  }
  return response;
}

export async function deleteHost({
  account_id,
  id,
  skip_backups,
}: {
  account_id?: string;
  id: string;
  skip_backups?: boolean;
}): Promise<HostLroResponse> {
  const row = await loadOwnedHost(id, account_id);
  const kind =
    row.status === "deprovisioned"
      ? HOST_DELETE_LRO_KIND
      : HOST_DEPROVISION_LRO_KIND;
  return await createHostLro({
    kind,
    row,
    account_id,
    input: { id: row.id, account_id, skip_backups: !!skip_backups },
    dedupe_key: `${kind}:${row.id}`,
  });
}

export async function deleteHostInternal({
  account_id,
  id,
}: {
  account_id?: string;
  id: string;
}): Promise<void> {
  const row = await loadOwnedHost(id, account_id);
  const machineCloud = normalizeProviderId(row.metadata?.machine?.cloud);
  if (row.status === "deprovisioned") {
    await setHostDesiredState(id, "stopped");
    await pool().query(
      `UPDATE project_hosts SET deleted=NOW(), updated=NOW() WHERE id=$1 AND deleted IS NULL`,
      [id],
    );
    return;
  }
  if (machineCloud) {
    await setHostDesiredState(id, "stopped");
    await enqueueCloudVmWork({
      vm_id: id,
      action: "delete",
      payload: { provider: machineCloud },
    });
    logStatusUpdate(id, "deprovisioning", "api");
    await pool().query(
      `UPDATE project_hosts SET status=$2, updated=NOW() WHERE id=$1 AND deleted IS NULL`,
      [id, "deprovisioning"],
    );
    return;
  }
  logStatusUpdate(id, "deprovisioned", "api");
  await pool().query(
    `UPDATE project_hosts
       SET status=$2,
           metadata=jsonb_set(COALESCE(metadata, '{}'::jsonb), '{desired_state}', to_jsonb($3::text)),
           updated=NOW()
     WHERE id=$1 AND deleted IS NULL`,
    [id, "deprovisioned", "stopped"],
  );
}
