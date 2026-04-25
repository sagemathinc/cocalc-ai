import { delay } from "awaiting";
import type {
  Host,
  HostBackupStatus,
  HostConnectionInfo,
  HostDrainResult,
  HostMachine,
  HostCatalog,
  HostSoftwareArtifact,
  HostSoftwareAvailableVersion,
  HostSoftwareChannel,
  HostSoftwareUpgradeTarget,
  HostSoftwareUpgradeResponse,
  HostRuntimeArtifact,
  HostRuntimeDeploymentRecord,
  HostRuntimeDeploymentTarget,
  HostRuntimeDeploymentRollbackResult,
  HostRuntimeDeploymentReconcileResult,
  HostRuntimeDeploymentScopeType,
  HostRuntimeDeploymentStatus,
  HostRuntimeDeploymentUpsert,
  HostLroResponse,
  HostLroKind,
  HostProjectRow,
  HostProjectsResponse,
  HostProjectStateFilter,
  HostManagedRootfsReleaseLifecycle,
  HostRootfsGcResult,
  HostRootfsImage,
  HostPricingModel,
  HostInterruptionRestorePolicy,
  HostMetricsHistory,
  HostManagedComponentRolloutRequest,
  HostRehomeOperationSummary,
  HostRehomeResponse,
} from "@cocalc/conat/hub/api/hosts";
import type {
  HostManagedComponentRolloutResponse,
  HostManagedComponentStatus,
  ManagedComponentKind,
} from "@cocalc/conat/project-host/api";
import type {
  ProjectCopyRow,
  ProjectCopyState,
  ProjectEnv,
} from "@cocalc/conat/hub/api/projects";
import getLogger from "@cocalc/backend/logger";
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
import { normalizeProviderId, type ProviderId } from "@cocalc/cloud";
import {
  gcpSafeName,
  getProviderPrefix,
  getServerProvider,
  listServerProviders,
} from "@cocalc/server/cloud/providers";
import { getProviderContext } from "@cocalc/server/cloud/provider-context";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { revokeProjectHostTokensForHost } from "@cocalc/server/project-host/bootstrap-token";
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
import {
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
  ensureProjectHostRuntimeDeploymentsSchema,
  listProjectHostRuntimeDeployments,
  setProjectHostRuntimeDeployments,
} from "@cocalc/database/postgres/project-host-runtime-deployments";
import {
  deleteCloudflareTunnel,
  hasCloudflareTunnel,
} from "@cocalc/server/cloud/cloudflare-tunnel";
import {
  getBackupConfig as getBackupConfigLocalInternal,
  recordProjectBackup as recordProjectBackupLocalInternal,
} from "@cocalc/server/project-backup";
import { to_bool } from "@cocalc/util/db-schema/site-defaults";
import { getLLMUsageStatus } from "@cocalc/server/llm/usage-status";
import { computeUsageUnits } from "@cocalc/server/llm/usage-units";
import { saveResponse } from "@cocalc/server/llm/save-response";
import {
  isCoreLanguageModel,
  type LanguageModelCore,
} from "@cocalc/util/db-schema/llm-utils";
import { type RootfsUploadedArtifactResult } from "@cocalc/util/rootfs-images";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterBayIdsForStaticEnumerationOnly } from "@cocalc/server/cluster-config";
import {
  resolveHostBay,
  resolveProjectBay,
} from "@cocalc/server/inter-bay/directory";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { getRoutedHostControlClient } from "@cocalc/server/project-host/client";
import {
  ensureHostOwnerSshTrust as ensureHostOwnerSshTrustInternal,
  getHostRehomeOperation as getHostRehomeOperationInternal,
  reconcileHostRehome as reconcileHostRehomeInternal,
  rehomeHost as rehomeHostInternal,
} from "@cocalc/server/project-host/rehome";
import {
  hostManagedComponentRolloutDedupeKey,
  hostUpgradeDedupeKey,
  listHostSoftwareVersions as listHostSoftwareVersionsInternal,
  mapUpgradeArtifact,
  normalizeManagedComponentKindsForDedupe,
  resolveHostSoftwareBaseUrl,
  resolveReachableUpgradeBaseUrl,
  rolloutComponentsForUpgradeResults as rolloutComponentsForUpgradeResultsInternal,
} from "./hosts-software";
import {
  computeAutomaticArtifactUpgradeTargets,
  computeHostRuntimeDeploymentReconcilePlan,
  normalizeRuntimeArtifactTarget,
  normalizeRuntimeDeploymentUpserts,
  runtimeDeploymentsForComponentRollout,
  runtimeDeploymentsForUpgradeResults,
} from "./hosts-runtime-deployment-planning";
import {
  installedProjectHostArtifactVersion,
  isProjectHostLocalRollbackError as isProjectHostLocalRollbackErrorInternal,
  observedRuntimeArtifactsFromMetadata,
  resolveRollbackVersion,
  targetKeyForRuntimeDeployment,
} from "./hosts-runtime-observation";
import {
  recordProjectHostLocalRollbackInternal as recordProjectHostLocalRollbackInternalHelper,
  rollbackProjectHostOverSshInternal as rollbackProjectHostOverSshInternalHelper,
  setLastKnownGoodArtifactVersionInternal,
} from "./hosts-project-host-rollbacks";
import {
  getHostRuntimeDeploymentStatusInternal,
  listRunningHostIdsForAutomaticRuntimeDeploymentReconcile,
  loadHostRowForRuntimeDeploymentsInternal,
} from "./hosts-runtime-deployment-status";
import {
  bestEffortQueueAutomaticArtifactDeploymentReconcileForHostsInternal,
  bestEffortQueueAutomaticRuntimeDeploymentReconcileForHostsInternal,
  ensureAutomaticHostArtifactDeploymentsReconcileInternal,
  ensureAutomaticHostRuntimeDeploymentsReconcileInternal,
} from "./hosts-runtime-deployment-queue";
import {
  reconcileHostRuntimeDeploymentsInternalHelper,
  rollbackHostRuntimeDeploymentsInternalHelper,
} from "./hosts-runtime-deployment-execution";
import {
  rolloutHostManagedComponentsInternalHelper,
  upgradeHostSoftwareInternalHelper,
} from "./hosts-software-execution";
import {
  deleteHostInternalHelper,
  forceDeprovisionHostInternalHelper,
  markHostDeprovisionedInternal as markHostDeprovisionedInternalHelper,
  removeSelfHostConnectorInternalHelper,
  setHostDesiredStateInternal as setHostDesiredStateInternalHelper,
} from "./hosts-teardown";
import { upgradeHostConnectorInternalHelper } from "./hosts-self-host-connectors";
import {
  assertCloudHostBootstrapReconcileSupported,
  reconcileCloudHostBootstrapOverSsh,
} from "./hosts-bootstrap-reconcile";
import {
  createHostInternalHelper,
  restartHostInternalHelper,
  startHostInternalHelper,
  stopHostInternalHelper,
} from "./hosts-cloud-lifecycle";
import {
  drainHostInternalHelper,
  loadHostForDrainInternal,
  resolveDrainParallelInternal,
} from "./hosts-drain";
import {
  issueProjectHostAgentAuthTokenInternalHelper,
  issueProjectHostHubAuthTokenInternalHelper,
  issueProjectHostAuthTokenLocalHelper,
  resolveHostConnectionLocalHelper,
} from "./hosts-connection-auth";
import {
  computeHostOperationalAvailability,
  defaultInterruptionRestorePolicy,
  normalizeHostInterruptionRestorePolicy,
  normalizeHostPricingModel,
  normalizeHostTier,
  parseRow,
} from "./hosts-normalization";
import {
  enrichHostRootfsImages,
  getManagedRootfsReleaseArtifactInternal,
  listManagedRootfsReleaseLifecycleInternal,
  recordManagedRootfsReleaseReplicaInternal,
} from "./hosts-rootfs-releases";
function pool() {
  return getPool();
}

