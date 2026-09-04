import { hubApi } from "@cocalc/lite/hub/api";
import TTL from "@isaacs/ttlcache";
import { account_id } from "@cocalc/backend/data";
import { executeCode } from "@cocalc/backend/execute-code";
import { exists } from "@cocalc/backend/misc/async-utils-node";
import {
  deleteChatStoreData,
  getChatStoreStats,
  listChatStoreSegments,
  readChatStoreArchived,
  readChatStoreArchivedHit,
  rotateChatStore,
  searchChatStoreArchived,
  vacuumChatStore,
} from "@cocalc/backend/chat-store/sqlite-offload";
import { uuid, isValidUUID } from "@cocalc/util/misc";
import { projectRuntimeConfiguration } from "@cocalc/util/project-runtime";
import {
  deleteProjectLocal,
  getProject,
  getOrCreateProjectLocalSecretToken,
  markProjectStateReported,
  upsertProject,
} from "../sqlite/projects";
import {
  getCachedProjectSecretsForRuntime,
  getProjectSecretsCacheState,
  markProjectSecretsCacheMaterialized,
  syncProjectSecretsCache,
} from "../project-secrets-cache";
import {
  hasRecentProjectBrowserActivity,
  upsertProjectStopState,
} from "../sqlite/stop-policy";
import {
  type CreateProjectOptions,
  type ProjectState,
} from "@cocalc/util/db-schema/projects";
import type {
  ChatStoreArchivedRow,
  ChatStoreDeleteResult,
  ChatStoreRotateResult,
  ChatStoreScope,
  ChatStoreSearchHit,
  ChatStoreSegment,
  ChatStoreStats,
  ProjectEnv,
} from "@cocalc/conat/hub/api/projects";
import type { CodexUsageStatusInfo } from "@cocalc/conat/hub/api/system";
import type { MembershipEffectiveLimits } from "@cocalc/conat/hub/api/purchases";
import type { ProjectSecretsRuntimeCache } from "@cocalc/util/project-secrets";
import type { HostProjectStartMetadata } from "@cocalc/conat/project-host/api";
import type { client as projectRunnerClient } from "@cocalc/conat/project/runner/run";
import {
  getCodexAppServerAccountStatus,
  type CodexAppServerAccountStatus,
} from "@cocalc/ai/acp";
import {
  DEFAULT_PROJECT_IMAGE,
  PROJECT_IMAGE_PATH,
} from "@cocalc/util/db-schema/defaults";
import getLogger from "@cocalc/backend/logger";
import {
  getMasterConatClient,
  queueProjectProvisioned,
  reportProjectStateToMaster,
} from "../master-status";
import callHub from "@cocalc/conat/hub/call-hub";
import { secretsPath as sshProxySecretsPath } from "@cocalc/project-proxy/ssh-server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  writeManagedAuthorizedKeys,
  deleteVolume,
  getVolume,
  ensureVolume,
  getMountPoint,
  resetScratchVolume,
  resolveProjectContainerPath,
  ensureProjectVolumeIdentity,
  reconcileManagedProjectVolumeQuota,
} from "../file-server";
import { currentProjectVolumeLifecycleGeneration } from "../project-volume-lifecycle";
import { INTERNAL_SSH_CONFIG } from "@cocalc/conat/project/runner/constants";
import type { Configuration } from "@cocalc/conat/project/runner/types";
import { lroStreamName } from "@cocalc/conat/lro/names";
import {
  client as fileServerClient,
  type ManagedProjectEgressOverride,
  type RestoreMode,
  type RestoreStagingHandle,
  type SnapshotRestoreMode,
} from "@cocalc/conat/files/file-server";
import { SERVICE as PERSIST_SERVICE } from "@cocalc/conat/persist/util";
import { publishLroEvent, publishLroSummary } from "../lro/stream";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import { applyPendingCopies } from "../pending-copies";
import {
  markProjectLastChangedRunning,
  reportPendingProjectTouches,
  resetProjectLastChangedRunning,
} from "../last-edited";
import { getGeneration } from "@cocalc/file-server/btrfs/subvolume-snapshots";
import {
  startCodexDeviceAuth,
  getCodexDeviceAuthStatus,
  cancelCodexDeviceAuth,
} from "../codex/codex-device-auth";
import {
  getCodexSubscriptionIdentity,
  resolveCodexAuthRuntime,
  uploadSubscriptionAuthFile,
} from "../codex/codex-auth";
import { pushSubscriptionAuthToRegistry } from "../codex/codex-auth-registry";
import { clearProjectHostConatAuthCaches } from "../conat-auth";
import { rehydrateAcpAutomationsForProject } from "@cocalc/lite/hub/acp";
import { getImage } from "@cocalc/project-runner/run/podman";
import {
  imageCachePath,
  inspectFilePath,
} from "@cocalc/project-runner/run/rootfs-base";
import {
  assertValidRootfsImageName,
  isManagedRootfsImageName,
} from "@cocalc/util/rootfs-images";
import {
  pullRootfsCacheEntry,
  type RootfsCachePullProgress,
} from "../rootfs-cache";
import {
  prepareOciPullReservationEstimate,
  withOciPullReservationIfNeeded,
  type OciPullReservationEstimate,
} from "../storage-reservations";
import { getLocalHostId } from "../sqlite/hosts";
import { assertManagedRawNetworkStartAllowedBestEffort } from "../raw-network-egress";
import {
  acquireProjectPortLease,
  coolDownProjectPortOffset,
  getCoolingProjectPortOffsets,
  getProjectPortLease,
  getProjectPortLeaseByHttpPort,
  getProjectPortLeaseBySshPort,
  PROJECT_PORT_BIND_FAILURE_COOLDOWN_MS,
  projectPortOffsetFromHttpPort,
  projectPortOffsetFromSshPort,
} from "../sqlite/port-leases";
import {
  beginProjectHostActivity,
  endProjectHostActivity,
  noteProjectHostActivityProgress,
} from "../health-progress";
import { sandboxExec } from "@cocalc/project-runner/run/sandbox-exec";
import {
  ProjectDiskQuotaExceededError,
  assertProjectDiskQuotaStartAllowed,
  isProjectDiskQuotaStartBlocked,
} from "../project-start-quota";
import { normalizeRunQuota, runnerConfigFromQuota } from "../run-quota";
import { browserIdleTimeoutSeconds } from "../browser-runtime";
import {
  prepareProjectNetworkPolicy,
  projectNetworkPolicyFromRunQuota,
} from "../network-policy";
import { withBtrfsMutationContext } from "@cocalc/file-server/btrfs/operation-cache";
import {
  acceptProjectVolumeQuotaDesired,
  claimStoppedScratchVolumePreparations,
  getProjectVolumeQuota,
  invalidateProjectVolumeQuota,
  listStoppedScratchVolumePreparationBatch,
  markProjectVolumeQuotaFailed,
  markProjectVolumeQuotaResetComplete,
  projectVolumeQuotaIsApplied,
} from "../sqlite/volume-quotas";
import { getRecordedProjectVolumeIdentity } from "../sqlite/project-volumes";
import { effectiveProjectVolumeQuotaBytes } from "../sqlite/volume-quota-overrides";

const logger = getLogger("project-host:hub:projects");
const CODEX_DEVICE_AUTH_VERIFY_TIMEOUT_MS = 45_000;
export const PROJECT_RUNNER_RPC_TIMEOUT_MS = 60 * 60 * 1000;
const SYNTHETIC_RUNTIME_PROBE_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.COCALC_SYNTHETIC_RUNTIME_PROBE_TIMEOUT_MS) || 90_000,
);
const MB = 1_000_000;
const DEFAULT_MAX_BACKUPS_PER_PROJECT = 30;
const PROJECT_OWNER_LIMITS_CACHE_TTL_MS = 5 * 60_000;
const LRO_PUBLISH_RETRY_ATTEMPTS = 20;
const LRO_PUBLISH_RETRY_DELAY_MS = 500;
const LRO_PUBLISH_ATTEMPT_TIMEOUT_MS = 3000;
const RUNNER_START_PORT_RETRY_LIMIT = 5;
const BROWSER_RUNTIME_AUTOSTART_PRESENCE_MAX_AGE_MS = 2 * 60_000;
const RUNNER_START_PORT_RETRY_BASE_DELAY_MS = 250;
const OCCUPIED_PROJECT_PORT_CACHE_TTL_MS = 250;
const STOPPED_VOLUME_PREPARATION_SWEEP_MS = Math.max(
  10_000,
  Number(process.env.COCALC_STOPPED_VOLUME_PREPARATION_SWEEP_MS) || 60_000,
);
const STOPPED_VOLUME_PREPARATION_INITIAL_DELAY_MS = Math.max(
  1_000,
  Number(process.env.COCALC_STOPPED_VOLUME_PREPARATION_INITIAL_DELAY_MS) ||
    10_000,
);
const STOPPED_VOLUME_PREPARATION_BATCH_SIZE = Math.max(
  1,
  Math.min(
    32,
    Number(process.env.COCALC_STOPPED_VOLUME_PREPARATION_BATCH_SIZE) || 8,
  ),
);
const RECENT_FAILED_PROJECT_PORT_OFFSET_TTL_MS =
  PROJECT_PORT_BIND_FAILURE_COOLDOWN_MS;
const projectOwnerLimitsCache = new TTL<string, MembershipEffectiveLimits>({
  ttl: PROJECT_OWNER_LIMITS_CACHE_TTL_MS,
});
const projectOwnerLimitsInflight = new Map<
  string,
  Promise<MembershipEffectiveLimits>
>();
const accountLimitsCache = new TTL<string, MembershipEffectiveLimits>({
  ttl: PROJECT_OWNER_LIMITS_CACHE_TTL_MS,
});
const accountLimitsInflight = new Map<
  string,
  Promise<MembershipEffectiveLimits>
>();
const CODEX_MODEL_CATALOG_TTL_MS = 30 * 60_000;
type CachedCodexModelCatalog = {
  checkedAt: string;
  models: NonNullable<CodexUsageStatusInfo["models"]>;
};
const codexModelCatalogCache = new TTL<string, CachedCodexModelCatalog>({
  max: 10_000,
  ttl: CODEX_MODEL_CATALOG_TTL_MS,
});
const codexModelCatalogInflight = new Map<
  string,
  Promise<CodexAppServerAccountStatus>
>();
const codexModelCatalogGeneration = new Map<string, number>();

let occupiedProjectPortOffsetsCache:
  | {
      value: Set<number>;
      expiresAt: number;
    }
  | undefined;
let occupiedProjectPortOffsetsInflight: Promise<Set<number>> | undefined;
const recentFailedProjectPortOffsets = new Map<number, number>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listeningProjectPortOffset(port?: number | null): number | undefined {
  return (
    projectPortOffsetFromSshPort(port) ?? projectPortOffsetFromHttpPort(port)
  );
}

export function parseOccupiedPortOffsetsFromProcNet(raw: string): Set<number> {
  const offsets = new Set<number>();
  for (const line of raw.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 2) continue;
    const localAddress = fields[1] ?? "";
    const portHex = localAddress.split(":")[1];
    if (!portHex) continue;
    const port = Number.parseInt(portHex, 16);
    if (!Number.isFinite(port)) continue;
    const offset = listeningProjectPortOffset(port);
    if (offset != null) {
      offsets.add(offset);
    }
  }
  return offsets;
}

async function loadOccupiedProjectPortOffsetsUncached(): Promise<Set<number>> {
  const offsets = new Set<number>();
  for (const procPath of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      const raw = await readFile(procPath, "utf8");
      for (const offset of parseOccupiedPortOffsetsFromProcNet(raw)) {
        offsets.add(offset);
      }
    } catch (err) {
      logger.debug("unable to inspect occupied TCP ports", {
        procPath,
        err: `${err}`,
      });
    }
  }
  return offsets;
}

async function getOccupiedProjectPortOffsets(): Promise<Set<number>> {
  const now = Date.now();
  const cached = occupiedProjectPortOffsetsCache;
  if (cached && cached.expiresAt > now) {
    return new Set(cached.value);
  }
  if (occupiedProjectPortOffsetsInflight) {
    return new Set(await occupiedProjectPortOffsetsInflight);
  }
  occupiedProjectPortOffsetsInflight = (async () => {
    const value = await loadOccupiedProjectPortOffsetsUncached();
    occupiedProjectPortOffsetsCache = {
      value,
      expiresAt: Date.now() + OCCUPIED_PROJECT_PORT_CACHE_TTL_MS,
    };
    return value;
  })().finally(() => {
    occupiedProjectPortOffsetsInflight = undefined;
  });
  return new Set(await occupiedProjectPortOffsetsInflight);
}

function rememberRecentFailedProjectPortOffset(port?: number): void {
  const offset = listeningProjectPortOffset(port ?? undefined);
  if (offset == null) return;
  recentFailedProjectPortOffsets.set(
    offset,
    Date.now() + RECENT_FAILED_PROJECT_PORT_OFFSET_TTL_MS,
  );
}

function getRecentFailedProjectPortOffsets(): Set<number> {
  const now = Date.now();
  const offsets = new Set<number>();
  for (const [offset, expiresAt] of recentFailedProjectPortOffsets) {
    if (expiresAt <= now) {
      recentFailedProjectPortOffsets.delete(offset);
      continue;
    }
    offsets.add(offset);
  }
  return offsets;
}

export function resetPortBindStateForTesting(): void {
  recentFailedProjectPortOffsets.clear();
  occupiedProjectPortOffsetsCache = undefined;
  occupiedProjectPortOffsetsInflight = undefined;
}

export function resetCodexModelCatalogCacheForTesting(): void {
  codexModelCatalogCache.clear();
  codexModelCatalogInflight.clear();
  codexModelCatalogGeneration.clear();
}

function codexModelCatalogCacheKey(
  accountId: string,
  subscriptionId: string,
): string {
  return `${accountId}\0${subscriptionId}`;
}

function invalidateCodexModelCatalog(accountId: string): void {
  codexModelCatalogGeneration.set(
    accountId,
    (codexModelCatalogGeneration.get(accountId) ?? 0) + 1,
  );
  const prefix = `${accountId}\0`;
  for (const key of codexModelCatalogCache.keys()) {
    if (key.startsWith(prefix)) codexModelCatalogCache.delete(key);
  }
}

async function loadCodexModelCatalogStatus({
  dedupeKey,
  projectId,
  accountId,
  timeoutMs,
}: {
  dedupeKey?: string;
  projectId: string;
  accountId: string;
  timeoutMs: number;
}): Promise<CodexAppServerAccountStatus> {
  const pending = dedupeKey
    ? codexModelCatalogInflight.get(dedupeKey)
    : undefined;
  if (pending) return await pending;
  const load = getCodexAppServerAccountStatus({
    projectId,
    accountId,
    isolatedCodexHome: true,
    includeModels: true,
    timeoutMs,
  });
  if (!dedupeKey) return await load;
  codexModelCatalogInflight.set(dedupeKey, load);
  try {
    return await load;
  } finally {
    if (codexModelCatalogInflight.get(dedupeKey) === load) {
      codexModelCatalogInflight.delete(dedupeKey);
    }
  }
}