async function loadHostRuntimeExceptionSummaries(
  host_ids: string[],
): Promise<Map<string, Host["runtime_exception_summary"]>> {
  const uniqueHostIds = Array.from(
    new Set(host_ids.map((id) => `${id ?? ""}`.trim()).filter(Boolean)),
  );
  if (!uniqueHostIds.length) {
    return new Map();
  }
  await ensureProjectHostRuntimeDeploymentsSchema();
  const { rows } = await pool().query<{ host_id: string; target: string }>(
    `SELECT host_id::text AS host_id, target
     FROM project_host_runtime_deployments
     WHERE scope_type='host'
       AND host_id::text = ANY($1::text[])
     ORDER BY host_id, target_type, target`,
    [uniqueHostIds],
  );
  const summaries = new Map<string, Host["runtime_exception_summary"]>();
  for (const row of rows) {
    const host_id = `${row?.host_id ?? ""}`.trim();
    const target = `${row?.target ?? ""}`.trim() as HostRuntimeDeploymentTarget;
    if (!host_id || !target) continue;
    const current = summaries.get(host_id);
    if (!current) {
      summaries.set(host_id, {
        host_override_count: 1,
        host_override_targets: [target],
      });
      continue;
    }
    if (current.host_override_targets.includes(target)) {
      continue;
    }
    current.host_override_targets.push(target);
    current.host_override_targets.sort((left, right) =>
      left.localeCompare(right),
    );
    current.host_override_count = current.host_override_targets.length;
  }
  return summaries;
}

type HostRuntimeDesiredArtifactsSummary = {
  project_host?: string;
  project_bundle?: string;
  tools?: string;
  updated_at?: string;
};