async function collectPortBindDiagnostics({
  project_id,
  ssh_port,
  http_port,
}: {
  project_id: string;
  ssh_port?: number;
  http_port?: number;
}): Promise<Record<string, unknown>> {
  const diagnostics: Record<string, unknown> = {
    lease: getProjectPortLease(project_id),
    conflicting_ssh_lease:
      Number.isInteger(ssh_port) && ssh_port
        ? getProjectPortLeaseBySshPort(Number(ssh_port))
        : undefined,
    conflicting_http_lease:
      Number.isInteger(http_port) && http_port
        ? getProjectPortLeaseByHttpPort(Number(http_port))
        : undefined,
  };
  try {
    const coolingOffsets = getCoolingProjectPortOffsets();
    diagnostics.cooling_offset_count = coolingOffsets.size;
    diagnostics.ssh_port_cooling =
      Number.isInteger(ssh_port) &&
      ssh_port &&
      coolingOffsets.has(listeningProjectPortOffset(Number(ssh_port)) ?? -1);
    diagnostics.http_port_cooling =
      Number.isInteger(http_port) &&
      http_port &&
      coolingOffsets.has(listeningProjectPortOffset(Number(http_port)) ?? -1);
  } catch (err) {
    diagnostics.cooling_offsets_error = `${err}`;
  }
  try {
    const occupiedOffsets = await getOccupiedProjectPortOffsets();
    diagnostics.occupied_offset_count = occupiedOffsets.size;
    diagnostics.ssh_port_occupied =
      Number.isInteger(ssh_port) &&
      ssh_port &&
      occupiedOffsets.has(listeningProjectPortOffset(Number(ssh_port)) ?? -1);
    diagnostics.http_port_occupied =
      Number.isInteger(http_port) &&
      http_port &&
      occupiedOffsets.has(listeningProjectPortOffset(Number(http_port)) ?? -1);
  } catch (err) {
    diagnostics.occupied_offsets_error = `${err}`;
  }
  try {
    const ports = [ssh_port, http_port].filter(
      (value): value is number =>
        typeof value === "number" && Number.isInteger(value) && value > 0,
    );
    if (ports.length) {
      const { stdout, stderr, exit_code } = await executeCode({
        command: "ss",
        args: ["-tan"],
        err_on_exit: false,
        verbose: false,
        timeout: 5,
      });
      const lines = `${stdout ?? ""}`
        .split("\n")
        .filter((line) =>
          ports.some((port) => line.includes(`:${port.toString()}`)),
        );
      diagnostics.socket_snapshot = {
        exit_code,
        stdout: lines.join("\n"),
        stderr: `${stderr ?? ""}`.trim(),
      };
    }
  } catch (err) {
    diagnostics.socket_snapshot_error = `${err}`;
  }
  return diagnostics;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  context: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timeout after ${timeoutMs}ms (${context})`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer != null) {
      clearTimeout(timer);
    }
  }
}

async function publishLroSummaryWithRetry({
  scope_type,
  scope_id,
  summary,
  context,
}: {
  scope_type: "project" | "host";
  scope_id: string;
  summary: LroSummary;
  context: string;
}): Promise<boolean> {
  for (let attempt = 1; attempt <= LRO_PUBLISH_RETRY_ATTEMPTS; attempt++) {
    try {
      await withTimeout(
        publishLroSummary({ scope_type, scope_id, summary }),
        LRO_PUBLISH_ATTEMPT_TIMEOUT_MS,
        context,
      );
      if (attempt > 1) {
        logger.info("lro summary publish recovered", {
          context,
          op_id: summary.op_id,
          attempt,
        });
      }
      return true;
    } catch (err) {
      logger.warn("lro summary publish failed", {
        context,
        op_id: summary.op_id,
        attempt,
        err: `${err}`,
      });
      if (attempt < LRO_PUBLISH_RETRY_ATTEMPTS) {
        await delay(LRO_PUBLISH_RETRY_DELAY_MS);
      }
    }
  }
  logger.warn("lro summary publish exhausted retries", {
    context,
    op_id: summary.op_id,
    attempts: LRO_PUBLISH_RETRY_ATTEMPTS,
  });
  return false;
}

export async function getProjectOwnerEffectiveLimits(
  project_id: string,
): Promise<MembershipEffectiveLimits> {
  const cached = projectOwnerLimitsCache.get(project_id);
  if (cached != null) {
    return cached;
  }
  const existing = projectOwnerLimitsInflight.get(project_id);
  if (existing != null) {
    return await existing;
  }
  const inflight = (async () => {
    const client = getMasterConatClient();
    const host_id = getLocalHostId();
    if (!client || !host_id) {
      return {};
    }
    try {
      const limits = await callHub({
        client,
        host_id,
        name: "hosts.getProjectOwnerEffectiveLimits",
        args: [{ project_id }],
      });
      const normalized =
        limits != null && typeof limits === "object"
          ? (limits as MembershipEffectiveLimits)
          : {};
      projectOwnerLimitsCache.set(project_id, normalized);
      return normalized;
    } catch (err) {
      logger.warn("unable to load project owner effective limits", {
        project_id,
        err: `${err}`,
      });
      return {};
    } finally {
      projectOwnerLimitsInflight.delete(project_id);
    }
  })();
  projectOwnerLimitsInflight.set(project_id, inflight);
  return await inflight;
}

export async function getAccountEffectiveLimits(
  account_id: string,
): Promise<MembershipEffectiveLimits> {
  const accountId = `${account_id ?? ""}`.trim();
  if (!accountId) {
    return {};
  }
  const cached = accountLimitsCache.get(accountId);
  if (cached != null) {
    return cached;
  }
  const existing = accountLimitsInflight.get(accountId);
  if (existing != null) {
    return await existing;
  }
  const inflight = (async () => {
    const client = getMasterConatClient();
    const host_id = getLocalHostId();
    if (!client || !host_id) {
      return {};
    }
    try {
      const limits = await callHub({
        client,
        host_id,
        name: "hosts.getAccountEffectiveLimits",
        args: [{ account_id: accountId }],
      });
      const normalized =
        limits != null && typeof limits === "object"
          ? (limits as MembershipEffectiveLimits)
          : {};
      accountLimitsCache.set(accountId, normalized);
      return normalized;
    } catch (err) {
      logger.warn("unable to load account effective limits", {
        account_id: accountId,
        err: `${err}`,
      });
      return {};
    } finally {
      accountLimitsInflight.delete(accountId);
    }
  })();
  accountLimitsInflight.set(accountId, inflight);
  return await inflight;
}

async function getProjectBackupLimit(project_id: string): Promise<number> {
  const limits = await getProjectOwnerEffectiveLimits(project_id);
  const limit = Number(limits.max_backups_per_project);
  return Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : DEFAULT_MAX_BACKUPS_PER_PROJECT;
}

let cachedProxyKey: string | undefined;
async function getSshProxyPublicKey(): Promise<string | undefined> {
  if (cachedProxyKey !== undefined) return cachedProxyKey;
  try {
    cachedProxyKey = await readFile(
      join(sshProxySecretsPath(), "id_ed25519.pub"),
      "utf8",
    );
  } catch (err) {
    logger.warn("unable to read ssh proxy public key", { err: `${err}` });
    cachedProxyKey = undefined;
  }
  return cachedProxyKey;
}

type RunnerApi = ReturnType<typeof projectRunnerClient>;
const syntheticRuntimeProbeProjects = new Set<string>();

function fileServer(_project_id: string) {
  const client = getMasterConatClient();
  if (!client) {
    throw new Error("master Conat client is not initialized");
  }
  return fileServerClient({ client });
}

function createPhaseTimingRecorder() {
  const phase_timings_ms: Record<string, number> = {};
  return {
    phase_timings_ms,
    async measure<T>(phase: string, fn: () => Promise<T>): Promise<T> {
      const started = Date.now();
      try {
        return await fn();
      } finally {
        phase_timings_ms[phase] = Date.now() - started;
      }
    },
    measureSync<T>(phase: string, fn: () => T): T {
      const started = Date.now();
      try {
        return fn();
      } finally {
        phase_timings_ms[phase] = Date.now() - started;
      }
    },
  };
}

// Preserve explicit rootfs/docker image names, but do not silently fall back
// when a user supplied an invalid image string. "ubuntu26.04" is not a valid
// OCI reference; use "ubuntu:26.04" instead.
function normalizeImage(image?: string): string {
  const trimmed = image?.trim();
  if (!trimmed) return DEFAULT_PROJECT_IMAGE;
  return assertValidRootfsImageName(trimmed);
}

type StartMetadata = {
  title?: string;
  users?: any;
  image?: string;
  authorized_keys?: string;
  run_quota?: any;
  run_quota_revision?: number;
  env?: ProjectEnv;
  autostart_enabled?: boolean | null;
  secrets?: Record<string, string>;
  secrets_generation?: number;
  project_secrets_cache?: ProjectSecretsRuntimeCache;
  secret_names?: string[];
};

type LocalProjectOptions = CreateProjectOptions & {
  users?: any;
  authorized_keys?: string;
  run_quota?: any;
  run_quota_revision?: number;
  local_only?: boolean;
  exam_run_id?: string;
  usage_account_id?: string;
  terminal_enabled?: boolean;
};

async function loadProjectStartMetadataFromMaster(
  project_id: string,
): Promise<StartMetadata | undefined> {
  const client = getMasterConatClient();
  const host_id = getLocalHostId();
  if (!client || !host_id) {
    return undefined;
  }
  return await callHub({
    client,
    host_id,
    name: "hosts.getProjectStartMetadata",
    args: [{ project_id }],
    timeout: 30_000,
  });
}

async function readPersistedCurrentImage(
  project_id: string,
): Promise<string | undefined> {
  try {
    const vol = await getVolume(project_id);
    const text = await readFile(
      join(vol.path, PROJECT_IMAGE_PATH, "current-image.txt"),
      "utf8",
    );
    const trimmed = text.trim();
    return trimmed ? normalizeImage(trimmed) : undefined;
  } catch {
    return undefined;
  }
}

async function resolveStartMetadata({
  project_id,
  authorized_keys,
  run_quota,
  run_quota_revision,
  image,
  autostart,
  start_metadata,
}: {
  project_id: string;
  authorized_keys?: string;
  run_quota?: any;
  run_quota_revision?: number;
  image?: string;
  autostart?: boolean;
  start_metadata?: HostProjectStartMetadata;
}): Promise<StartMetadata> {
  const existing = getProject(project_id);
  const cachedSecretNames = (existing as any)?.secret_names;
  const cachedSecretsState = getProjectSecretsCacheState(project_id);
  let cachedSecrets: Record<string, string> | undefined;
  if (Array.isArray(cachedSecretNames)) {
    if (cachedSecretNames.length === 0) {
      cachedSecrets = {};
    } else {
      const loaded = getCachedProjectSecretsForRuntime({ project_id });
      const loadedNames = loaded == null ? [] : Object.keys(loaded).sort();
      const expectedNames = [...cachedSecretNames].sort();
      if (
        loaded != null &&
        loadedNames.length === expectedNames.length &&
        loadedNames.every((name, i) => name === expectedNames[i])
      ) {
        cachedSecrets = loaded;
      }
    }
  }
  let resolved: StartMetadata = {
    authorized_keys: authorized_keys ?? existing?.authorized_keys ?? undefined,
    run_quota: run_quota ?? (existing as any)?.run_quota,
    run_quota_revision:
      run_quota_revision ?? (existing as any)?.run_quota_revision,
    image: image ?? existing?.image ?? undefined,
    env: (existing as any)?.env,
    autostart_enabled: (existing as any)?.autostart_enabled,
    secrets: cachedSecrets,
    secrets_generation: cachedSecretsState.cached_generation,
    secret_names: cachedSecretNames,
  };
  const needsMaster =
    !resolved.image ||
    resolved.authorized_keys == null ||
    resolved.run_quota == null ||
    resolved.env == null ||
    resolved.secrets == null ||
    (autostart && resolved.autostart_enabled == null) ||
    !existing?.title;
  if (needsMaster || start_metadata != null) {
    try {
      const authoritative: StartMetadata | undefined =
        start_metadata ??
        (await loadProjectStartMetadataFromMaster(project_id));
      if (authoritative) {
        let secrets = authoritative.secrets;
        let secret_names =
          authoritative.secrets == null
            ? undefined
            : Object.keys(authoritative.secrets).sort();
        let secrets_generation = resolved.secrets_generation;
        if (authoritative.project_secrets_cache != null) {
          const synced = syncProjectSecretsCache({
            project_id,
            cache: authoritative.project_secrets_cache,
          });
          secret_names = synced.secret_names;
          secrets_generation = synced.cached_generation;
          secrets = getCachedProjectSecretsForRuntime({ project_id }) ?? {};
        }
        resolved = {
          title: authoritative.title ?? existing?.title,
          users: authoritative.users,
          image: resolved.image ?? authoritative.image ?? undefined,
          authorized_keys:
            resolved.authorized_keys ?? authoritative.authorized_keys,
          run_quota: resolved.run_quota ?? authoritative.run_quota,
          run_quota_revision:
            resolved.run_quota_revision ?? authoritative.run_quota_revision,
          env: resolved.env ?? authoritative.env,
          autostart_enabled:
            authoritative.autostart_enabled ?? resolved.autostart_enabled,
          secrets: secrets ?? resolved.secrets,
          secrets_generation,
          secret_names,
        };
      }
    } catch (err) {
      logger.warn("resolveStartMetadata: master lookup failed", {
        project_id,
        err: `${err}`,
      });
    }
  }
  if (!resolved.image) {
    resolved.image = await readPersistedCurrentImage(project_id);
    if (resolved.image) {
      logger.warn(
        "resolveStartMetadata: using persisted current-image.txt because local and master image metadata were unavailable",
        { project_id, image: resolved.image },
      );
    }
  }
  if (!resolved.image) {
    throw new Error(
      `unable to determine project image for ${project_id}; refusing to fall back to the default image`,
    );
  }
  if (
    resolved.secrets == null &&
    Array.isArray(cachedSecretNames) &&
    cachedSecretNames.length > 0
  ) {
    throw new Error(
      `unable to load project secrets for ${project_id}; refusing to start without configured secrets`,
    );
  }
  resolved.image = normalizeImage(resolved.image);
  return resolved;
}

export function ensureProjectRow({
  project_id,
  opts,
  state = "opened",
  http_port,
  ssh_port,
  project_bundle_version,
  tools_version,
  authorized_keys,
  secret_names,
  runtime_exit_reason,
}: {
  project_id: string;
  opts?: LocalProjectOptions;
  state?: string;
  http_port?: number | null;
  ssh_port?: number | null;
  project_bundle_version?: string | null;
  tools_version?: string | null;
  authorized_keys?: string;
  secret_names?: string[];
  runtime_exit_reason?: ProjectState["runtime_exit_reason"];
}) {
  logger.debug("ensureProjectRow", {
    project_id,
    opts,
    state,
    http_port,
    ssh_port,
    authorized_keys,
  });
  const now = Date.now();
  const row: any = {
    project_id,
    state,
    state_updated_at: now,
    updated_at: now,
    last_seen: now,
  };
  if (runtime_exit_reason != null) {
    row.runtime_exit_reason = runtime_exit_reason;
  }
  const run_quota = normalizeRunQuota((opts as any)?.run_quota);
  if (run_quota) {
    row.run_quota = run_quota;
    row.run_quota_revision = (opts as any)?.run_quota_revision;
    if (run_quota.disk_quota != null) {
      const disk = Math.floor(run_quota.disk_quota * MB);
      row.disk = disk;
      row.scratch = disk;
    }
  }
  const hasExplicitHttpPort = Object.prototype.hasOwnProperty.call(
    arguments[0] ?? {},
    "http_port",
  );
  const hasExplicitSshPort = Object.prototype.hasOwnProperty.call(
    arguments[0] ?? {},
    "ssh_port",
  );
  const hasExplicitProjectBundleVersion = Object.prototype.hasOwnProperty.call(
    arguments[0] ?? {},
    "project_bundle_version",
  );
  const hasExplicitToolsVersion = Object.prototype.hasOwnProperty.call(
    arguments[0] ?? {},
    "tools_version",
  );
  if (hasExplicitHttpPort) {
    row.http_port = http_port ?? null;
  } else if (state !== "running") {
    row.http_port = null;
  }
  if (hasExplicitSshPort) {
    row.ssh_port = ssh_port ?? null;
  } else if (state !== "running") {
    row.ssh_port = null;
  }
  if (hasExplicitProjectBundleVersion) {
    row.project_bundle_version = project_bundle_version ?? null;
  } else if (state !== "running") {
    row.project_bundle_version = null;
  }
  if (hasExplicitToolsVersion) {
    row.tools_version = tools_version ?? null;
  } else if (state !== "running") {
    row.tools_version = null;
  }
  if (authorized_keys !== undefined) {
    row.authorized_keys = authorized_keys;
  }
  if (secret_names !== undefined) {
    row.secret_names = secret_names;
  }
  if (opts) {
    const title = opts.title?.trim();
    if (title) {
      row.title = title;
    }
    if (opts.image !== undefined) {
      row.image = normalizeImage(opts.image);
    }
    if ((opts as any)?.users !== undefined) {
      row.users = (opts as any).users;
      // [ ] TODO -- for now we always included the default user;
      // this is obviously temporary
      row.users[account_id] = { group: "owner" };
    }
    row.local_only = opts.local_only === true;
    row.exam_run_id = opts.exam_run_id ?? null;
    row.usage_account_id = opts.usage_account_id ?? null;
    row.terminal_enabled = opts.terminal_enabled === true;
  }
  upsertProject(row);
  if (state) {
    if (
      syntheticRuntimeProbeProjects.has(project_id) ||
      opts?.local_only === true ||
      getProject(project_id)?.local_only === true
    ) {
      markProjectStateReported(project_id, state);
    } else {
      reportProjectStateToMaster(project_id, {
        state: state as any,
        time: new Date(now),
        ...(runtime_exit_reason == null ? {} : { runtime_exit_reason }),
      });
    }
  }
}

export async function getProjectRuntimeStatus({
  runnerApi,
  project_id,
}: {
  runnerApi: RunnerApi;
  project_id: string;
}) {
  return await runnerApi.status({ project_id });
}

async function getRunnerConfig(
  project_id: string,
  resolved: Pick<
    StartMetadata,
    | "image"
    | "authorized_keys"
    | "run_quota"
    | "env"
    | "secrets"
    | "secrets_generation"
  >,
  opts?: {
    restore?: "none" | "auto" | "recover" | "required";
    restore_backup_id?: string;
    lro_op_id?: string;
    rotate_ports?: boolean;
    avoid_port_offsets?: Iterable<number>;
    storage_quota_prepared?: boolean;
    scratch_prepared?: boolean;
  },
) {
  const run_quota = normalizeRunQuota(resolved.run_quota);
  const limits = runnerConfigFromQuota(run_quota);
  const existing = getProject(project_id);
  const disk = limits.disk ?? existing?.disk;
  const scratch = limits.scratch ?? existing?.scratch;
  const ssh_proxy_public_key = await getSshProxyPublicKey();
  const secret = getOrCreateProjectLocalSecretToken(project_id);
  const avoidOffsets = getRecentFailedProjectPortOffsets();
  for (const offset of opts?.avoid_port_offsets ?? []) {
    if (Number.isInteger(offset)) {
      avoidOffsets.add(Number(offset));
    }
  }
  const ports = acquireProjectPortLease(project_id, {
    rotate: opts?.rotate_ports,
    avoidOffsets,
  });
  return {
    image: resolved.image,
    ssh_port: ports.ssh_port,
    http_port: ports.http_port,
    secret,
    authorized_keys: resolved.authorized_keys,
    ssh_proxy_public_key,
    run_quota,
    env: resolved.env ?? undefined,
    secrets: resolved.secrets ?? undefined,
    secrets_generation: resolved.secrets_generation,
    restore: opts?.restore,
    restore_backup_id: opts?.restore_backup_id,
    lro_op_id: opts?.lro_op_id,
    storage_quota_prepared: opts?.storage_quota_prepared,
    scratch_prepared: opts?.scratch_prepared,
    ...limits,
    disk,
    scratch,
  };
}

async function ensureManagedRootfsCached(
  config?: Configuration,
  onProgress?: (update: RootfsCachePullProgress) => void,
): Promise<void> {
  const image = getImage(config);
  if (!isManagedRootfsImageName(image)) {
    return;
  }
  await pullRootfsCacheEntry(image, {
    onProgress,
    awaitRegionalReplication: false,
  });
}

async function startRunnerWithStorageReservation<T>({
  project_id,
  image,
  op_id,
  onProgress,
  preparedEstimate,
  fn,
}: {
  project_id: string;
  image: string;
  op_id?: string;
  onProgress?: (update: {
    message: string;
    detail?: Record<string, any>;
  }) => void;
  preparedEstimate?: Promise<OciPullReservationEstimate | undefined>;
  fn: () => Promise<T>;
}): Promise<T> {
  if (isManagedRootfsImageName(image)) {
    return await fn();
  }
  const cached =
    (await exists(imageCachePath(image))) &&
    (await exists(inspectFilePath(image)));
  if (cached) {
    return await fn();
  }
  return await withOciPullReservationIfNeeded({
    image,
    project_id,
    op_id,
    preparedEstimate: await preparedEstimate,
    onProgress: (estimate) =>
      onProgress?.({
        message: "reserving host storage for OCI image pull",
        detail: estimate,
      }),
    fn,
  });
}

function requestedDiskQuotaBytes(run_quota?: any): number | undefined {
  const value = Number(normalizeRunQuota(run_quota)?.disk_quota);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value * MB);
}

function projectQuotaLedgerMode(): "off" | "observe" | "enforce" {
  switch (
    `${process.env.COCALC_PROJECT_QUOTA_LEDGER_MODE ?? "observe"}`
      .trim()
      .toLowerCase()
  ) {
    case "off":
      return "off";
    case "enforce":
      return "enforce";
    default:
      return "observe";
  }
}

function isMissingProjectHomeVolumeError(err: unknown): boolean {
  const text = `${(err as any)?.message ?? err ?? ""}`.toLowerCase();
  return text.includes("project volume does not exist");
}

async function getOrEnsureProjectHomeVolume(project_id: string) {
  try {
    return await getVolume(project_id);
  } catch (err) {
    if (!isMissingProjectHomeVolumeError(err)) {
      throw err;
    }
    logger.info("creating missing project volume during start", {
      project_id,
    });
    return await ensureVolume(project_id, undefined, {
      reportProvisioned: false,
    });
  }
}

async function assertStartDiskQuotaAllowed({
  project_id,
  run_quota,
  run_quota_revision,
  reset_scratch = false,
  scratch_lifecycle_generation,
  record_timing,
}: {
  project_id: string;
  run_quota?: any;
  run_quota_revision?: number;
  reset_scratch?: boolean;
  scratch_lifecycle_generation?: number;
  record_timing?: (phase: string, duration_ms: number) => void;
}): Promise<{
  storage_quota_prepared: boolean;
  scratch_prepared: boolean;
}> {
  const requestedDiskBytes = requestedDiskQuotaBytes(run_quota);
  if (requestedDiskBytes == null) {
    await assertProjectDiskQuotaStartAllowed({
      project_id,
      logger,
      getQuota: async (id) => {
        const vol = await getOrEnsureProjectHomeVolume(id);
        return await vol.quota.get();
      },
    });
    return {
      storage_quota_prepared: false,
      scratch_prepared: false,
    };
  }

  // Persist versioned desired state before consulting the durable ledger.
  // This repairs ledgers bootstrapped from stale legacy disk/scratch columns,
  // while upsertProject still rejects genuinely different run_quota JSON at
  // the same revision.
  if (run_quota_revision != null) {
    upsertProject({ project_id, run_quota, run_quota_revision });
  }

  const ledgerMode = projectQuotaLedgerMode();
  const reconcile = async ({
    volume_kind,
    desired_bytes,
    reset,
  }: {
    volume_kind: "home" | "scratch";
    desired_bytes: number;
    reset?: boolean;
  }): Promise<boolean> => {
    let resetVolume: Awaited<ReturnType<typeof resetScratchVolume>> | undefined;
    if (ledgerMode === "enforce" && volume_kind === "scratch" && reset) {
      resetVolume =
        scratch_lifecycle_generation == null
          ? await resetScratchVolume(project_id, {
              onTiming: (phase, duration_ms) =>
                record_timing?.(`scratch_reset.${phase}`, duration_ms),
            })
          : await resetScratchVolume(project_id, {
              expected_lifecycle_generation: scratch_lifecycle_generation,
              onTiming: (phase, duration_ms) =>
                record_timing?.(`scratch_reset.${phase}`, duration_ms),
            });
    }
    const acceptance = acceptProjectVolumeQuotaDesired({
      project_id,
      volume_kind,
      desired_bytes,
      desired_revision: run_quota_revision,
    });
    const desired = acceptance.row;
    const effective = effectiveProjectVolumeQuotaBytes({
      project_id,
      volume_kind,
      persistent_bytes: desired.desired_bytes,
    });
    const targetDiskBytes = effective.effective_bytes;
    let volumeIdentity = getRecordedProjectVolumeIdentity(
      project_id,
      volume_kind,
    );
    if (
      ledgerMode === "enforce" &&
      effective.overrides.length === 0 &&
      acceptance?.status !== "stale" &&
      projectVolumeQuotaIsApplied(desired, {
        volume_identity: volumeIdentity,
      })
    ) {
      logger.debug("project disk quota ledger fast path", {
        project_id,
        volume_kind,
        requested_size: targetDiskBytes,
        desired_revision: desired.desired_revision,
      });
      return true;
    }
    try {
      const vol =
        resetVolume ??
        (volume_kind === "home"
          ? await getOrEnsureProjectHomeVolume(project_id)
          : await getVolume(project_id, true));
      volumeIdentity = await ensureProjectVolumeIdentity(
        project_id,
        volume_kind === "scratch",
      );
      // A freshly recreated scratch subvolume is empty and has no limit. A
      // physical qgroup read here adds no safety, but can block for seconds
      // while Btrfs quota accounting catches up after I/O pressure.
      const quota = resetVolume ? { used: 0, size: 0 } : await vol.quota.get();
      if (
        isProjectDiskQuotaStartBlocked({
          used: quota.used,
          size: targetDiskBytes,
        })
      ) {
        if (desired) {
          markProjectVolumeQuotaFailed({
            project_id,
            volume_kind,
            state: "blocked",
            error: `quota usage ${quota.used} exceeds desired limit ${targetDiskBytes}`,
          });
        }
        throw new ProjectDiskQuotaExceededError({
          used: quota.used,
          size: targetDiskBytes,
        });
      }
      const currentSize = Number(quota.size);
      if (
        !Number.isFinite(currentSize) ||
        currentSize <= 0 ||
        targetDiskBytes !== currentSize
      ) {
        logger.info("reconciled project disk quota before start", {
          project_id,
          volume_kind,
          previous_size: quota.size,
          requested_size: targetDiskBytes,
          used: quota.used,
        });
      }
      await reconcileManagedProjectVolumeQuota({
        project_id,
        volume_kind,
        operation_class: "project_volume_prepare",
        priority: "lifecycle",
        ...(resetVolume != null ? { force_write: true } : undefined),
      });
      return ledgerMode === "enforce";
    } catch (err) {
      if (err instanceof ProjectDiskQuotaExceededError) {
        throw err;
      }
      if (desired) {
        markProjectVolumeQuotaFailed({
          project_id,
          volume_kind,
          error: err,
        });
      }
      logger.warn("unable to reconcile project disk quota before start", {
        project_id,
        volume_kind,
        requested_size: targetDiskBytes,
        err: `${err}`,
      });
      if (ledgerMode === "enforce") {
        throw err;
      }
      return false;
    }
  };

  const homePrepared = await reconcile({
    volume_kind: "home",
    desired_bytes: requestedDiskBytes,
  });
  const scratchLimit = runnerConfigFromQuota(
    normalizeRunQuota(run_quota),
  ).scratch;
  if (scratchLimit === 0) {
    return {
      storage_quota_prepared: homePrepared,
      scratch_prepared: true,
    };
  }
  const requestedScratchBytes =
    Number.isFinite(Number(scratchLimit)) && Number(scratchLimit) > 0
      ? Math.floor(Number(scratchLimit))
      : requestedDiskBytes;
  const scratchPrepared = await reconcile({
    volume_kind: "scratch",
    desired_bytes: requestedScratchBytes,
    reset: reset_scratch,
  });
  if (ledgerMode === "enforce" && reset_scratch && scratchPrepared) {
    const desired = getProjectVolumeQuota(project_id, "scratch");
    if (
      desired == null ||
      !markProjectVolumeQuotaResetComplete({
        project_id,
        desired_revision: desired.desired_revision,
      })
    ) {
      throw new Error(
        `scratch reset attestation changed while preparing project ${project_id}`,
      );
    }
  }
  return {
    storage_quota_prepared: homePrepared && scratchPrepared,
    scratch_prepared:
      ledgerMode === "enforce" && (!reset_scratch || scratchPrepared),
  };
}

function publishStartProgress({
  activity_id,
  project_id,
  op_id,
  phase,
  progress,
  message,
  detail,
}: {
  activity_id?: string;
  project_id: string;
  op_id: string;
  phase: string;
  progress: number;
  message: string;
  detail?: any;
}): void {
  if (activity_id) {
    noteProjectHostActivityProgress(activity_id);
  }
  void publishLroEvent({
    scope_type: "project",
    scope_id: project_id,
    op_id,
    event: {
      type: "progress",
      ts: Date.now(),
      phase,
      message,
      progress,
      detail,
    },
  }).catch(() => {});
}

function scaleStartCacheProgress(progress?: number): number {
  if (!Number.isFinite(progress)) {
    return 25;
  }
  const clamped = Math.max(0, Math.min(100, Math.round(progress ?? 0)));
  return 25 + Math.round((clamped * 55) / 100);
}

function safeStringifyErrorValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return `${value ?? ""}`;
  }
}

function collectErrorText(
  value: unknown,
  parts: string[],
  seen: Set<unknown>,
): void {
  if (value == null || seen.has(value)) return;
  if (typeof value === "string") {
    parts.push(value);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    parts.push(String(value));
    return;
  }
  if (value instanceof Error) {
    const rendered = `${value}`.trim();
    if (rendered) {
      parts.push(rendered);
    }
    if (value.message) {
      parts.push(value.message);
    }
    if (value.stack) {
      parts.push(value.stack);
    }
    seen.add(value);
    const record = value as unknown as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(record)) {
      collectErrorText(record[key], parts, seen);
    }
    return;
  }
  if (Array.isArray(value)) {
    seen.add(value);
    for (const nested of value) {
      collectErrorText(nested, parts, seen);
    }
    return;
  }
  if (typeof value === "object") {
    seen.add(value);
    parts.push(safeStringifyErrorValue(value));
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collectErrorText(nested, parts, seen);
    }
    return;
  }
  parts.push(`${value ?? ""}`);
}

function errorSearchText(err: unknown): string {
  const parts: string[] = [];
  collectErrorText(err, parts, new Set<unknown>());
  return parts.join("\n").toLowerCase();
}

function isRetryableRunnerPortBindError(err: unknown): boolean {
  const text = errorSearchText(err);
  return (
    text.includes("address already in use") ||
    text.includes("failed to bind port") ||
    text.includes("port is already allocated")
  );
}

async function startRunnerWithPortRetry({
  project_id,
  initialConfig,
  buildRetryConfig,
  startRunner,
}: {
  project_id: string;
  initialConfig: Configuration;
  buildRetryConfig: (opts: {
    avoid_port_offsets: Iterable<number>;
  }) => Promise<Configuration>;
  startRunner: (config: Configuration) => Promise<any>;
}): Promise<{ config: Configuration; status: any }> {
  let config = initialConfig;
  const failedOffsets = new Set<number>();
  for (
    let attempt = 1;
    attempt <= RUNNER_START_PORT_RETRY_LIMIT;
    attempt += 1
  ) {
    try {
      const status = await startRunner(config);
      return { config, status };
    } catch (err) {
      const retryable = isRetryableRunnerPortBindError(err);
      const diagnostics =
        retryable ||
        Number.isInteger(config.ssh_port) ||
        Number.isInteger(config.http_port)
          ? await collectPortBindDiagnostics({
              project_id,
              ssh_port: config.ssh_port,
              http_port: config.http_port,
            })
          : undefined;
      if (!retryable || attempt >= RUNNER_START_PORT_RETRY_LIMIT) {
        logger.warn("runner start failed", {
          project_id,
          attempt,
          retryable,
          ssh_port: config.ssh_port,
          http_port: config.http_port,
          diagnostics,
          err: `${err}`,
        });
        throw err;
      }
      logger.warn(
        "runner start hit retryable port bind error; rotating host ports",
        {
          project_id,
          attempt,
          ssh_port: config.ssh_port,
          http_port: config.http_port,
          diagnostics,
          err: `${err}`,
        },
      );
      const sshOffset = listeningProjectPortOffset(config.ssh_port);
      if (sshOffset != null) {
        failedOffsets.add(sshOffset);
        coolDownProjectPortOffset(sshOffset);
      }
      const httpOffset = listeningProjectPortOffset(config.http_port);
      if (httpOffset != null) {
        failedOffsets.add(httpOffset);
        coolDownProjectPortOffset(httpOffset);
      }
      rememberRecentFailedProjectPortOffset(config.ssh_port);
      rememberRecentFailedProjectPortOffset(config.http_port);
      config = await buildRetryConfig({
        avoid_port_offsets: failedOffsets,
      });
      await delay(RUNNER_START_PORT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
  throw new Error(`runner start retries exhausted for project ${project_id}`);
}

export function wireProjectsApi(runnerApi: RunnerApi) {
  type SyntheticRuntimeProbeResult = {
    project_id: string;
    started_at: string;
    finished_at: string;
    duration_ms: number;
  };
  let syntheticRuntimeProbeInFlight:
    | {
        started_at: number;
        promise: Promise<SyntheticRuntimeProbeResult>;
      }
    | undefined;
  type StoppedVolumePreparationResult = {
    prepared: boolean;
    phase_timings_ms: Record<string, number>;
  };
  const stoppedVolumePreparationInFlight = new Map<
    string,
    Promise<StoppedVolumePreparationResult>
  >();

  function scratchVolumeQuotaIsPrepared(project_id: string): boolean {
    const row = getProjectVolumeQuota(project_id, "scratch");
    return (
      row != null &&
      projectVolumeQuotaIsApplied(row, {
        volume_identity: getRecordedProjectVolumeIdentity(
          project_id,
          "scratch",
        ),
      })
    );
  }

  function scheduleStoppedVolumePreparation(
    project_id: string,
    { invalidate = true }: { invalidate?: boolean } = {},
  ): Promise<StoppedVolumePreparationResult> | undefined {
    if (
      projectQuotaLedgerMode() !== "enforce" ||
      syntheticRuntimeProbeProjects.has(project_id)
    ) {
      return undefined;
    }
    const project = getProject(project_id);
    if (
      project == null ||
      requestedDiskQuotaBytes(project.run_quota) == null ||
      runnerConfigFromQuota(normalizeRunQuota(project.run_quota)).scratch === 0
    ) {
      if (!invalidate) {
        markProjectVolumeQuotaFailed({
          project_id,
          volume_kind: "scratch",
          error:
            "stopped scratch preparation no longer has applicable project quota metadata",
        });
      }
      return undefined;
    }
    if (invalidate) {
      invalidateProjectVolumeQuota({
        project_id,
        volume_kind: "scratch",
        reason: "project stopped; scratch reset pending",
        reset_required: true,
      });
    }
    const existing = stoppedVolumePreparationInFlight.get(project_id);
    if (existing) return existing;
    const operation_id = `post-stop-volume-prepare:${project_id}:${uuid()}`;
    const scratch_lifecycle_generation =
      currentProjectVolumeLifecycleGeneration(project_id);
    const phase_timings_ms: Record<string, number> = {};
    const preparationStarted = Date.now();
    const preparation = withBtrfsMutationContext(
      {
        operation_id,
        project_id,
        priority: "interactive",
        operation_class: "post_stop_volume_prepare",
      },
      async () => {
        const prepared = await assertStartDiskQuotaAllowed({
          project_id,
          run_quota: project.run_quota,
          run_quota_revision: project.run_quota_revision,
          reset_scratch: true,
          scratch_lifecycle_generation,
          record_timing: (phase, duration_ms) => {
            phase_timings_ms[phase] = duration_ms;
          },
        });
        return {
          prepared:
            prepared.storage_quota_prepared &&
            prepared.scratch_prepared === true,
          phase_timings_ms,
        };
      },
    )
      .catch((err) => {
        logger.warn("post-stop project volume preparation failed", {
          project_id,
          operation_id,
          err: `${err}`,
        });
        return { prepared: false, phase_timings_ms };
      })
      .finally(() => {
        phase_timings_ms.total = Date.now() - preparationStarted;
        if (stoppedVolumePreparationInFlight.get(project_id) === preparation) {
          stoppedVolumePreparationInFlight.delete(project_id);
        }
      });
    stoppedVolumePreparationInFlight.set(project_id, preparation);
    void preparation;
    return preparation;
  }

  let stoppedVolumePreparationSweepRunning = false;
  async function runStoppedVolumePreparationSweep(): Promise<number> {
    if (
      stoppedVolumePreparationSweepRunning ||
      projectQuotaLedgerMode() !== "enforce"
    ) {
      return 0;
    }
    stoppedVolumePreparationSweepRunning = true;
    let attempted = 0;
    try {
      const claimed = claimStoppedScratchVolumePreparations();
      if (claimed > 0) {
        logger.info("claimed legacy stopped scratch preparation backlog", {
          claimed,
        });
      }
      const rows = listStoppedScratchVolumePreparationBatch({
        limit: STOPPED_VOLUME_PREPARATION_BATCH_SIZE,
      });
      for (const row of rows) {
        const preparation = scheduleStoppedVolumePreparation(row.project_id, {
          invalidate: false,
        });
        if (!preparation) continue;
        attempted += 1;
        await preparation;
      }
      if (attempted > 0) {
        logger.info("stopped project volume preparation sweep finished", {
          attempted,
        });
      }
      return attempted;
    } finally {
      stoppedVolumePreparationSweepRunning = false;
    }
  }

  function startStoppedVolumePreparationMaintenance(): () => void {
    const claimed = claimStoppedScratchVolumePreparations();
    const initialTimer = setTimeout(() => {
      void runStoppedVolumePreparationSweep();
    }, STOPPED_VOLUME_PREPARATION_INITIAL_DELAY_MS);
    initialTimer.unref?.();
    const interval = setInterval(() => {
      void runStoppedVolumePreparationSweep();
    }, STOPPED_VOLUME_PREPARATION_SWEEP_MS);
    interval.unref?.();
    logger.info("started stopped project volume preparation maintenance", {
      sweep_ms: STOPPED_VOLUME_PREPARATION_SWEEP_MS,
      batch_size: STOPPED_VOLUME_PREPARATION_BATCH_SIZE,
      claimed,
    });
    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }

  async function performSyntheticRuntimeProbe(): Promise<SyntheticRuntimeProbeResult> {
    const project_id = uuid();
    const marker = uuid();
    const startedAt = Date.now();
    let stage = "create";
    syntheticRuntimeProbeProjects.add(project_id);
    try {
      await createProject({
        project_id,
        title: "CoCalc host runtime probe",
        image: DEFAULT_PROJECT_IMAGE,
        ensure_volume: true,
        start: true,
        run_quota: {
          cpu_limit: 1,
          memory: 512,
          memory_request: 128,
          disk_quota: 256,
        },
      } as CreateProjectOptions);
      stage = "status";
      const status = await runnerApi.status({ project_id });
      if (status?.state !== "running") {
        throw new Error(
          `synthetic project did not reach running state (state=${status?.state ?? "unknown"})`,
        );
      }
      stage = "exec_file";
      const result = await sandboxExec({
        project_id,
        script: `mkdir -p .cocalc && printf '%s' '${marker}' > .cocalc/host-runtime-probe && cat .cocalc/host-runtime-probe`,
        timeoutMs: 30_000,
        maxOutputBytes: 4096,
      });
      if (result.code !== 0 || result.stdout.trim() !== marker) {
        throw new Error(
          `synthetic project exec/file check failed (code=${result.code}, signal=${result.signal ?? "none"}): ${result.stderr || result.stdout}`,
        );
      }
      return {
        project_id,
        started_at: new Date(startedAt).toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
      };
    } catch (err) {
      throw new Error(
        `synthetic project probe failed project_id=${project_id} stage=${stage}: ${err}`,
      );
    } finally {
      await runnerApi.stop({ project_id, force: true }).catch((err) => {
        logger.warn("synthetic runtime probe failed to stop its project", {
          project_id,
          err: `${err}`,
        });
      });
      await deleteVolume(project_id, { reportProvisioned: false }).catch(
        (err) => {
          logger.warn("synthetic runtime probe failed to delete its volume", {
            project_id,
            err: `${err}`,
          });
        },
      );
      deleteProjectLocal(project_id);
      syntheticRuntimeProbeProjects.delete(project_id);
    }
  }

  async function runSyntheticRuntimeProbe(): Promise<SyntheticRuntimeProbeResult> {
    if (syntheticRuntimeProbeInFlight != null) {
      throw new Error(
        `synthetic runtime probe already in progress for ${Date.now() - syntheticRuntimeProbeInFlight.started_at}ms`,
      );
    }
    const startedAt = Date.now();
    const promise = performSyntheticRuntimeProbe().finally(() => {
      if (syntheticRuntimeProbeInFlight?.promise === promise) {
        syntheticRuntimeProbeInFlight = undefined;
      }
    });
    syntheticRuntimeProbeInFlight = {
      started_at: startedAt,
      promise,
    };
    return await withTimeout(
      promise,
      SYNTHETIC_RUNTIME_PROBE_TIMEOUT_MS,
      "synthetic runtime probe",
    );
  }

  async function rehydrateAcpAutomations(
    project_id: string,
    context: string,
  ): Promise<void> {
    try {
      await rehydrateAcpAutomationsForProject(project_id);
    } catch (err) {
      logger.warn(`${context}: failed to rehydrate ACP automations`, {
        project_id,
        err: `${err}`,
      });
    }
  }

  function kickOffAcpRehydrate(project_id: string, context: string): void {
    void rehydrateAcpAutomations(project_id, context);
  }

  async function createProject(
    opts: CreateProjectOptions = {},
  ): Promise<string> {
    const project_id =
      opts.project_id && isValidUUID(opts.project_id)
        ? opts.project_id
        : uuid();

    ensureProjectRow({
      project_id,
      opts,
      state: "opened",
      authorized_keys: (opts as any).authorized_keys,
    });

    if (opts.ensure_volume !== false || opts.start) {
      await ensureVolume(project_id, undefined, {
        reportProvisioned: !syntheticRuntimeProbeProjects.has(project_id),
      });
    }

    if (opts.start) {
      const activity_id = `create-start:${project_id}`;
      const resolved = await resolveStartMetadata({
        project_id,
        authorized_keys: (opts as any)?.authorized_keys,
        run_quota: (opts as any)?.run_quota,
        run_quota_revision: (opts as any)?.run_quota_revision,
        image: opts?.image,
      });
      await prepareProjectNetworkPolicy({
        project_id,
        policy: projectNetworkPolicyFromRunQuota(resolved.run_quota),
      });
      upsertProjectStopState({
        project_id,
        last_started_ms: Date.now(),
      });
      // Immediately mark as starting so the master reflects that state while we pull/podman up.
      ensureProjectRow({
        project_id,
        opts,
        state: "starting",
        authorized_keys: (opts as any).authorized_keys,
        secret_names: resolved.secret_names,
      });
      beginProjectHostActivity(activity_id, "start");
      try {
        const volumePreparation = await withBtrfsMutationContext(
          {
            operation_id: activity_id,
            project_id,
            priority: "lifecycle",
            operation_class: "project_volume_prepare",
          },
          async () =>
            await assertStartDiskQuotaAllowed({
              project_id,
              run_quota: resolved.run_quota,
              run_quota_revision: resolved.run_quota_revision,
              reset_scratch: true,
            }),
        );
        const initialConfig = await getRunnerConfig(project_id, resolved, {
          ...volumePreparation,
        });
        noteProjectHostActivityProgress(activity_id);
        const buildRetryConfig = async (retryOpts: {
          avoid_port_offsets: Iterable<number>;
        }) =>
          await getRunnerConfig(project_id, resolved, {
            rotate_ports: true,
            avoid_port_offsets: retryOpts.avoid_port_offsets,
            ...volumePreparation,
          });
        const startRunner = async (config: Configuration) =>
          await startRunnerWithStorageReservation({
            project_id,
            image: getImage(config),
            fn: async () =>
              await runnerApi.start({
                project_id,
                config,
              }),
          });
        await ensureManagedRootfsCached(initialConfig);
        noteProjectHostActivityProgress(activity_id);
        const started = await startRunnerWithPortRetry({
          project_id,
          initialConfig,
          buildRetryConfig,
          startRunner,
        });
        const status = started.status;
        ensureProjectRow({
          project_id,
          opts,
          state: status?.state ?? "running",
          http_port: (status as any)?.http_port,
          ssh_port: (status as any)?.ssh_port,
          project_bundle_version: (status as any)?.project_bundle_version,
          tools_version: (status as any)?.tools_version,
          secret_names: resolved.secret_names,
        });
        if (!syntheticRuntimeProbeProjects.has(project_id)) {
          kickOffAcpRehydrate(project_id, "createProject: post-start");
        }
      } finally {
        endProjectHostActivity(activity_id);
      }
    }

    return project_id;
  }

  async function start({
    project_id,
    authorized_keys,
    run_quota,
    run_quota_revision,
    image,
    restore,
    restore_backup_id,
    apply_pending_copies = true,
    lro_op_id,
    autostart,
    managed_egress_override,
    skip_if_running,
    start_metadata,
  }: {
    project_id: string;
    authorized_keys?: string;
    run_quota?: any;
    run_quota_revision?: number;
    image?: string;
    restore?: "none" | "auto" | "recover" | "required";
    restore_backup_id?: string;
    apply_pending_copies?: boolean;
    lro_op_id?: string;
    autostart?: boolean;
    managed_egress_override?: ManagedProjectEgressOverride;
    skip_if_running?: boolean;
    start_metadata?: HostProjectStartMetadata;
  }): Promise<{
    op_id: string;
    scope_type: "project";
    scope_id: string;
    service: string;
    stream_name: string;
    state?: string;
    phase_timings_ms?: Record<string, number>;
    runner_phase_timings_ms?: Record<string, number>;
  }> {
    const op_id = lro_op_id ?? uuid();
    const activity_id = `start:${op_id}`;
    const timings = createPhaseTimingRecorder();
    const projectHostStarted = Date.now();
    let runnerPhaseTimings: Record<string, number> | undefined;
    let volumePreparation = {
      storage_quota_prepared: false,
      scratch_prepared: false,
    };
    beginProjectHostActivity(activity_id, "start");
    let resolved: StartMetadata | undefined;
    try {
      const cachedProject = getProject(project_id);
      const cachedLifecycleState = `${cachedProject?.state ?? ""}`;
      const cachedRuntimeExitReason = cachedProject?.runtime_exit_reason;
      // A successful stop durably records "opened" locally. In that normal
      // warm-start case, avoid a redundant Podman status round trip: the
      // runner's container preflight remains authoritative and fail-safe. If
      // local state is absent or says the runtime may be live, retain the
      // explicit idempotency probe.
      const shouldProbeExistingRuntime =
        !cachedLifecycleState ||
        cachedLifecycleState === "running" ||
        cachedLifecycleState === "starting";
      if (
        skip_if_running &&
        !restore_backup_id &&
        runnerApi.status &&
        shouldProbeExistingRuntime
      ) {
        try {
          const current = await timings.measure(
            "check_existing_runtime",
            async () => await runnerApi.status({ project_id }),
          );
          if (current?.state === "running" || current?.state === "starting") {
            timings.phase_timings_ms.total = Object.values(
              timings.phase_timings_ms,
            ).reduce((sum, value) => sum + value, 0);
            publishStartProgress({
              activity_id,
              project_id,
              op_id,
              phase: "done",
              progress: 100,
              message: "project already running",
              detail: { phase_timings_ms: timings.phase_timings_ms },
            });
            return {
              op_id,
              scope_type: "project",
              scope_id: project_id,
              service: PERSIST_SERVICE,
              stream_name: lroStreamName(op_id),
              state: current.state,
              phase_timings_ms: timings.phase_timings_ms,
            };
          }
        } catch (err) {
          logger.debug(
            "idempotent start could not inspect current runtime; continuing with start",
            { project_id, err: `${err}` },
          );
        }
      }
      resolved = await timings.measure("resolve_start_metadata", async () =>
        resolveStartMetadata({
          project_id,
          authorized_keys,
          run_quota,
          run_quota_revision,
          image,
          autostart,
          start_metadata,
        }),
      );
      const startMetadata = resolved;
      const networkPolicy = projectNetworkPolicyFromRunQuota(
        startMetadata.run_quota,
      );
      await timings.measure("managed_network_admission", async () => {
        await assertManagedRawNetworkStartAllowedBestEffort({
          project_id,
          managed_egress_override,
          raw_network_enabled: networkPolicy === "normal",
        });
      });
      if (autostart && startMetadata.autostart_enabled === false) {
        throw new Error(
          "Automatic starts are disabled for this project. Use the project Start button, then try again.",
        );
      }
      if (
        autostart &&
        cachedRuntimeExitReason === "browser_idle_timeout" &&
        browserIdleTimeoutSeconds(startMetadata.run_quota) > 0 &&
        !hasRecentProjectBrowserActivity({
          project_id,
          max_age_ms: BROWSER_RUNTIME_AUTOSTART_PRESENCE_MAX_AGE_MS,
        })
      ) {
        throw new Error(
          "This free project stopped after its CoCalc browser tabs closed. Open the project in CoCalc before using automatic services again.",
        );
      }
      await timings.measure("prepare_network_policy", async () => {
        await prepareProjectNetworkPolicy({
          project_id,
          policy: networkPolicy,
        });
      });
      const normalizedImage = getImage({ image: startMetadata.image });
      const preparedOciEstimate = isManagedRootfsImageName(normalizedImage)
        ? undefined
        : timings
            .measure(
              "prepare_oci_pull_reservation",
              async () =>
                await prepareOciPullReservationEstimate({
                  image: normalizedImage,
                }),
            )
            .catch((err) => {
              logger.warn("unable to prepare OCI pull storage estimate", {
                project_id,
                image: normalizedImage,
                err: `${err}`,
              });
              return undefined;
            });
      publishStartProgress({
        activity_id,
        project_id,
        op_id,
        phase: "check_quota",
        progress: 3,
        message: "checking project disk quota",
      });
      await timings.measure("check_quota", async () => {
        const measureQuotaDetail = async <T>(
          phase: string,
          fn: () => Promise<T>,
        ): Promise<T> => {
          const started = Date.now();
          try {
            return await fn();
          } finally {
            timings.phase_timings_ms[`check_quota.${phase}`] =
              Date.now() - started;
          }
        };
        // Host registration intentionally does not materialize storage. A
        // create-immediately-start workflow therefore has no volume identity
        // yet, while warm starts retain the O(1) SQLite fast path.
        if (!getRecordedProjectVolumeIdentity(project_id, "home")) {
          await measureQuotaDetail("ensure_home_volume", async () => {
            await ensureVolume(project_id, undefined, {
              reportProvisioned: false,
            });
          });
        }
        let scratchPrepared = scratchVolumeQuotaIsPrepared(project_id);
        const stoppedPreparation = scratchPrepared
          ? undefined
          : stoppedVolumePreparationInFlight.get(project_id);
        if (stoppedPreparation != null) {
          const stoppedPreparationResult = await measureQuotaDetail(
            "wait_post_stop_preparation",
            async () => await stoppedPreparation,
          );
          for (const [phase, duration_ms] of Object.entries(
            stoppedPreparationResult.phase_timings_ms,
          )) {
            timings.phase_timings_ms[`check_quota.post_stop.${phase}`] =
              duration_ms;
          }
          scratchPrepared = scratchVolumeQuotaIsPrepared(project_id);
        }
        // The authoritative quota ledger settles the normal case without a
        // Podman round trip. Runtime state only matters when scratch remains
        // unprepared, since resetting a live project's scratch is unsafe.
        const runtimeState =
          !scratchPrepared &&
          projectQuotaLedgerMode() === "enforce" &&
          runnerApi.status
            ? (
                await measureQuotaDetail(
                  "runtime_status",
                  async () => await runnerApi.status({ project_id }),
                )
              )?.state
            : undefined;
        const resetScratch = runtimeState !== "running" && !scratchPrepared;
        await measureQuotaDetail(
          "reconcile",
          async () =>
            await withBtrfsMutationContext(
              {
                operation_id: op_id,
                project_id,
                priority: "lifecycle",
                operation_class: "project_volume_prepare",
              },
              async () => {
                volumePreparation = await assertStartDiskQuotaAllowed({
                  project_id,
                  run_quota: startMetadata.run_quota,
                  run_quota_revision: startMetadata.run_quota_revision,
                  reset_scratch: resetScratch,
                  record_timing: (phase, duration_ms) => {
                    timings.phase_timings_ms[`check_quota.${phase}`] =
                      duration_ms;
                  },
                });
              },
            ),
        );
      });
      timings.measureSync("mark_starting_state", () => {
        upsertProjectStopState({
          project_id,
          last_started_ms: Date.now(),
        });
        // Mark as starting immediately so hub/clients see progress even if
        // image pulls are slow.
        ensureProjectRow({
          project_id,
          opts: {
            title: startMetadata.title,
            users: startMetadata.users,
            authorized_keys: startMetadata.authorized_keys,
            run_quota: startMetadata.run_quota,
            run_quota_revision: startMetadata.run_quota_revision,
            image: startMetadata.image,
          },
          state: "starting",
          secret_names: startMetadata.secret_names,
        });
      });
      publishStartProgress({
        activity_id,
        project_id,
        op_id,
        phase: "apply_pending_copies",
        progress: 5,
        message: "preparing project state",
      });
      if (apply_pending_copies) {
        await timings.measure("apply_pending_copies", async () => {
          await applyPendingCopies({ project_id });
        });
      } else {
        timings.phase_timings_ms.apply_pending_copies = 0;
      }
      publishStartProgress({
        activity_id,
        project_id,
        op_id,
        phase: "prepare_config",
        progress: 15,
        message: "preparing project runtime",
      });
      const config = await timings.measure("prepare_config", async () => {
        return await getRunnerConfig(
          project_id,
          {
            image: startMetadata.image,
            authorized_keys: startMetadata.authorized_keys,
            run_quota: startMetadata.run_quota,
            env: startMetadata.env,
            secrets: startMetadata.secrets,
            secrets_generation: startMetadata.secrets_generation,
          },
          {
            restore,
            restore_backup_id,
            lro_op_id: op_id,
            ...volumePreparation,
          },
        );
      });
      publishStartProgress({
        activity_id,
        project_id,
        op_id,
        phase: "cache_rootfs",
        progress: 25,
        message: isManagedRootfsImageName(getImage(config))
          ? "checking RootFS cache"
          : "checking RootFS image",
      });
      await timings.measure("cache_rootfs", async () => {
        await ensureManagedRootfsCached(config, (update) => {
          publishStartProgress({
            activity_id,
            project_id,
            op_id,
            phase: "cache_rootfs",
            progress: scaleStartCacheProgress(update.progress),
            message: update.message,
            detail: update.detail,
          });
        });
      });
      publishStartProgress({
        activity_id,
        project_id,
        op_id,
        phase: "runner_start",
        progress: 85,
        message: "starting project runtime",
      });
      const started = await timings.measure("runner_start", async () => {
        return await startRunnerWithPortRetry({
          project_id,
          initialConfig: config,
          buildRetryConfig: async (retryOpts) =>
            await getRunnerConfig(
              project_id,
              {
                image: startMetadata.image,
                authorized_keys: startMetadata.authorized_keys,
                run_quota: startMetadata.run_quota,
                env: startMetadata.env,
                secrets: startMetadata.secrets,
                secrets_generation: startMetadata.secrets_generation,
              },
              {
                restore,
                restore_backup_id,
                lro_op_id: op_id,
                rotate_ports: true,
                avoid_port_offsets: retryOpts.avoid_port_offsets,
                ...volumePreparation,
              },
            ),
          startRunner: async (runnerConfig: Configuration) =>
            await startRunnerWithStorageReservation({
              project_id,
              image: getImage(runnerConfig),
              op_id,
              preparedEstimate: preparedOciEstimate,
              onProgress: ({ message, detail }) =>
                publishStartProgress({
                  activity_id,
                  project_id,
                  op_id,
                  phase: "runner_start",
                  progress: 86,
                  message,
                  detail,
                }),
              fn: async () =>
                await runnerApi.start({
                  project_id,
                  config: runnerConfig,
                }),
            }),
        });
      });
      const status = started.status;
      if (status?.state === "running") {
        // A volume is only authoritative after the restore/start lifecycle
        // succeeds. Quota checks and file browsing may create an incidental
        // local volume before this point and must not suppress recovery.
        if (restore === "recover" || restore_backup_id != null) {
          // A reprovisioned host can retain a stale local provisioning ledger
          // even when the owning bay correctly requires recovery or an
          // explicit restore. Force the successful restore result back to the
          // bay instead of deduplicating it against that stale acknowledgement.
          queueProjectProvisioned(project_id, true, { forceReport: true });
        } else {
          queueProjectProvisioned(project_id, true);
        }
      }
      if (
        status?.state === "running" &&
        startMetadata.secrets_generation != null
      ) {
        markProjectSecretsCacheMaterialized({
          project_id,
          generation: startMetadata.secrets_generation,
        });
      }
      runnerPhaseTimings = (status as any)?.phase_timings_ms;
      timings.measureSync("mark_running_state", () => {
        ensureProjectRow({
          project_id,
          opts: {
            title: startMetadata.title,
            users: startMetadata.users,
            authorized_keys: startMetadata.authorized_keys,
            run_quota: startMetadata.run_quota,
            image: getImage(config),
          },
          state: status?.state ?? "running",
          http_port: (status as any)?.http_port,
          ssh_port: (status as any)?.ssh_port,
          project_bundle_version: (status as any)?.project_bundle_version,
          tools_version: (status as any)?.tools_version,
          secret_names: startMetadata.secret_names,
        });
      });
      // During move/restore the destination project root may not exist until
      // runnerApi.start has created or restored it, so ACP rehydrate must wait.
      kickOffAcpRehydrate(project_id, "start: post-start");
      publishStartProgress({
        activity_id,
        project_id,
        op_id,
        phase: "refresh_authorized_keys",
        progress: 96,
        message: "refreshing project access",
      });
      await timings.measure("refresh_authorized_keys", async () => {
        await refreshAuthorizedKeys(project_id, authorized_keys);
      });
      if (runnerPhaseTimings) {
        for (const [phase, value] of Object.entries(runnerPhaseTimings)) {
          timings.phase_timings_ms[`runner_start.${phase}`] = value;
        }
      }
      timings.phase_timings_ms.total = Object.entries(timings.phase_timings_ms)
        .filter(
          ([phase]) =>
            !phase.startsWith("runner_start.") &&
            !phase.startsWith("check_quota."),
        )
        .reduce((sum, [_phase, value]) => sum + value, 0);
      timings.phase_timings_ms["project_host.wall_total"] =
        Date.now() - projectHostStarted;
      const attributedProjectHostMs = Object.entries(timings.phase_timings_ms)
        .filter(
          ([phase]) =>
            phase !== "total" &&
            phase !== "project_host.wall_total" &&
            phase !== "project_host.unattributed" &&
            !phase.startsWith("runner_start.") &&
            !phase.startsWith("check_quota."),
        )
        .reduce((sum, [_phase, value]) => sum + value, 0);
      timings.phase_timings_ms["project_host.unattributed"] = Math.max(
        0,
        timings.phase_timings_ms["project_host.wall_total"] -
          attributedProjectHostMs,
      );
      publishStartProgress({
        activity_id,
        project_id,
        op_id,
        phase: "done",
        progress: 100,
        message: "project ready",
        detail: {
          phase_timings_ms: timings.phase_timings_ms,
          runner_phase_timings_ms: runnerPhaseTimings,
        },
      });
    } catch (err) {
      // Fall back to stopped if startup fails so UI reflects failure.
      ensureProjectRow({
        project_id,
        opts: {
          title: resolved?.title,
          users: resolved?.users,
          authorized_keys: resolved?.authorized_keys,
          run_quota: resolved?.run_quota,
          image: resolved?.image,
        },
        state: "opened",
        secret_names: resolved?.secret_names,
      });
      publishStartProgress({
        activity_id,
        project_id,
        op_id,
        phase: "failed",
        progress: 100,
        message: "project start failed",
        detail: { error: `${err}` },
      });
      throw err;
    } finally {
      endProjectHostActivity(activity_id);
    }
    return {
      op_id,
      scope_type: "project",
      scope_id: project_id,
      service: PERSIST_SERVICE,
      stream_name: lroStreamName(op_id),
      phase_timings_ms: timings.phase_timings_ms,
      runner_phase_timings_ms: runnerPhaseTimings,
    };
  }

  async function stop({
    project_id,
    force,
    runtime_exit_reason,
  }: {
    project_id: string;
    force?: boolean;
    runtime_exit_reason?: ProjectState["runtime_exit_reason"];
  }): Promise<void> {
    const activity_id = `stop:${project_id}:${Date.now()}`;
    beginProjectHostActivity(activity_id, "stop");
    logger.debug("stop: project-host request received", { project_id, force });
    try {
      const status = await runnerApi.stop({ project_id, force });
      noteProjectHostActivityProgress(activity_id);
      let finalState = status?.state ?? "opened";
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const verified = await runnerApi.status({ project_id });
        finalState = verified?.state ?? finalState;
        if (finalState === "opened") {
          break;
        }
        await delay(250 * (attempt + 1));
        noteProjectHostActivityProgress(activity_id);
      }
      logger.debug("stop: runner stop completed", {
        project_id,
        force,
        state: finalState,
      });
      ensureProjectRow({
        project_id,
        state: finalState,
        http_port: undefined,
        ssh_port: undefined,
        ...(finalState === "opened" && runtime_exit_reason != null
          ? { runtime_exit_reason }
          : {}),
      });
      if (finalState !== "opened") {
        throw new Error(
          `project stop did not converge; runner still reports state='${finalState}'`,
        );
      }
      if (!syntheticRuntimeProbeProjects.has(project_id)) {
        try {
          const base = getMountPoint();
          const projectPath = join(base, `project-${project_id}`);
          const generation = await getGeneration(projectPath);
          markProjectLastChangedRunning(project_id, generation, {
            force: true,
          });
          await reportPendingProjectTouches();
        } catch (err) {
          logger.debug("stop last_changed check failed", {
            project_id,
            err: `${err}`,
          });
        } finally {
          resetProjectLastChangedRunning(project_id);
        }
      }
      // Start the destructive scratch reset only after stop bookkeeping. The
      // reset is deliberately fire-and-forget, but a concurrent Btrfs mutation
      // can otherwise block the generation read above and keep the lifecycle
      // lock in `stopping` for tens of seconds under storage pressure.
      scheduleStoppedVolumePreparation(project_id);
      logger.debug("stop: project-host request finished", {
        project_id,
        force,
      });
    } finally {
      endProjectHostActivity(activity_id);
    }
  }

  async function status({ project_id }: { project_id: string }) {
    return {
      runtime: projectRuntimeConfiguration("podman"),
      ...(await getProjectRuntimeStatus({ runnerApi, project_id })),
    };
  }

  async function restoreSnapshot({
    project_id,
    snapshot,
    mode = "both",
    safety_snapshot_name,
  }: {
    project_id: string;
    snapshot: string;
    mode?: SnapshotRestoreMode;
    safety_snapshot_name?: string;
  }): Promise<{
    op_id: string;
    scope_type: "project";
    scope_id: string;
    service: string;
    stream_name: string;
  }> {
    if (!isValidUUID(project_id)) {
      throw Error("invalid project_id");
    }
    if (getProject(project_id)?.local_only) {
      throw Error("snapshots are disabled for ephemeral exam workspaces");
    }
    if (!snapshot?.trim()) {
      throw Error("snapshot is required");
    }
    if (!["both", "home", "rootfs"].includes(mode)) {
      throw Error(`invalid snapshot restore mode: ${mode}`);
    }
    const safetySnapshotName =
      safety_snapshot_name ?? defaultSafetySnapshotName(snapshot);
    if (snapshot === safetySnapshotName) {
      throw Error("snapshot and safety snapshot name must differ");
    }

    const op_id = uuid();
    const now = new Date();
    const baseSummary: LroSummary = {
      op_id,
      kind: "project-restore",
      scope_type: "project",
      scope_id: project_id,
      status: "running",
      created_by: account_id ?? null,
      owner_type: "hub",
      owner_id: null,
      routing: "hub",
      input: {
        project_id,
        restore_type: "snapshot",
        snapshot,
        mode,
        safety_snapshot_name: safetySnapshotName,
      },
      result: {},
      error: null,
      progress_summary: { phase: "validate" },
      attempt: 0,
      heartbeat_at: null,
      created_at: now,
      started_at: now,
      finished_at: null,
      dismissed_at: null,
      dismissed_by: null,
      updated_at: now,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      dedupe_key: null,
      parent_id: null,
    };

    const publishProgress = (
      phase: string,
      progress: number,
      message: string,
    ) =>
      publishLroEvent({
        scope_type: "project",
        scope_id: project_id,
        op_id,
        event: {
          type: "progress",
          ts: Date.now(),
          phase,
          message,
          progress,
        },
      }).catch(() => {});

    void publishProgress("queued", 0, "queued");

    void (async () => {
      const started = Date.now();
      const restoreImage = await getSnapshotRestoreImage({
        project_id,
        snapshot,
        mode,
      });
      void publishLroSummaryWithRetry({
        scope_type: "project",
        scope_id: project_id,
        summary: baseSummary,
        context: "snapshot-restore-running",
      });
      try {
        void publishProgress("stop", 15, "stopping project");
        await stop({ project_id });
        void publishProgress("snapshot", 30, "creating safety snapshot");
        await fileServer(project_id).createSnapshot({
          project_id,
          name: safetySnapshotName,
        });
        void publishProgress("restore", 70, "restoring snapshot");
        await fileServer(project_id).restoreSnapshot({
          project_id,
          snapshot,
          mode,
          safety_snapshot_name: safetySnapshotName,
          lro: { op_id, scope_type: "project", scope_id: project_id },
        });
        void publishProgress("start", 85, "starting project");
        await start({
          project_id,
          image: restoreImage,
          lro_op_id: op_id,
        });
        const duration_ms = Date.now() - started;
        const finished = new Date();
        await publishLroSummaryWithRetry({
          scope_type: "project",
          scope_id: project_id,
          summary: {
            ...baseSummary,
            status: "succeeded",
            result: {
              restore_type: "snapshot",
              snapshot,
              mode,
              safety_snapshot_name: safetySnapshotName,
              duration_ms,
            },
            progress_summary: {
              phase: "done",
              snapshot,
              mode,
              safety_snapshot_name: safetySnapshotName,
              duration_ms,
            },
            finished_at: finished,
            updated_at: finished,
          },
          context: "snapshot-restore-succeeded",
        });
      } catch (err) {
        const finished = new Date();
        await publishLroSummaryWithRetry({
          scope_type: "project",
          scope_id: project_id,
          summary: {
            ...baseSummary,
            status: "failed",
            error: `${err}`,
            progress_summary: { phase: "failed" },
            finished_at: finished,
            updated_at: finished,
          },
          context: "snapshot-restore-failed",
        });
      }
    })();

    return {
      op_id,
      scope_type: "project",
      scope_id: project_id,
      service: PERSIST_SERVICE,
      stream_name: lroStreamName(op_id),
    };
  }

  async function codexDeviceAuthStart({
    account_id,
    project_id,
  }: {
    account_id?: string;
    project_id: string;
  }) {
    if (!account_id) {
      throw Error("user must be signed in");
    }
    if (!isValidUUID(project_id)) {
      throw Error("invalid project_id");
    }
    if (!getProject(project_id)) {
      throw Error("project is not hosted on this project-host");
    }
    return await startCodexDeviceAuth(
      project_id,
      account_id,
      verifyCodexSubscriptionAuth,
    );
  }

  async function verifyCodexSubscriptionAuth({
    projectId,
    accountId,
  }: {
    projectId: string;
    accountId: string;
    codexHome: string;
  }): Promise<void> {
    const status = await getCodexAppServerAccountStatus({
      projectId,
      accountId,
      timeoutMs: CODEX_DEVICE_AUTH_VERIFY_TIMEOUT_MS,
    });
    if (status.rateLimits) return;
    throw Error(
      status.errors?.rateLimits ??
        status.errors?.account ??
        "Codex account verification did not return live rate limits",
    );
  }

  async function codexDeviceAuthStatus({
    account_id,
    project_id,
    id,
  }: {
    account_id?: string;
    project_id: string;
    id: string;
  }) {
    if (!account_id) {
      throw Error("user must be signed in");
    }
    if (!isValidUUID(project_id)) {
      throw Error("invalid project_id");
    }
    if (!getProject(project_id)) {
      throw Error("project is not hosted on this project-host");
    }
    if (!isValidUUID(id)) {
      throw Error("invalid id");
    }
    const status = getCodexDeviceAuthStatus(id);
    if (
      !status ||
      status.accountId !== account_id ||
      status.projectId !== project_id
    ) {
      throw Error("unknown device auth id");
    }
    if (status.state === "completed") {
      invalidateCodexModelCatalog(account_id);
    }
    return status;
  }

  async function codexDeviceAuthCancel({
    account_id,
    project_id,
    id,
  }: {
    account_id?: string;
    project_id: string;
    id: string;
  }) {
    if (!account_id) {
      throw Error("user must be signed in");
    }
    if (!isValidUUID(project_id)) {
      throw Error("invalid project_id");
    }
    if (!getProject(project_id)) {
      throw Error("project is not hosted on this project-host");
    }
    if (!isValidUUID(id)) {
      throw Error("invalid id");
    }
    const status = getCodexDeviceAuthStatus(id);
    if (
      !status ||
      status.accountId !== account_id ||
      status.projectId !== project_id
    ) {
      throw Error("unknown device auth id");
    }
    const canceled = cancelCodexDeviceAuth(id);
    return { id, canceled };
  }

  async function codexUploadAuthFile({
    account_id,
    project_id,
    filename,
    content,
  }: {
    account_id?: string;
    project_id: string;
    filename?: string;
    content: string;
  }) {
    if (!account_id) {
      throw Error("user must be signed in");
    }
    if (!isValidUUID(project_id)) {
      throw Error("invalid project_id");
    }
    if (!getProject(project_id)) {
      throw Error("project is not hosted on this project-host");
    }
    if (filename && !/auth\.json$/i.test(filename.trim())) {
      throw Error("only auth.json uploads are supported");
    }
    const result = await uploadSubscriptionAuthFile({
      accountId: account_id,
      content,
    });
    const synced = await pushSubscriptionAuthToRegistry({
      projectId: project_id,
      accountId: account_id,
      codexHome: result.codexHome,
      content,
    });
    invalidateCodexModelCatalog(account_id);
    return { ok: true as const, synced: synced.ok, ...result };
  }

  function assertHostedProjectAccess({
    account_id,
    project_id,
  }: {
    account_id?: string;
    project_id: string;
  }) {
    if (!account_id) {
      throw Error("user must be signed in");
    }
    if (!isValidUUID(project_id)) {
      throw Error("invalid project_id");
    }
    if (!getProject(project_id)) {
      throw Error("project is not hosted on this project-host");
    }
  }

  async function getCodexUsageStatus({
    account_id,
    project_id,
    include_models,
    refresh_models,
    timeout,
  }: {
    account_id?: string;
    project_id: string;
    include_models?: boolean;
    refresh_models?: boolean;
    timeout?: number;
  }): Promise<CodexUsageStatusInfo> {
    assertHostedProjectAccess({ account_id, project_id });
    const accountId = account_id!;
    const checkedAt = new Date().toISOString();
    let source: CodexUsageStatusInfo["paymentSource"]["source"];
    let authRuntime: Awaited<ReturnType<typeof resolveCodexAuthRuntime>>;
    try {
      authRuntime = await resolveCodexAuthRuntime({
        projectId: project_id,
        accountId,
      });
      source = authRuntime.source;
    } catch (err) {
      const reason = `${err}`;
      return {
        available: false,
        checkedAt,
        paymentSource: {
          source: "none",
          hasSubscription: false,
          hasProjectApiKey: false,
          hasAccountApiKey: false,
          hasSiteApiKey: false,
          sharedHomeMode: "disabled",
          project_id,
        },
        project_id,
        reason: reason.includes("No Codex auth source configured")
          ? "Codex is not connected."
          : reason,
      };
    }
    const paymentSource = {
      source,
      hasSubscription: source === "subscription",
      hasProjectApiKey: source === "project-api-key",
      hasAccountApiKey: source === "account-api-key",
      hasSiteApiKey: source === "site-api-key",
      sharedHomeMode: source === "shared-home" ? "always" : "disabled",
      project_id,
    } satisfies CodexUsageStatusInfo["paymentSource"];
    if (paymentSource.source !== "subscription") {
      return {
        available: false,
        checkedAt,
        paymentSource,
        project_id,
        reason:
          "Live ChatGPT Codex usage is only available when Codex is using a ChatGPT Plan.",
      };
    }
    const timeoutMs = Math.min(
      45_000,
      Math.max(5_000, Number(timeout ?? 45_000)),
    );
    try {
      const subscriptionId = include_models
        ? await getCodexSubscriptionIdentity(authRuntime)
        : undefined;
      const cacheKey = subscriptionId
        ? codexModelCatalogCacheKey(accountId, subscriptionId)
        : undefined;
      const cacheGeneration = codexModelCatalogGeneration.get(accountId) ?? 0;
      const cachedCatalog =
        cacheKey && !refresh_models
          ? codexModelCatalogCache.get(cacheKey)
          : undefined;
      const status =
        include_models && cacheKey && !cachedCatalog
          ? await loadCodexModelCatalogStatus({
              dedupeKey: refresh_models
                ? undefined
                : `${cacheKey}\0${cacheGeneration}`,
              projectId: project_id,
              accountId,
              timeoutMs,
            })
          : await getCodexAppServerAccountStatus({
              projectId: project_id,
              accountId,
              isolatedCodexHome: true,
              includeModels: include_models && !cachedCatalog,
              timeoutMs,
            });
      const liveModels = status.models?.length ? status.models : undefined;
      if (
        cacheKey &&
        liveModels &&
        (codexModelCatalogGeneration.get(accountId) ?? 0) === cacheGeneration
      ) {
        codexModelCatalogCache.set(cacheKey, {
          checkedAt,
          models: liveModels,
        });
      }
      const models = cachedCatalog?.models ?? liveModels;
      return {
        available: !!status.rateLimits,
        checkedAt,
        paymentSource,
        project_id,
        authentication: status.authentication,
        account: status.account,
        rateLimits: status.rateLimits,
        tokenUsage: status.tokenUsage,
        models,
        modelsCheckedAt:
          cachedCatalog?.checkedAt ?? (models ? checkedAt : undefined),
        modelsCached: cachedCatalog ? true : models ? false : undefined,
        errors: status.errors,
        reason:
          !status.rateLimits && status.errors?.rateLimits
            ? status.errors.rateLimits
            : undefined,
      };
    } catch (err) {
      return {
        available: false,
        checkedAt,
        paymentSource,
        project_id,
        reason: `${err}`,
      };
    }
  }

  async function resolveChatStorePaths({
    account_id,
    project_id,
    chat_path,
    db_path,
  }: {
    account_id?: string;
    project_id: string;
    chat_path: string;
    db_path?: string;
  }): Promise<{ chat_path: string; db_path?: string }> {
    assertHostedProjectAccess({ account_id, project_id });
    return {
      chat_path: await resolveProjectContainerPath(project_id, chat_path),
      ...(db_path
        ? { db_path: await resolveProjectContainerPath(project_id, db_path) }
        : {}),
    };
  }

  async function chatStoreStats({
    account_id,
    project_id,
    chat_path,
    db_path,
  }: {
    account_id?: string;
    project_id: string;
    chat_path: string;
    db_path?: string;
  }): Promise<ChatStoreStats> {
    const paths = await resolveChatStorePaths({
      account_id,
      project_id,
      chat_path,
      db_path,
    });
    return await getChatStoreStats(paths);
  }

  async function chatStoreRotate({
    account_id,
    project_id,
    chat_path,
    db_path,
    keep_recent_messages,
    max_head_bytes,
    max_head_messages,
    require_idle,
    force,
    dry_run,
  }: {
    account_id?: string;
    project_id: string;
    chat_path: string;
    db_path?: string;
    keep_recent_messages?: number;
    max_head_bytes?: number;
    max_head_messages?: number;
    require_idle?: boolean;
    force?: boolean;
    dry_run?: boolean;
  }): Promise<ChatStoreRotateResult> {
    const paths = await resolveChatStorePaths({
      account_id,
      project_id,
      chat_path,
      db_path,
    });
    return await rotateChatStore({
      ...paths,
      keep_recent_messages,
      max_head_bytes,
      max_head_messages,
      require_idle,
      force,
      dry_run,
    });
  }

  async function chatStoreListSegments({
    account_id,
    project_id,
    chat_path,
    db_path,
    limit,
    offset,
  }: {
    account_id?: string;
    project_id: string;
    chat_path: string;
    db_path?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ chat_id: string; segments: ChatStoreSegment[] }> {
    const paths = await resolveChatStorePaths({
      account_id,
      project_id,
      chat_path,
      db_path,
    });
    return await listChatStoreSegments({
      ...paths,
      limit,
      offset,
    });
  }

  async function chatStoreReadArchived({
    account_id,
    project_id,
    chat_path,
    db_path,
    before_date_ms,
    thread_id,
    limit,
    offset,
  }: {
    account_id?: string;
    project_id: string;
    chat_path: string;
    db_path?: string;
    before_date_ms?: number;
    thread_id?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    chat_id: string;
    rows: ChatStoreArchivedRow[];
    offset: number;
    next_offset?: number;
  }> {
    const paths = await resolveChatStorePaths({
      account_id,
      project_id,
      chat_path,
      db_path,
    });
    return await readChatStoreArchived({
      ...paths,
      before_date_ms,
      thread_id,
      limit,
      offset,
    });
  }

  async function chatStoreReadArchivedHit({
    account_id,
    project_id,
    chat_path,
    db_path,
    row_id,
    message_id,
    thread_id,
  }: {
    account_id?: string;
    project_id: string;
    chat_path: string;
    db_path?: string;
    row_id?: number;
    message_id?: string;
    thread_id?: string;
  }): Promise<{ chat_id: string; row?: ChatStoreArchivedRow }> {
    const paths = await resolveChatStorePaths({
      account_id,
      project_id,
      chat_path,
      db_path,
    });
    return await readChatStoreArchivedHit({
      ...paths,
      row_id,
      message_id,
      thread_id,
    });
  }

  async function chatStoreSearch({
    account_id,
    project_id,
    chat_path,
    query,
    db_path,
    thread_id,
    exclude_thread_ids,
    limit,
    offset,
  }: {
    account_id?: string;
    project_id: string;
    chat_path: string;
    query: string;
    db_path?: string;
    thread_id?: string;
    exclude_thread_ids?: string[];
    limit?: number;
    offset?: number;
  }): Promise<{
    chat_id: string;
    hits: ChatStoreSearchHit[];
    offset: number;
    total_hits: number;
    next_offset?: number;
  }> {
    const paths = await resolveChatStorePaths({
      account_id,
      project_id,
      chat_path,
      db_path,
    });
    return await searchChatStoreArchived({
      ...paths,
      query,
      thread_id,
      exclude_thread_ids,
      limit,
      offset,
    });
  }

  async function chatStoreDelete({
    account_id,
    project_id,
    chat_path,
    db_path,
    scope,
    before_date_ms,
    thread_id,
    message_ids,
  }: {
    account_id?: string;
    project_id: string;
    chat_path: string;
    db_path?: string;
    scope: ChatStoreScope;
    before_date_ms?: number;
    thread_id?: string;
    message_ids?: string[];
  }): Promise<ChatStoreDeleteResult> {
    const paths = await resolveChatStorePaths({
      account_id,
      project_id,
      chat_path,
      db_path,
    });
    return await deleteChatStoreData({
      ...paths,
      scope,
      before_date_ms,
      thread_id,
      message_ids,
    });
  }

  async function chatStoreVacuum({
    account_id,
    project_id,
    chat_path,
    db_path,
  }: {
    account_id?: string;
    project_id: string;
    chat_path: string;
    db_path?: string;
  }): Promise<{
    chat_id: string;
    db_path: string;
    before_bytes: number;
    after_bytes: number;
  }> {
    const paths = await resolveChatStorePaths({
      account_id,
      project_id,
      chat_path,
      db_path,
    });
    return await vacuumChatStore(paths);
  }

  // Create a project locally and optionally start it.
  hubApi.projects.createProject = createProject;
  hubApi.projects.start = start;
  hubApi.projects.stop = stop;
  hubApi.projects.status = status;
  (hubApi.projects as any).runSyntheticRuntimeProbe = runSyntheticRuntimeProbe;
  hubApi.projects.getSshKeys = getSshKeys;
  hubApi.projects.createBackup = createBackup;
  hubApi.projects.deleteBackup = deleteBackup;
  hubApi.projects.restoreBackup = restoreBackup;
  hubApi.projects.restoreSnapshot = restoreSnapshot;
  hubApi.projects.beginRestoreStaging = beginRestoreStaging;
  hubApi.projects.ensureRestoreStaging = ensureRestoreStaging;
  hubApi.projects.finalizeRestoreStaging = finalizeRestoreStaging;
  hubApi.projects.releaseRestoreStaging = releaseRestoreStaging;
  hubApi.projects.cleanupRestoreStaging = cleanupRestoreStaging;
  hubApi.projects.getBackups = getBackups;
  hubApi.projects.getBackupFiles = getBackupFiles;
  hubApi.projects.getBackupQuota = getBackupQuota;
  hubApi.projects.codexDeviceAuthStart = codexDeviceAuthStart;
  hubApi.projects.codexDeviceAuthStatus = codexDeviceAuthStatus;
  hubApi.projects.codexDeviceAuthCancel = codexDeviceAuthCancel;
  hubApi.projects.codexUploadAuthFile = codexUploadAuthFile;
  hubApi.projects.getCodexUsageStatus = getCodexUsageStatus;
  hubApi.projects.chatStoreStats = chatStoreStats;
  hubApi.projects.chatStoreRotate = chatStoreRotate;
  hubApi.projects.chatStoreListSegments = chatStoreListSegments;
  hubApi.projects.chatStoreReadArchived = chatStoreReadArchived;
  hubApi.projects.chatStoreReadArchivedHit = chatStoreReadArchivedHit;
  hubApi.projects.chatStoreSearch = chatStoreSearch;
  hubApi.projects.chatStoreDelete = chatStoreDelete;
  hubApi.projects.chatStoreVacuum = chatStoreVacuum;
  return {
    runStoppedVolumePreparationSweep,
    startStoppedVolumePreparationMaintenance,
  };
}

// Update managed SSH keys for a project without restarting it.
async function refreshAuthorizedKeys(
  project_id: string,
  authorized_keys?: string,
) {
  upsertProject({ project_id, authorized_keys });
  if (authorized_keys != null) {
    try {
      await writeManagedAuthorizedKeys(project_id, authorized_keys);
    } catch (err) {
      logger.debug("refreshAuthorizedKeys: failed to write managed keys", {
        project_id,
        err: `${err}`,
      });
    }
  }
}

// Allow the master to push refreshed SSH keys when account/project keys change.
export async function updateAuthorizedKeys({
  project_id,
  authorized_keys,
}: {
  project_id: string;
  authorized_keys?: string;
}) {
  if (!isValidUUID(project_id)) {
    throw Error("invalid project_id");
  }
  await refreshAuthorizedKeys(project_id, authorized_keys ?? "");
}

export async function updateProjectUsers({
  project_id,
  users,
}: {
  project_id: string;
  users?: any;
}) {
  if (!isValidUUID(project_id)) {
    throw Error("invalid project_id");
  }
  // Store collaborator map in the generic sqlite row mirror used by conat auth.
  // This is separate from the concrete projects SQL table schema.
  upsertProject({ project_id, users });
  clearProjectHostConatAuthCaches();
}

export async function getSshKeys({
  project_id,
}: {
  project_id: string;
}): Promise<string[]> {
  if (!isValidUUID(project_id)) {
    throw Error("invalid project_id");
  }

  const keys = new Set<string>();

  // Keys persisted from the master (account + project keys).
  const row = getProject(project_id);
  if (row?.authorized_keys) {
    for (const line of row.authorized_keys.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) keys.add(trimmed);
    }
  }

  // Keys present inside the project filesystem (managed + user).
  try {
    const { path } = await getVolume(project_id);
    const managed = join(path, INTERNAL_SSH_CONFIG, "authorized_keys");
    const user = join(path, ".ssh", "authorized_keys");
    for (const candidate of [managed, user]) {
      try {
        const content = (await readFile(candidate, "utf8")).trim();
        if (!content) continue;
        for (const line of content.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed) keys.add(trimmed);
        }
      } catch {}
    }
  } catch (err) {
    logger.debug("getSshKeys: failed to read filesystem keys", {
      project_id,
      err: `${err}`,
    });
  }

  return Array.from(keys);
}

export async function createBackup({
  account_id: _account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
}): Promise<{
  op_id: string;
  scope_type: "project";
  scope_id: string;
  service: string;
  stream_name: string;
}> {
  if (!isValidUUID(project_id)) {
    throw Error("invalid project_id");
  }
  if (getProject(project_id)?.local_only) {
    throw Error("backups are disabled for ephemeral exam workspaces");
  }
  const createdBy = _account_id ?? account_id ?? null;
  const op_id = uuid();
  const now = new Date();
  const baseSummary: LroSummary = {
    op_id,
    kind: "project-backup",
    scope_type: "project",
    scope_id: project_id,
    status: "running",
    created_by: createdBy,
    owner_type: "hub",
    owner_id: null,
    routing: "hub",
    input: { project_id },
    result: {},
    error: null,
    progress_summary: { phase: "backup" },
    attempt: 0,
    heartbeat_at: null,
    created_at: now,
    started_at: now,
    finished_at: null,
    dismissed_at: null,
    dismissed_by: null,
    updated_at: now,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    dedupe_key: null,
    parent_id: null,
  };

  publishLroEvent({
    scope_type: "project",
    scope_id: project_id,
    op_id,
    event: {
      type: "progress",
      ts: Date.now(),
      phase: "queued",
      message: "queued",
      progress: 0,
    },
  }).catch(() => {});

  void (async () => {
    const started = Date.now();
    const limit = await getProjectBackupLimit(project_id);
    void publishLroSummaryWithRetry({
      scope_type: "project",
      scope_id: project_id,
      summary: baseSummary,
      context: "backup-running",
    });
    try {
      const backup = await fileServer(project_id).createBackup({
        project_id,
        limit,
        lro: { op_id, scope_type: "project", scope_id: project_id },
      });
      const duration_ms = Date.now() - started;
      const finished = new Date();
      await publishLroSummaryWithRetry({
        scope_type: "project",
        scope_id: project_id,
        summary: {
          ...baseSummary,
          status: "succeeded",
          result: {
            id: backup.id,
            time:
              backup.time instanceof Date
                ? backup.time.toISOString()
                : backup.time,
            generation: backup.generation,
            duration_ms,
          },
          progress_summary: {
            phase: "done",
            id: backup.id,
            duration_ms,
          },
          finished_at: finished,
          updated_at: finished,
        },
        context: "backup-succeeded",
      });
    } catch (err) {
      const finished = new Date();
      await publishLroSummaryWithRetry({
        scope_type: "project",
        scope_id: project_id,
        summary: {
          ...baseSummary,
          status: "failed",
          error: `${err}`,
          progress_summary: { phase: "failed" },
          finished_at: finished,
          updated_at: finished,
        },
        context: "backup-failed",
      });
    }
  })();

  return {
    op_id,
    scope_type: "project",
    scope_id: project_id,
    service: PERSIST_SERVICE,
    stream_name: lroStreamName(op_id),
  };
}

export async function deleteBackup({
  project_id,
  id,
}: {
  project_id: string;
  id: string;
}): Promise<void> {
  if (!isValidUUID(project_id)) {
    throw Error("invalid project_id");
  }
  await fileServer(project_id).deleteBackup({ project_id, id });
}

export async function restoreBackup({
  project_id,
  id,
  path,
  dest,
}: {
  project_id: string;
  id: string;
  path?: string;
  dest?: string;
}): Promise<{
  op_id: string;
  scope_type: "project";
  scope_id: string;
  service: string;
  stream_name: string;
}> {
  if (!isValidUUID(project_id)) {
    throw Error("invalid project_id");
  }
  const op_id = uuid();
  const now = new Date();
  const baseSummary: LroSummary = {
    op_id,
    kind: "project-restore",
    scope_type: "project",
    scope_id: project_id,
    status: "running",
    created_by: account_id ?? null,
    owner_type: "hub",
    owner_id: null,
    routing: "hub",
    input: { project_id, id, path, dest },
    result: {},
    error: null,
    progress_summary: { phase: "restore" },
    attempt: 0,
    heartbeat_at: null,
    created_at: now,
    started_at: now,
    finished_at: null,
    dismissed_at: null,
    dismissed_by: null,
    updated_at: now,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    dedupe_key: null,
    parent_id: null,
  };

  publishLroEvent({
    scope_type: "project",
    scope_id: project_id,
    op_id,
    event: {
      type: "progress",
      ts: Date.now(),
      phase: "queued",
      message: "queued",
      progress: 0,
    },
  }).catch(() => {});

  void (async () => {
    const started = Date.now();
    void publishLroSummaryWithRetry({
      scope_type: "project",
      scope_id: project_id,
      summary: baseSummary,
      context: "restore-running",
    });
    try {
      await fileServer(project_id).restoreBackup({
        project_id,
        id,
        path,
        dest,
        lro: { op_id, scope_type: "project", scope_id: project_id },
      });
      const duration_ms = Date.now() - started;
      const finished = new Date();
      await publishLroSummaryWithRetry({
        scope_type: "project",
        scope_id: project_id,
        summary: {
          ...baseSummary,
          status: "succeeded",
          result: { id, path, dest, duration_ms },
          progress_summary: { phase: "done", id, path, dest, duration_ms },
          finished_at: finished,
          updated_at: finished,
        },
        context: "restore-succeeded",
      });
    } catch (err) {
      const finished = new Date();
      await publishLroSummaryWithRetry({
        scope_type: "project",
        scope_id: project_id,
        summary: {
          ...baseSummary,
          status: "failed",
          error: `${err}`,
          progress_summary: { phase: "failed" },
          finished_at: finished,
          updated_at: finished,
        },
        context: "restore-failed",
      });
    }
  })();

  return {
    op_id,
    scope_type: "project",
    scope_id: project_id,
    service: PERSIST_SERVICE,
    stream_name: lroStreamName(op_id),
  };
}

export async function beginRestoreStaging({
  project_id,
  home,
  restore,
}: {
  project_id: string;
  home?: string;
  restore?: RestoreMode;
}): Promise<RestoreStagingHandle | null> {
  if (!isValidUUID(project_id)) {
    throw Error("invalid project_id");
  }
  return await fileServer(project_id).beginRestoreStaging({
    project_id,
    home,
    restore,
  });
}

export async function ensureRestoreStaging({
  handle,
}: {
  handle: RestoreStagingHandle;
}): Promise<void> {
  if (!isValidUUID(handle.project_id)) {
    throw Error("invalid project_id");
  }
  await fileServer(handle.project_id).ensureRestoreStaging({ handle });
}

export async function finalizeRestoreStaging({
  handle,
}: {
  handle: RestoreStagingHandle;
}): Promise<void> {
  if (!isValidUUID(handle.project_id)) {
    throw Error("invalid project_id");
  }
  await fileServer(handle.project_id).finalizeRestoreStaging({ handle });
}

export async function releaseRestoreStaging({
  handle,
  cleanupStaging,
}: {
  handle: RestoreStagingHandle;
  cleanupStaging?: boolean;
}): Promise<void> {
  if (!isValidUUID(handle.project_id)) {
    throw Error("invalid project_id");
  }
  await fileServer(handle.project_id).releaseRestoreStaging({
    handle,
    cleanupStaging,
  });
}

export async function cleanupRestoreStaging({
  project_id,
  root,
}: {
  project_id: string;
  root?: string;
}): Promise<void> {
  if (!isValidUUID(project_id)) {
    throw Error("invalid project_id");
  }
  await fileServer(project_id).cleanupRestoreStaging({ root });
}

export async function getBackups({
  project_id,
  indexed_only,
}: {
  project_id: string;
  indexed_only?: boolean;
}) {
  if (getProject(project_id)?.local_only) {
    throw Error("backups are disabled for ephemeral exam workspaces");
  }
  if (!isValidUUID(project_id)) {
    throw Error("invalid project_id");
  }
  return await fileServer(project_id).getBackups({ project_id, indexed_only });
}

export async function getBackupFiles({
  project_id,
  id,
  path,
}: {
  project_id: string;
  id: string;
  path?: string;
}): Promise<{ name: string; isDir: boolean; mtime: number; size: number }[]> {
  if (!isValidUUID(project_id)) {
    throw Error("invalid project_id");
  }
  return await fileServer(project_id).getBackupFiles({ project_id, id, path });
}

export async function getBackupQuota({ project_id }: { project_id: string }) {
  if (!isValidUUID(project_id)) {
    throw Error("invalid project_id");
  }
  return { limit: await getProjectBackupLimit(project_id) };
}

function defaultSafetySnapshotName(snapshot: string): string {
  return `restore-safety-${snapshot}-${new Date().toISOString()}`;
}

async function getSnapshotRestoreImage({
  project_id,
  snapshot,
  mode,
}: {
  project_id: string;
  snapshot: string;
  mode: SnapshotRestoreMode;
}): Promise<string | undefined> {
  if (mode === "home") return;
  try {
    const preview = await fileServer(project_id).getSnapshotFileText({
      project_id,
      snapshot,
      path: join(PROJECT_IMAGE_PATH, "current-image.txt"),
      max_bytes: 4096,
    });
    const image = preview.content.trim();
    return image.length > 0 ? image : undefined;
  } catch {
    return undefined;
  }
}