async function loadHostRuntimeDesiredArtifactSummaries(
  host_ids: string[],
): Promise<Map<string, HostRuntimeDesiredArtifactsSummary>> {
  const uniqueHostIds = Array.from(
    new Set(host_ids.map((id) => `${id ?? ""}`.trim()).filter(Boolean)),
  );
  if (!uniqueHostIds.length) {
    return new Map();
  }
  await ensureProjectHostRuntimeDeploymentsSchema();
  const globalRows = await listProjectHostRuntimeDeployments({
    scope_type: "global",
  });
  const { rows } = await pool().query<{
    host_id: string;
    target: string;
    desired_version: string;
    updated_at: Date | string;
  }>(
    `SELECT host_id::text AS host_id, target, desired_version, updated_at
     FROM project_host_runtime_deployments
     WHERE scope_type='host'
       AND target_type='artifact'
       AND host_id::text = ANY($1::text[])
       AND target = ANY($2::text[])`,
    [uniqueHostIds, ["project-host", "project-bundle", "tools"]],
  );
  const setSummaryValue = (
    summary: HostRuntimeDesiredArtifactsSummary,
    target: string,
    desired_version: string,
    updated_at?: string,
  ) => {
    switch (target) {
      case "project-host":
        summary.project_host = desired_version;
        break;
      case "project-bundle":
        summary.project_bundle = desired_version;
        break;
      case "tools":
        summary.tools = desired_version;
        break;
      default:
        return;
    }
    if (!summary.updated_at) {
      summary.updated_at = updated_at;
      return;
    }
    if (!updated_at) return;
    const currentMs = new Date(summary.updated_at).getTime();
    const nextMs = new Date(updated_at).getTime();
    if (
      Number.isFinite(nextMs) &&
      (!Number.isFinite(currentMs) || nextMs > currentMs)
    ) {
      summary.updated_at = updated_at;
    }
  };
  const globalSummary: HostRuntimeDesiredArtifactsSummary = {};
  for (const record of globalRows) {
    if (record.target_type !== "artifact") continue;
    setSummaryValue(
      globalSummary,
      record.target,
      record.desired_version,
      record.updated_at,
    );
  }
  const summaries = new Map<string, HostRuntimeDesiredArtifactsSummary>();
  for (const host_id of uniqueHostIds) {
    summaries.set(host_id, { ...globalSummary });
  }
  for (const row of rows) {
    const host_id = `${row?.host_id ?? ""}`.trim();
    const desired_version = `${row?.desired_version ?? ""}`.trim();
    const target = `${row?.target ?? ""}`.trim();
    if (!host_id || !desired_version || !target) continue;
    const summary = summaries.get(host_id) ?? {};
    setSummaryValue(
      summary,
      target,
      desired_version,
      new Date(row.updated_at).toISOString(),
    );
    summaries.set(host_id, summary);
  }
  return summaries;
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
const PROJECT_HOST_LOCAL_ROLLBACK_ERROR_CODE = "PROJECT_HOST_LOCAL_ROLLBACK";

export const isProjectHostLocalRollbackError =
  isProjectHostLocalRollbackErrorInternal;

const AUTOMATIC_RUNTIME_DEPLOYMENT_RECONCILE_REASON =
  "automatic_runtime_deployment_reconcile";

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

const HOST_PROJECTS_DEFAULT_LIMIT = 200;
const HOST_PROJECTS_MAX_LIMIT = 5000;
const HOST_ROOTFS_RPC_TIMEOUT_MS = 30 * 60 * 1000;
const HOST_DRAIN_DEFAULT_PARALLEL = 10;
const HOST_DRAIN_OWNER_MAX_PARALLEL = 15;
const HOST_BOOTSTRAP_RECONCILE_TIMEOUT_MS = 20 * 60 * 1000;
const HOST_BOOTSTRAP_RECONCILE_POLL_MS = 5_000;
const HOST_RUNNING_STATUSES = new Set(["running", "active"]);

async function hostControlClient(host_id: string, timeout?: number) {
  return await getRoutedHostControlClient({
    host_id,
    timeout,
  });
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

function logStatusUpdate(id: string, status: string, source: string) {
  const stack = new Error().stack;
  logger.debug("status update", {
    host_id: id,
    status,
    source,
    stack,
  });
}

function requireAccount(account_id?: string): string {
  if (!account_id) {
    throw new Error("must be signed in to manage hosts");
  }
  return account_id;
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

function compareHostProjectRows(a: HostProjectRow, b: HostProjectRow): number {
  const aTime = a.last_edited == null ? 0 : new Date(a.last_edited).valueOf();
  const bTime = b.last_edited == null ? 0 : new Date(b.last_edited).valueOf();
  if (aTime !== bTime) {
    return bTime - aTime;
  }
  if (a.project_id === b.project_id) {
    return 0;
  }
  return a.project_id < b.project_id ? 1 : -1;
}

function rowMatchesHostProjectsCursor(
  row: HostProjectRow,
  cursor: { project_id: string; last_edited: string | null },
): boolean {
  const rowTime =
    row.last_edited == null ? 0 : new Date(row.last_edited).valueOf();
  const cursorTime =
    cursor.last_edited == null ? 0 : new Date(cursor.last_edited).valueOf();
  if (rowTime !== cursorTime) {
    return rowTime < cursorTime;
  }
  return row.project_id < cursor.project_id;
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

function isHostNotFoundError(err: unknown): boolean {
  return err instanceof Error && err.message === "host not found";
}

async function resolveHostProjectListingTarget({
  id,
  account_id,
}: {
  id: string;
  account_id?: string;
}): Promise<
  | { kind: "local"; host: Awaited<ReturnType<typeof loadHostForListing>> }
  | { kind: "remote"; bay_id: string }
> {
  try {
    const host = await loadHostForListing(id, account_id);
    const bay_id = `${host?.bay_id ?? ""}`.trim();
    if (bay_id && bay_id !== getConfiguredBayId()) {
      return { kind: "remote", bay_id };
    }
    return { kind: "local", host };
  } catch (err) {
    if (!isHostNotFoundError(err)) {
      throw err;
    }
  }

  const ownership = await resolveHostBay(id);
  if (!ownership || ownership.bay_id === getConfiguredBayId()) {
    throw new Error("host not found");
  }
  return { kind: "remote", bay_id: ownership.bay_id };
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
  await setHostDesiredStateInternalHelper({
    id,
    desiredState,
    updateHostDesiredState: async (id, desiredState) => {
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
    },
  });
}

async function markHostDeprovisioned(row: any, action: string) {
  await markHostDeprovisionedInternalHelper({
    row,
    action,
    logStatusUpdate,
    revokeProjectHostTokensForHost,
    hasCloudflareTunnel,
    deleteCloudflareTunnel,
    hasDns,
    deleteHostDns,
    logWarn: (message, payload) => logger.warn(message, payload),
    updateHostDeprovisionedRecord: async ({ row, nextMetadata }) => {
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
    },
    clearProjectHostMetrics,
    logCloudVmEvent,
    normalizeProviderId,
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

async function loadMembership(account_id: string) {
  return await resolveMembershipForAccount(account_id);
}

function requireCreateHosts(entitlements: any) {
  const canCreate = entitlements?.features?.create_hosts === true;
  if (!canCreate) {
    throw new Error("membership does not allow host creation");
  }
}

export { rolloutComponentsForUpgradeResultsInternal as rolloutComponentsForUpgradeResults };

export async function getBackupConfig({
  host_id,
  project_id,
  host_region,
  host_machine,
}: {
  host_id?: string;
  project_id?: string;
  host_region?: string | null;
  host_machine?: HostMachine | null;
}): Promise<{ toml: string; ttl_seconds: number }> {
  if (!host_id) {
    throw new Error("host_id must be specified");
  }
  if (!project_id) {
    throw new Error("project_id must be specified");
  }
  const ownership = await resolveProjectBay(project_id);
  if (ownership?.bay_id && ownership.bay_id !== getConfiguredBayId()) {
    const { rows } = await pool().query<{
      region: string | null;
      metadata: any;
    }>(
      "SELECT region, metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
      [host_id],
    );
    const row = rows[0];
    if (!row) {
      throw new Error("host not found");
    }
    return await getInterBayBridge()
      .hostConnection(ownership.bay_id)
      .getBackupConfig({
        host_id,
        project_id,
        host_region: row.region ?? host_region ?? null,
        host_machine: (row.metadata?.machine ??
          host_machine ??
          null) as HostMachine | null,
      });
  }
  return await getBackupConfigLocalInternal({
    host_id,
    project_id,
    host_region,
    host_machine,
  });
}

export async function getBackupConfigLocal({
  host_id,
  project_id,
  host_region,
  host_machine,
}: {
  host_id?: string;
  project_id?: string;
  host_region?: string | null;
  host_machine?: HostMachine | null;
}): Promise<{ toml: string; ttl_seconds: number }> {
  return await getBackupConfigLocalInternal({
    host_id,
    project_id,
    host_region,
    host_machine,
  });
}

export async function recordProjectBackup({
  host_id,
  project_id,
  time,
}: {
  host_id?: string;
  project_id: string;
  time: Date;
}): Promise<void> {
  if (!host_id) {
    throw new Error("host_id must be specified");
  }
  if (!project_id) {
    throw new Error("project_id must be specified");
  }
  const ownership = await resolveProjectBay(project_id);
  if (ownership?.bay_id && ownership.bay_id !== getConfiguredBayId()) {
    await getInterBayBridge()
      .hostConnection(ownership.bay_id)
      .recordProjectBackup({ host_id, project_id, time });
    return;
  }
  await recordProjectBackupLocalInternal({ host_id, project_id, time });
}

export async function recordProjectBackupLocal({
  host_id,
  project_id,
  time,
}: {
  host_id?: string;
  project_id: string;
  time: Date;
}): Promise<void> {
  await recordProjectBackupLocalInternal({ host_id, project_id, time });
}

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
  return await getManagedRootfsReleaseArtifactInternal({
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
  return await recordManagedRootfsReleaseReplicaInternal({ image, upload });
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
  return await listManagedRootfsReleaseLifecycleInternal({
    images: images ?? [],
  });
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
  env?: ProjectEnv;
}> {
  if (!host_id) {
    throw new Error("host_id must be specified");
  }
  if (!project_id) {
    throw new Error("project_id must be specified");
  }
  const local = await getProjectStartMetadataLocal({
    host_id,
    project_id,
    allowMissing: true,
  });
  if (local) {
    return local;
  }
  const ownership = await resolveProjectBay(project_id);
  if (ownership?.bay_id && ownership.bay_id !== getConfiguredBayId()) {
    return await getInterBayBridge()
      .hostConnection(ownership.bay_id)
      .getProjectStartMetadata({ host_id, project_id });
  }
  throw new Error(
    `project ${project_id} is not assigned to host ${host_id} or is unavailable`,
  );
}

export async function getProjectStartMetadataLocal({
  host_id,
  project_id,
  allowMissing = false,
}: {
  host_id?: string;
  project_id: string;
  allowMissing?: boolean;
}): Promise<{
  title?: string;
  users?: any;
  image?: string;
  authorized_keys?: string;
  run_quota?: any;
  env?: ProjectEnv;
} | null> {
  if (!host_id) {
    throw new Error("host_id must be specified");
  }
  if (!project_id) {
    throw new Error("project_id must be specified");
  }
  const { rows } = await pool().query(
    `SELECT title, users, rootfs_image AS image, run_quota, env
       FROM projects
      WHERE project_id=$1
        AND host_id=$2
        AND deleted IS NOT true
      LIMIT 1`,
    [project_id, host_id],
  );
  const row = rows[0];
  if (!row) {
    if (allowMissing) {
      return null;
    }
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
    env: row.env ?? undefined,
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
  actor,
  host_id,
  project_id,
  ttl_seconds,
}: {
  account_id?: string;
  actor?: "account" | "hub";
  host_id: string;
  project_id?: string;
  ttl_seconds?: number;
}): Promise<{
  host_id: string;
  token: string;
  expires_at: number;
}> {
  if (actor === "hub") {
    return await issueProjectHostHubAuthTokenInternalHelper({
      host_id,
      ttl_seconds,
    });
  }
  const owner = requireAccount(account_id);
  return await issueProjectHostAuthTokenLocalHelper({
    account_id: owner,
    host_id,
    project_id,
    ttl_seconds,
    loadHostForListing,
  });
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
  return await issueProjectHostAgentAuthTokenInternalHelper({
    host_id: resolvedHostId,
    account_id,
    project_id,
    ttl_seconds,
  });
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

type ListHostsOptions = {
  account_id?: string;
  admin_view?: boolean;
  include_deleted?: boolean;
  catalog?: boolean;
  show_all?: boolean;
};

export async function listHostsLocal({
  account_id,
  admin_view,
  include_deleted,
  catalog,
  show_all,
}: ListHostsOptions): Promise<Host[]> {
  const owner = requireAccount(account_id);
  if (admin_view && !(await isAdmin(owner))) {
    throw new Error("not authorized");
  }
  const filters: string[] = [];
  const params: any[] = [];
  if (!admin_view) {
    filters.push(
      `(metadata->>'owner' = $${params.length + 1}
        OR COALESCE(metadata->'collaborators', '[]'::jsonb) ? $${params.length + 1}
        OR tier IS NOT NULL)`,
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
  const runtimeExceptionSummaries = await loadHostRuntimeExceptionSummaries(
    visibleRows.map(({ row }) => row.id),
  );
  const runtimeDesiredArtifactSummaries =
    await loadHostRuntimeDesiredArtifactSummaries(
      visibleRows.map(({ row }) => row.id),
    );

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
        runtime_exception_summary: runtimeExceptionSummaries.get(row.id),
        runtime_desired_artifacts: runtimeDesiredArtifactSummaries.get(row.id),
      }),
  );
}

export async function listHosts(opts: ListHostsOptions): Promise<Host[]> {
  const local = await listHostsLocal(opts);
  const remoteHosts = await Promise.all(
    getConfiguredClusterBayIdsForStaticEnumerationOnly()
      .filter((bay_id) => bay_id !== getConfiguredBayId())
      .map(async (bay_id) => {
        try {
          return await getInterBayBridge().hostConnection(bay_id).list(opts);
        } catch (err) {
          logger.warn(
            `listHosts: failed to load hosts from remote bay ${bay_id} -- ${err}`,
          );
          return [];
        }
      }),
  );
  const deduped = new Map<string, Host>();
  for (const host of [...local, ...remoteHosts.flat()]) {
    deduped.set(host.id, preferredHostRow(deduped.get(host.id), host));
  }
  return Array.from(deduped.values());
}

function timestampMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function preferredHostRow(existing: Host | undefined, candidate: Host): Host {
  if (existing == null) return candidate;
  if (candidate.deleted && !existing.deleted) return candidate;
  if (existing.deleted && !candidate.deleted) return existing;
  const existingUpdated = timestampMs(existing.updated);
  const candidateUpdated = timestampMs(candidate.updated);
  if (candidateUpdated == null) return existing;
  if (existingUpdated == null) return candidate;
  return candidateUpdated > existingUpdated ? candidate : existing;
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
  return await resolveHostConnectionLocalHelper({
    account_id: owner,
    host_id,
    allowMissing,
    loadMembership,
  });
}

export async function listHostProjects({
  account_id,
  id,
  limit,
  cursor,
  risk_only,
  state_filter,
  project_state,
}: {
  account_id?: string;
  id: string;
  limit?: number;
  cursor?: string;
  risk_only?: boolean;
  state_filter?: HostProjectStateFilter;
  project_state?: string;
}): Promise<HostProjectsResponse> {
  const target = await resolveHostProjectListingTarget({ id, account_id });
  if (target.kind === "remote") {
    return await getInterBayBridge()
      .hostConnection(target.bay_id)
      .listHostProjects({
        account_id,
        id,
        limit,
        cursor,
        risk_only,
        state_filter,
        project_state,
      });
  }
  const { host } = target;
  const cappedLimit = normalizeHostProjectsLimit(limit);
  const snapshot = await listHostProjectsLocalSnapshot({
    id,
    risk_only,
    state_filter,
    project_state,
  });
  let rows = snapshot.rows.sort(compareHostProjectRows);
  if (cursor) {
    const decoded = decodeHostProjectsCursor(cursor);
    const cursorDate =
      decoded.last_edited == null
        ? null
        : normalizeDate(new Date(decoded.last_edited));
    if (decoded.last_edited != null && cursorDate == null) {
      throw new Error("invalid cursor timestamp");
    }
    rows = rows.filter((row) =>
      rowMatchesHostProjectsCursor(row, {
        project_id: decoded.project_id,
        last_edited: cursorDate,
      }),
    );
  }
  const trimmed = rows.slice(0, cappedLimit);

  let next_cursor: string | undefined;
  if (rows.length > cappedLimit && trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1];
    next_cursor = encodeHostProjectsCursor({
      project_id: last.project_id,
      last_edited: last.last_edited,
    });
  }

  return {
    rows: trimmed,
    summary: snapshot.summary,
    next_cursor,
    host_last_seen: normalizeDate(host.last_seen) ?? undefined,
  };
}

export async function listHostProjectsLocalSnapshot({
  id,
  risk_only,
  state_filter,
  project_state,
}: {
  id: string;
  risk_only?: boolean;
  state_filter?: HostProjectStateFilter;
  project_state?: string;
}): Promise<HostProjectsResponse> {
  const { params, filters, needsBackupSql } = buildHostProjectsBaseQuery({
    host_id: id,
    state_filter,
    project_state,
  });

  if (risk_only) {
    filters.push(`(${needsBackupSql})`);
  }

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
    `,
    params,
  );

  const summaryMap = await loadHostBackupStatus([id]);
  const summary = summaryMap.get(id) ?? {
    total: 0,
    provisioned: 0,
    running: 0,
    provisioned_up_to_date: 0,
    provisioned_needs_backup: 0,
  };

  const resultRows: HostProjectRow[] = rows.map((row) => ({
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
  };
}

const HOST_PROJECT_RUNNING_STATES_SQL = `COALESCE(state->>'state', '') IN ('running','starting')`;

function normalizeHostProjectStateFilter(
  state_filter?: HostProjectStateFilter,
): HostProjectStateFilter {
  const normalized = `${state_filter ?? "all"}`.trim().toLowerCase() || "all";
  if (
    normalized === "all" ||
    normalized === "running" ||
    normalized === "stopped" ||
    normalized === "unprovisioned"
  ) {
    return normalized;
  }
  throw new Error(
    "invalid state_filter; expected all, running, stopped, or unprovisioned",
  );
}

function buildHostProjectsBaseQuery({
  host_id,
  state_filter,
  project_state,
}: {
  host_id: string;
  state_filter?: HostProjectStateFilter;
  project_state?: string;
}) {
  const needsBackupSql = `
    ${HOST_PROJECT_RUNNING_STATES_SQL}
    OR (
      provisioned IS TRUE
      AND (
        last_backup IS NULL
        OR (last_edited IS NOT NULL AND last_edited > last_backup)
      )
    )
  `;
  const params: any[] = [host_id];
  const filters: string[] = ["deleted IS NOT true", "host_id = $1"];
  const normalizedStateFilter = normalizeHostProjectStateFilter(state_filter);

  if (normalizedStateFilter === "running") {
    filters.push(`(${HOST_PROJECT_RUNNING_STATES_SQL})`);
  } else if (normalizedStateFilter === "stopped") {
    filters.push(
      `(provisioned IS TRUE AND NOT (${HOST_PROJECT_RUNNING_STATES_SQL}))`,
    );
  } else if (normalizedStateFilter === "unprovisioned") {
    filters.push(`(provisioned IS NOT TRUE)`);
  }

  const normalizedProjectState = `${project_state ?? ""}`.trim();
  if (normalizedProjectState) {
    params.push(normalizedProjectState);
    filters.push(`(COALESCE(state->>'state', '') = $${params.length})`);
  }

  return {
    params,
    filters,
    needsBackupSql,
    normalizedStateFilter,
    normalizedProjectState,
  };
}

async function selectHostProjectActionRows({
  account_id,
  id,
  risk_only,
  state_filter,
  project_state,
}: {
  account_id?: string;
  id: string;
  risk_only?: boolean;
  state_filter?: HostProjectStateFilter;
  project_state?: string;
}): Promise<{
  host: Awaited<ReturnType<typeof loadHostForListing>>;
  state_filter: HostProjectStateFilter;
  project_state?: string;
  rows: Array<{ project_id: string; state: string }>;
}> {
  const target = await resolveHostProjectListingTarget({ id, account_id });
  const { normalizedStateFilter, normalizedProjectState } =
    buildHostProjectsBaseQuery({
      host_id: id,
      state_filter,
      project_state,
    });
  if (target.kind === "remote") {
    const rows: HostProjectRow[] = [];
    let cursor: string | undefined;
    do {
      const response = await getInterBayBridge()
        .hostConnection(target.bay_id)
        .listHostProjects({
          account_id,
          id,
          limit: HOST_PROJECTS_MAX_LIMIT,
          cursor,
          risk_only,
          state_filter,
          project_state,
        });
      rows.push(...response.rows);
      cursor = response.next_cursor;
    } while (cursor);
    return {
      host: { id },
      state_filter: normalizedStateFilter,
      project_state: normalizedProjectState || undefined,
      rows: rows.map((row) => ({
        project_id: row.project_id,
        state: row.state ?? "",
      })),
    };
  }

  const snapshot = await listHostProjectsLocalSnapshot({
    id,
    risk_only,
    state_filter,
    project_state,
  });
  const rows = snapshot.rows.sort(compareHostProjectRows);

  return {
    host: target.host,
    state_filter: normalizedStateFilter,
    project_state: normalizedProjectState || undefined,
    rows: rows.map((row) => ({
      project_id: row.project_id,
      state: row.state ?? "",
    })),
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

async function queueHostProjectsAction({
  kind,
  account_id,
  id,
  state_filter,
  project_state,
  risk_only,
  parallel,
}: {
  kind: "host-stop-projects" | "host-restart-projects";
  account_id?: string;
  id: string;
  state_filter?: HostProjectStateFilter;
  project_state?: string;
  risk_only?: boolean;
  parallel?: number;
}): Promise<HostLroResponse> {
  const {
    host,
    rows,
    state_filter: normalizedStateFilter,
  } = await selectHostProjectActionRows({
    account_id,
    id,
    state_filter,
    project_state,
    risk_only,
  });
  return await createHostLro({
    kind,
    row: host,
    account_id,
    input: {
      id: host.id,
      account_id,
      state_filter: normalizedStateFilter,
      project_state: `${project_state ?? ""}`.trim() || undefined,
      risk_only: !!risk_only,
      parallel,
      projects: rows,
    },
    dedupe_key: `${kind}:${host.id}:${normalizedStateFilter}:${`${project_state ?? ""}`.trim()}:${!!risk_only}`,
  });
}

export async function stopHostProjects({
  account_id,
  id,
  state_filter,
  project_state,
  risk_only,
  parallel,
}: {
  account_id?: string;
  id: string;
  state_filter?: HostProjectStateFilter;
  project_state?: string;
  risk_only?: boolean;
  parallel?: number;
}): Promise<HostLroResponse> {
  return await queueHostProjectsAction({
    kind: "host-stop-projects",
    account_id,
    id,
    state_filter,
    project_state,
    risk_only,
    parallel,
  });
}

export async function restartHostProjects({
  account_id,
  id,
  state_filter,
  project_state,
  risk_only,
  parallel,
}: {
  account_id?: string;
  id: string;
  state_filter?: HostProjectStateFilter;
  project_state?: string;
  risk_only?: boolean;
  parallel?: number;
}): Promise<HostLroResponse> {
  return await queueHostProjectsAction({
    kind: "host-restart-projects",
    account_id,
    id,
    state_filter,
    project_state,
    risk_only,
    parallel,
  });
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
    wait: true,
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
  source,
}: {
  account_id?: string;
  id: string;
  lines?: number;
  source?:
    | "project-host"
    | "conat-router"
    | "conat-persist"
    | "host-agent"
    | "supervision-events";
}): Promise<{ host_id: string; source: string; lines: number; text: string }> {
  await loadOwnedHost(id, account_id);
  const client = await hostControlClient(id);
  const response = await client.getRuntimeLog({
    lines: normalizeHostRuntimeLogLines(lines),
    source,
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
  user,
}: {
  account_id?: string;
  id: string;
  public_key: string;
  user?: string;
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
  const response = await client.addHostSshAuthorizedKey({ public_key, user });
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
  return await createHostInternalHelper({
    owner,
    name,
    region,
    size,
    gpu,
    pricing_model,
    interruption_restore_policy,
    machine,
    normalizeHostPricingModel,
    normalizeHostInterruptionRestorePolicy,
    defaultInterruptionRestorePolicy,
    parseRow,
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
  return await startHostInternalHelper({
    account_id,
    id,
    loadHostForStartStop,
    markHostActionPending,
    logStatusUpdate,
    parseRow,
  });
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
  return await stopHostInternalHelper({
    account_id,
    id,
    loadHostForStartStop,
    markHostActionPending,
    logStatusUpdate,
    parseRow,
  });
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
  return await restartHostInternalHelper({
    account_id,
    id,
    mode,
    loadHostForStartStop,
    markHostActionPending,
    logStatusUpdate,
    parseRow,
  });
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
  const row = await loadHostForDrainInternal({ id, owner });
  const destination = `${dest_host_id ?? ""}`.trim() || undefined;
  const drainParallel = await resolveDrainParallelInternal({
    owner,
    parallel,
    defaultParallel: HOST_DRAIN_DEFAULT_PARALLEL,
    ownerMaxParallel: HOST_DRAIN_OWNER_MAX_PARALLEL,
  });
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
  return await drainHostInternalHelper({
    owner,
    id,
    dest_host_id,
    force,
    allow_offline,
    parallel,
    defaultParallel: HOST_DRAIN_DEFAULT_PARALLEL,
    ownerMaxParallel: HOST_DRAIN_OWNER_MAX_PARALLEL,
    loadHostForListing,
    shouldCancel,
    onProgress,
  });
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

export async function ensureHostOwnerSshTrust({
  account_id,
  id,
}: {
  account_id?: string;
  id: string;
}) {
  return await ensureHostOwnerSshTrustInternal({
    account_id,
    host_id: id,
  });
}

export async function rehomeHost({
  account_id,
  id,
  dest_bay_id,
  reason,
  campaign_id,
}: {
  account_id?: string;
  id: string;
  dest_bay_id: string;
  reason?: string | null;
  campaign_id?: string | null;
}): Promise<HostRehomeResponse> {
  return await rehomeHostInternal({
    account_id,
    host_id: id,
    dest_bay_id,
    reason,
    campaign_id,
  });
}

export async function getHostRehomeOperation({
  account_id,
  op_id,
}: {
  account_id?: string;
  op_id: string;
}): Promise<HostRehomeOperationSummary | null> {
  const owner = requireAccount(account_id);
  if (!(await isAdmin(owner))) {
    throw new Error("not authorized");
  }
  return (await getHostRehomeOperationInternal(op_id)) ?? null;
}

export async function reconcileHostRehome({
  account_id,
  op_id,
}: {
  account_id?: string;
  op_id: string;
}): Promise<HostRehomeResponse> {
  return await reconcileHostRehomeInternal({
    account_id,
    op_id,
  });
}

export async function forceDeprovisionHostInternal({
  account_id,
  id,
}: {
  account_id?: string;
  id: string;
}): Promise<void> {
  await forceDeprovisionHostInternalHelper({
    account_id,
    id,
    loadOwnedHost,
    normalizeProviderId,
    markHostDeprovisionedInternal: async ({ row, action }) =>
      await markHostDeprovisioned(row, action),
  });
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
  await removeSelfHostConnectorInternalHelper({
    account_id,
    id,
    loadOwnedHost,
    normalizeProviderId,
    markHostDeprovisionedInternal: async ({ row, action }) =>
      await markHostDeprovisioned(row, action),
    revokeConnector,
  });
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
  align_runtime_stack,
}: {
  account_id?: string;
  id: string;
  targets: HostSoftwareUpgradeTarget[];
  base_url?: string;
  align_runtime_stack?: boolean;
}): Promise<HostLroResponse> {
  const row = await loadHostForStartStop(id, account_id);
  assertHostRunningForUpgrade(row);
  return await createHostLro({
    kind: HOST_UPGRADE_LRO_KIND,
    row,
    account_id,
    input: { id: row.id, account_id, targets, base_url, align_runtime_stack },
    dedupe_key: hostUpgradeDedupeKey({
      hostId: row.id,
      targets,
      baseUrl: base_url,
      alignRuntimeStack: align_runtime_stack,
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
  return await createHostLro({
    kind: HOST_RECONCILE_LRO_KIND,
    row,
    account_id,
    input: { id: row.id, account_id },
    dedupe_key: `${HOST_RECONCILE_LRO_KIND}:${row.id}`,
  });
}

function bootstrapLifecycleSummaryStatus(row: any): string | undefined {
  const summary = `${row?.metadata?.bootstrap_lifecycle?.summary_status ?? ""}`
    .trim()
    .toLowerCase();
  return summary || undefined;
}

function desiredSoftwareTargetsForReconcile(
  row: any,
): HostSoftwareUpgradeTarget[] {
  const software = row?.metadata?.software ?? {};
  const observed = new Map(
    observedRuntimeArtifactsFromMetadata(row).map((artifact) => [
      artifact.artifact,
      `${artifact.current_version ?? ""}`.trim() || undefined,
    ]),
  );
  const targets: HostSoftwareUpgradeTarget[] = [];
  const maybePush = (
    artifact: HostSoftwareArtifact,
    observedArtifact: HostRuntimeArtifact,
    desiredVersion?: string,
  ) => {
    const desired = `${desiredVersion ?? ""}`.trim();
    if (!desired) return;
    if ((observed.get(observedArtifact) ?? "") === desired) return;
    targets.push({ artifact, version: desired });
  };
  maybePush(
    "project-host",
    "project-host",
    `${software.project_host ?? row?.version ?? ""}`.trim() || undefined,
  );
  maybePush(
    "project",
    "project-bundle",
    `${software.project_bundle ?? ""}`.trim() || undefined,
  );
  maybePush("tools", "tools", `${software.tools ?? ""}`.trim() || undefined);
  return targets;
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

export async function getHostRuntimeDeploymentStatus({
  account_id,
  id,
}: {
  account_id?: string;
  id: string;
}): Promise<HostRuntimeDeploymentStatus> {
  const row = await loadHostForListing(id, account_id);
  return await getHostRuntimeDeploymentStatusInternal({
    id,
    row,
    running_statuses: HOST_RUNNING_STATUSES,
    hostControlClient,
  });
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
      await listRunningHostIdsForAutomaticRuntimeDeploymentReconcile({
        running_statuses: HOST_RUNNING_STATUSES,
      });
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
  return await ensureAutomaticHostRuntimeDeploymentsReconcileInternal({
    host_id,
    reason,
    running_statuses: HOST_RUNNING_STATUSES,
    loadHostRowForRuntimeDeploymentsInternal,
    getHostRuntimeDeploymentStatusInternal: ({ id, row }) =>
      getHostRuntimeDeploymentStatusInternal({
        id,
        row,
        running_statuses: HOST_RUNNING_STATUSES,
        hostControlClient,
      }),
    computeHostRuntimeDeploymentReconcilePlan,
    createHostLro,
    normalizeManagedComponentKindsForDedupe,
    reconcile_lro_kind: HOST_RECONCILE_RUNTIME_DEPLOYMENTS_LRO_KIND,
    automatic_reason: AUTOMATIC_RUNTIME_DEPLOYMENT_RECONCILE_REASON,
  });
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
  return await ensureAutomaticHostArtifactDeploymentsReconcileInternal({
    host_id,
    running_statuses: HOST_RUNNING_STATUSES,
    loadHostRowForRuntimeDeploymentsInternal,
    getHostRuntimeDeploymentStatusInternal: ({ id, row }) =>
      getHostRuntimeDeploymentStatusInternal({
        id,
        row,
        running_statuses: HOST_RUNNING_STATUSES,
        hostControlClient,
      }),
    computeAutomaticArtifactUpgradeTargets,
    createHostLro,
    hostUpgradeDedupeKey,
    upgrade_lro_kind: HOST_UPGRADE_LRO_KIND,
  });
}

async function bestEffortQueueAutomaticRuntimeDeploymentReconcileForHosts({
  host_ids,
  reason,
}: {
  host_ids: string[];
  reason?: string;
}): Promise<void> {
  await bestEffortQueueAutomaticRuntimeDeploymentReconcileForHostsInternal({
    host_ids,
    reason,
    ensureAutomaticHostRuntimeDeploymentsReconcile,
    logWarn: (message, payload) => logger.warn(message, payload),
  });
}

async function bestEffortQueueAutomaticArtifactDeploymentReconcileForHosts({
  host_ids,
}: {
  host_ids: string[];
}): Promise<void> {
  await bestEffortQueueAutomaticArtifactDeploymentReconcileForHostsInternal({
    host_ids,
    ensureAutomaticHostArtifactDeploymentsReconcile,
    logWarn: (message, payload) => logger.warn(message, payload),
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
  await upgradeHostConnectorInternalHelper({
    account_id,
    id,
    version,
    loadHostForStartStop,
    ensureSelfHostReverseTunnel,
    createPairingTokenForHost,
    getServerSettings,
    runConnectorInstallOverSsh,
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
  const availability = computeHostOperationalAvailability(row);
  let fallbackReason: string | undefined;

  if (availability.online) {
    try {
      const targets = desiredSoftwareTargetsForReconcile(row);
      const shouldRollManagedComponents = targets.some(
        (target) => target.artifact === "project-host",
      );
      const touchedHostControl =
        targets.length > 0 || shouldRollManagedComponents;
      const startedAt = touchedHostControl ? Date.now() : 0;
      if (targets.length > 0) {
        await upgradeHostSoftwareInternal({
          account_id,
          id,
          targets,
        });
      }
      if (shouldRollManagedComponents) {
        await rolloutHostManagedComponentsInternal({
          account_id,
          id,
          components: [
            "project-host",
            "conat-router",
            "conat-persist",
            "acp-worker",
          ],
          reason: "host_software_reconcile",
        });
      }
      let refreshedRow = row;
      if (touchedHostControl) {
        await waitForHostHeartbeatAfter({ host_id: id, since: startedAt });
        refreshedRow = await loadHostForStartStop(id, account_id);
      }
      if (bootstrapLifecycleSummaryStatus(refreshedRow) === "in_sync") {
        return;
      }
      fallbackReason =
        `${bootstrapLifecycleSummaryStatus(refreshedRow) ?? "unknown"}`.trim() ||
        "bootstrap_lifecycle_not_in_sync";
      logger.warn(
        "host software reconcile: runtime reconcile did not converge bootstrap lifecycle; falling back to ssh",
        {
          host_id: id,
          reason: fallbackReason,
        },
      );
    } catch (err) {
      fallbackReason = `${err}`;
      logger.warn(
        "host software reconcile: host-agent path failed; falling back to ssh",
        {
          host_id: id,
          err: `${err}`,
        },
      );
    }
  } else {
    fallbackReason = availability.reason_unavailable ?? "host_offline";
    logger.warn(
      "host software reconcile: host heartbeat is stale; using bootstrap reconcile fallback",
      {
        host_id: id,
        reason: fallbackReason,
      },
    );
  }

  assertCloudHostBootstrapReconcileSupported(row);
  await reconcileCloudHostBootstrapOverSsh({ host_id: id, row });
}

function assertHostRunningForUpgrade(row: any) {
  const status = String(row.status ?? "");
  if (status !== "active" && status !== "running") {
    throw new Error("host must be running to upgrade software");
  }
}

async function recordProjectHostLocalRollbackInternal({
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
  source: "host-agent";
}> {
  const row = await loadHostForStartStop(id, account_id);
  return await recordProjectHostLocalRollbackInternalHelper({
    row,
    requested_by: requestedByForRuntimeDeployments({ account_id, row }),
    version,
    reason,
  });
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
  return await rollbackProjectHostOverSshInternalHelper({
    row,
    requested_by: requestedByForRuntimeDeployments({ account_id, row }),
    version,
    reason,
    reconcileCloudHostBootstrapOverSsh,
  });
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
  return await reconcileHostRuntimeDeploymentsInternalHelper({
    account_id,
    id,
    components,
    reason,
    loadHostForStartStop,
    assertHostRunningForUpgrade,
    getHostRuntimeDeploymentStatus,
    computeHostRuntimeDeploymentReconcilePlan,
    rolloutHostManagedComponentsInternal,
  });
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
  return await rollbackHostRuntimeDeploymentsInternalHelper({
    account_id,
    id,
    target_type,
    target,
    version,
    last_known_good,
    reason,
    loadHostForStartStop,
    assertHostRunningForUpgrade,
    getHostRuntimeDeploymentStatus,
    targetKeyForRuntimeDeployment,
    resolveRollbackVersion,
    requestedByForRuntimeDeployments,
    setProjectHostRuntimeDeployments,
    upgradeHostSoftwareInternal,
    reconcileProjectHostComponent: async ({
      account_id,
      id,
      component,
      reason,
    }) =>
      await reconcileHostRuntimeDeploymentsInternal({
        account_id,
        id,
        components: [component],
        reason,
      }),
    rolloutProjectHostArtifact: async ({ account_id, id, reason }) =>
      (
        await rolloutHostManagedComponentsInternal({
          account_id,
          id,
          components: ["project-host"],
          reason,
        })
      ).results ?? [],
    rollbackProjectHostOverSsh: async ({ account_id, id, version, reason }) =>
      await rollbackProjectHostOverSshInternal({
        account_id,
        id,
        version,
        reason,
      }),
    assertCloudHostBootstrapReconcileSupported,
    reconcileCloudHostBootstrapOverSsh,
  });
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
  return await listHostSoftwareVersionsInternal({
    base_url,
    artifacts,
    channels,
    os,
    arch,
    history_limit,
  });
}

export async function upgradeHostSoftwareInternal({
  account_id,
  id,
  targets,
  base_url,
  align_runtime_stack,
}: {
  account_id?: string;
  id: string;
  targets: HostSoftwareUpgradeTarget[];
  base_url?: string;
  align_runtime_stack?: boolean;
}): Promise<HostSoftwareUpgradeResponse> {
  return await upgradeHostSoftwareInternalHelper({
    account_id,
    id,
    targets,
    base_url,
    align_runtime_stack,
    loadHostForStartStop,
    assertHostRunningForUpgrade,
    computeHostOperationalAvailability,
    resolveHostSoftwareBaseUrl,
    resolveReachableUpgradeBaseUrl,
    logWarn: (message, payload) => logger.warn(message, payload),
    reconcileCloudHostBootstrapOverSsh,
    hostControlClient,
    updateProjectHostSoftwareRecord: async ({ row, results }) => {
      const metadata = row.metadata ?? {};
      const software = { ...(metadata.software ?? {}) } as Record<
        string,
        string
      >;
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
    },
    runtimeDeploymentsForUpgradeResults,
    requestedByForRuntimeDeployments,
    setProjectHostRuntimeDeployments,
  });
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
  return await rolloutHostManagedComponentsInternalHelper({
    account_id,
    id,
    components,
    reason,
    loadHostForStartStop,
    assertHostRunningForUpgrade,
    hostControlClient,
    waitForHostHeartbeatAfter,
    installedProjectHostArtifactVersion,
    recordProjectHostLocalRollbackInternal,
    project_host_local_rollback_error_code:
      PROJECT_HOST_LOCAL_ROLLBACK_ERROR_CODE,
    setLastKnownGoodArtifactVersionInternal,
    runtimeDeploymentsForComponentRollout,
    requestedByForRuntimeDeployments,
    setProjectHostRuntimeDeployments,
  });
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
  await deleteHostInternalHelper({
    account_id,
    id,
    loadOwnedHost,
    normalizeProviderId,
    setHostDesiredStateInternal: async ({ id, desiredState }) =>
      await setHostDesiredState(id, desiredState),
    enqueueCloudVmWork: async (opts) => {
      await enqueueCloudVmWork(opts);
    },
    logStatusUpdate,
    markHostDeleted: async (id) => {
      await pool().query(
        `UPDATE project_hosts SET deleted=NOW(), updated=NOW() WHERE id=$1 AND deleted IS NULL`,
        [id],
      );
    },
    markHostDeprovisioning: async (id) => {
      await pool().query(
        `UPDATE project_hosts SET status=$2, updated=NOW() WHERE id=$1 AND deleted IS NULL`,
        [id, "deprovisioning"],
      );
    },
    markHostStoppedDeprovisioned: async (id) => {
      await pool().query(
        `UPDATE project_hosts
           SET status=$2,
               metadata=jsonb_set(COALESCE(metadata, '{}'::jsonb), '{desired_state}', to_jsonb($3::text)),
               updated=NOW()
         WHERE id=$1 AND deleted IS NULL`,
        [id, "deprovisioned", "stopped"],
      );
    },
  });
}
