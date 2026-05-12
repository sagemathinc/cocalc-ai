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
import {
  getProject,
  getOrCreateProjectLocalSecretToken,
  upsertProject,
} from "../sqlite/projects";
import { upsertProjectStopState } from "../sqlite/stop-policy";
import { type CreateProjectOptions } from "@cocalc/util/db-schema/projects";
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
import type { MembershipEffectiveLimits } from "@cocalc/conat/hub/api/purchases";
import type { client as projectRunnerClient } from "@cocalc/conat/project/runner/run";
import {
  DEFAULT_PROJECT_IMAGE,
  PROJECT_IMAGE_PATH,
} from "@cocalc/util/db-schema/defaults";
import getLogger from "@cocalc/backend/logger";
import {
  getMasterConatClient,
  reportProjectStateToMaster,
} from "../master-status";
import callHub from "@cocalc/conat/hub/call-hub";
import { secretsPath as sshProxySecretsPath } from "@cocalc/project-proxy/ssh-server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  writeManagedAuthorizedKeys,
  getVolume,
  ensureVolume,
  getMountPoint,
  resolveProjectContainerPath,
} from "../file-server";
import { INTERNAL_SSH_CONFIG } from "@cocalc/conat/project/runner/constants";
import type { Configuration } from "@cocalc/conat/project/runner/types";
import type { ProjectStatus } from "@cocalc/conat/project/runner/state";
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
  resetProjectLastEditedRunning,
  touchProjectLastEditedRunning,
} from "../last-edited";
import { getGeneration } from "@cocalc/file-server/btrfs/subvolume-snapshots";
import {
  startCodexDeviceAuth,
  getCodexDeviceAuthStatus,
  cancelCodexDeviceAuth,
} from "../codex/codex-device-auth";
import { uploadSubscriptionAuthFile } from "../codex/codex-auth";
import { pushSubscriptionAuthToRegistry } from "../codex/codex-auth-registry";
import { clearProjectHostConatAuthCaches } from "../conat-auth";
import { rehydrateAcpAutomationsForProject } from "@cocalc/lite/hub/acp";
import { getImage } from "@cocalc/project-runner/run/podman";
import {
  imageCachePath,
  inspectFilePath,
} from "@cocalc/project-runner/run/rootfs-base";
import { isManagedRootfsImageName } from "@cocalc/util/rootfs-images";
import {
  pullRootfsCacheEntry,
  type RootfsCachePullProgress,
} from "../rootfs-cache";
import { withOciPullReservationIfNeeded } from "../storage-reservations";
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

const logger = getLogger("project-host:hub:projects");
export const PROJECT_RUNNER_RPC_TIMEOUT_MS = 60 * 60 * 1000;
const MB = 1_000_000;
const DEFAULT_PID_LIMIT = 4096;
const DEFAULT_MAX_BACKUPS_PER_PROJECT = 30;
const PROJECT_OWNER_LIMITS_CACHE_TTL_MS = 5 * 60_000;
const LRO_PUBLISH_RETRY_ATTEMPTS = 20;
const LRO_PUBLISH_RETRY_DELAY_MS = 500;
const LRO_PUBLISH_ATTEMPT_TIMEOUT_MS = 3000;
const RUNNER_START_PORT_RETRY_LIMIT = 5;
const RUNNER_START_PORT_RETRY_BASE_DELAY_MS = 250;
const LISTENING_PROJECT_PORT_CACHE_TTL_MS = 250;
const RECENT_FAILED_PROJECT_PORT_OFFSET_TTL_MS =
  PROJECT_PORT_BIND_FAILURE_COOLDOWN_MS;
const projectOwnerLimitsCache = new TTL<string, MembershipEffectiveLimits>({
  ttl: PROJECT_OWNER_LIMITS_CACHE_TTL_MS,
});
const projectOwnerLimitsInflight = new Map<
  string,
  Promise<MembershipEffectiveLimits>
>();
let listeningProjectPortOffsetsCache:
  | {
      value: Set<number>;
      expiresAt: number;
    }
  | undefined;
let listeningProjectPortOffsetsInflight: Promise<Set<number>> | undefined;
const recentFailedProjectPortOffsets = new Map<number, number>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listeningProjectPortOffset(port?: number | null): number | undefined {
  return (
    projectPortOffsetFromSshPort(port) ?? projectPortOffsetFromHttpPort(port)
  );
}

function parseListeningPortOffsetsFromProcNet(raw: string): Set<number> {
  const offsets = new Set<number>();
  for (const line of raw.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const state = fields[3];
    if (state !== "0A") continue;
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

async function loadListeningProjectPortOffsetsUncached(): Promise<Set<number>> {
  const offsets = new Set<number>();
  for (const procPath of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      const raw = await readFile(procPath, "utf8");
      for (const offset of parseListeningPortOffsetsFromProcNet(raw)) {
        offsets.add(offset);
      }
    } catch (err) {
      logger.debug("unable to inspect listening TCP ports", {
        procPath,
        err: `${err}`,
      });
    }
  }
  return offsets;
}

async function getListeningProjectPortOffsets(): Promise<Set<number>> {
  const now = Date.now();
  const cached = listeningProjectPortOffsetsCache;
  if (cached && cached.expiresAt > now) {
    return new Set(cached.value);
  }
  if (listeningProjectPortOffsetsInflight) {
    return new Set(await listeningProjectPortOffsetsInflight);
  }
  listeningProjectPortOffsetsInflight = (async () => {
    const value = await loadListeningProjectPortOffsetsUncached();
    listeningProjectPortOffsetsCache = {
      value,
      expiresAt: Date.now() + LISTENING_PROJECT_PORT_CACHE_TTL_MS,
    };
    return value;
  })().finally(() => {
    listeningProjectPortOffsetsInflight = undefined;
  });
  return new Set(await listeningProjectPortOffsetsInflight);
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
  listeningProjectPortOffsetsCache = undefined;
  listeningProjectPortOffsetsInflight = undefined;
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
    const listeningOffsets = await getListeningProjectPortOffsets();
    diagnostics.listening_offset_count = listeningOffsets.size;
    diagnostics.ssh_port_listening =
      Number.isInteger(ssh_port) &&
      ssh_port &&
      listeningOffsets.has(listeningProjectPortOffset(Number(ssh_port)) ?? -1);
    diagnostics.http_port_listening =
      Number.isInteger(http_port) &&
      http_port &&
      listeningOffsets.has(listeningProjectPortOffset(Number(http_port)) ?? -1);
  } catch (err) {
    diagnostics.listening_offsets_error = `${err}`;
  }
  try {
    const ports = [ssh_port, http_port].filter(
      (value): value is number =>
        typeof value === "number" && Number.isInteger(value) && value > 0,
    );
    if (ports.length) {
      const { stdout, stderr, exit_code } = await executeCode({
        command: "ss",
        args: ["-ltn"],
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

function normalizeRunQuota(run_quota?: any): any | undefined {
  if (run_quota == null) return undefined;
  if (typeof run_quota === "string") {
    try {
      return JSON.parse(run_quota);
    } catch {
      return undefined;
    }
  }
  if (typeof run_quota === "object") {
    return run_quota;
  }
  return undefined;
}

function runnerConfigFromQuota(run_quota?: any): Partial<Configuration> {
  const limits: Partial<Configuration> = {};
  if (!run_quota) return limits;

  if (run_quota.cpu_limit != null) {
    limits.cpu = run_quota.cpu_limit;
  }

  if (run_quota.memory_limit != null) {
    const memory = Math.floor(run_quota.memory_limit * MB);
    limits.memory = memory;
    limits.tmp = Math.floor(memory / 2);
    limits.swap = true;
  }

  if (run_quota.pids_limit != null) {
    limits.pids = run_quota.pids_limit;
  } else {
    limits.pids = DEFAULT_PID_LIMIT;
  }

  if (run_quota.disk_quota != null) {
    const disk = Math.floor(run_quota.disk_quota * MB);
    limits.disk = disk;
    limits.scratch = disk;
  }

  const hasGpu = run_quota.gpu === true || (run_quota.gpu_count ?? 0) > 0;
  if (hasGpu) {
    limits.gpu = true;
  }

  return limits;
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
  };
}

// Preserve explicit rootfs/docker image names. Older non-OCI labels such as
// "ubuntu2404" are not valid container image references for the project
// runner, so fall them back to the default runtime image.
function normalizeImage(image?: string): string {
  const trimmed = image?.trim();
  if (!trimmed) return DEFAULT_PROJECT_IMAGE;
  if (trimmed.includes(":") || trimmed.includes("/")) {
    return trimmed;
  }
  return DEFAULT_PROJECT_IMAGE;
}

type StartMetadata = {
  title?: string;
  users?: any;
  image?: string;
  authorized_keys?: string;
  run_quota?: any;
  env?: ProjectEnv;
};

type LocalProjectOptions = CreateProjectOptions & {
  users?: any;
  authorized_keys?: string;
  run_quota?: any;
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
  image,
}: {
  project_id: string;
  authorized_keys?: string;
  run_quota?: any;
  image?: string;
}): Promise<StartMetadata> {
  const existing = getProject(project_id);
  let resolved: StartMetadata = {
    authorized_keys: authorized_keys ?? existing?.authorized_keys ?? undefined,
    run_quota: run_quota ?? (existing as any)?.run_quota,
    image: image ?? existing?.image ?? undefined,
    env: (existing as any)?.env,
  };
  const needsMaster =
    !resolved.image ||
    resolved.authorized_keys == null ||
    resolved.run_quota == null ||
    resolved.env == null ||
    !existing?.title;
  if (needsMaster) {
    try {
      const authoritative =
        await loadProjectStartMetadataFromMaster(project_id);
      if (authoritative) {
        resolved = {
          title: authoritative.title ?? existing?.title,
          users: authoritative.users,
          image: resolved.image ?? authoritative.image ?? undefined,
          authorized_keys:
            resolved.authorized_keys ?? authoritative.authorized_keys,
          run_quota: resolved.run_quota ?? authoritative.run_quota,
          env: resolved.env ?? authoritative.env,
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
}: {
  project_id: string;
  opts?: LocalProjectOptions;
  state?: string;
  http_port?: number | null;
  ssh_port?: number | null;
  project_bundle_version?: string | null;
  tools_version?: string | null;
  authorized_keys?: string;
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
    updated_at: now,
    last_seen: now,
  };
  const run_quota = normalizeRunQuota((opts as any)?.run_quota);
  if (run_quota) {
    row.run_quota = run_quota;
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
  }
  upsertProject(row);
  if (state) {
    reportProjectStateToMaster(project_id, state);
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
    "image" | "authorized_keys" | "run_quota" | "env"
  >,
  opts?: {
    restore?: "none" | "auto" | "required";
    restore_backup_id?: string;
    lro_op_id?: string;
    rotate_ports?: boolean;
    avoid_port_offsets?: Iterable<number>;
  },
) {
  const run_quota = normalizeRunQuota(resolved.run_quota);
  const limits = runnerConfigFromQuota(run_quota);
  const existing = getProject(project_id);
  const disk = limits.disk ?? existing?.disk;
  const scratch = limits.scratch ?? existing?.scratch;
  const ssh_proxy_public_key = await getSshProxyPublicKey();
  const secret = getOrCreateProjectLocalSecretToken(project_id);
  const avoidOffsets = await getListeningProjectPortOffsets();
  for (const offset of getRecentFailedProjectPortOffsets()) {
    avoidOffsets.add(offset);
  }
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
    restore: opts?.restore,
    restore_backup_id: opts?.restore_backup_id,
    lro_op_id: opts?.lro_op_id,
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
  fn,
}: {
  project_id: string;
  image: string;
  op_id?: string;
  onProgress?: (update: {
    message: string;
    detail?: Record<string, any>;
  }) => void;
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
    onProgress: (estimate) =>
      onProgress?.({
        message: "reserving host storage for OCI image pull",
        detail: estimate,
      }),
    fn,
  });
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

async function getAlreadyRunningProjectStatus({
  runnerApi,
  project_id,
  restore,
  restore_backup_id,
}: {
  runnerApi: RunnerApi;
  project_id: string;
  restore?: "none" | "auto" | "required";
  restore_backup_id?: string;
}): Promise<ProjectStatus | undefined> {
  if (restore && restore !== "none") return undefined;
  if (restore_backup_id) return undefined;
  if (typeof (runnerApi as any).status !== "function") return undefined;
  try {
    const status = await runnerApi.status({ project_id });
    return status?.state === "running" ? status : undefined;
  } catch (err) {
    logger.debug("unable to check existing project runtime before start", {
      project_id,
      err: `${err}`,
    });
    return undefined;
  }
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

    await ensureVolume(project_id);

    if (opts.start) {
      const activity_id = `create-start:${project_id}`;
      const resolved = await resolveStartMetadata({
        project_id,
        authorized_keys: (opts as any)?.authorized_keys,
        run_quota: (opts as any)?.run_quota,
        image: opts?.image,
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
      });
      beginProjectHostActivity(activity_id, "start");
      try {
        const initialConfig = await getRunnerConfig(project_id, resolved);
        noteProjectHostActivityProgress(activity_id);
        const buildRetryConfig = async (retryOpts: {
          avoid_port_offsets: Iterable<number>;
        }) =>
          await getRunnerConfig(project_id, resolved, {
            rotate_ports: true,
            avoid_port_offsets: retryOpts.avoid_port_offsets,
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
        });
        kickOffAcpRehydrate(project_id, "createProject: post-start");
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
    image,
    restore,
    restore_backup_id,
    lro_op_id,
    managed_egress_override,
  }: {
    project_id: string;
    authorized_keys?: string;
    run_quota?: any;
    image?: string;
    restore?: "none" | "auto" | "required";
    restore_backup_id?: string;
    lro_op_id?: string;
    managed_egress_override?: ManagedProjectEgressOverride;
  }): Promise<{
    op_id: string;
    scope_type: "project";
    scope_id: string;
    service: string;
    stream_name: string;
    phase_timings_ms?: Record<string, number>;
    runner_phase_timings_ms?: Record<string, number>;
  }> {
    const op_id = lro_op_id ?? uuid();
    const activity_id = `start:${op_id}`;
    const timings = createPhaseTimingRecorder();
    let runnerPhaseTimings: Record<string, number> | undefined;
    beginProjectHostActivity(activity_id, "start");
    let resolved: StartMetadata | undefined;
    try {
      await assertManagedRawNetworkStartAllowedBestEffort({
        project_id,
        managed_egress_override,
      });
      resolved = await resolveStartMetadata({
        project_id,
        authorized_keys,
        run_quota,
        image,
      });
      const startMetadata = resolved;
      const alreadyRunning = await getAlreadyRunningProjectStatus({
        runnerApi,
        project_id,
        restore,
        restore_backup_id,
      });
      if (alreadyRunning) {
        logger.info(
          "start requested for already-running project; preserving runtime",
          {
            project_id,
          },
        );
        ensureProjectRow({
          project_id,
          opts: {
            title: startMetadata.title,
            users: startMetadata.users,
            authorized_keys: startMetadata.authorized_keys,
            run_quota: startMetadata.run_quota,
            image: startMetadata.image,
          },
          state: "running",
        });
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
        publishStartProgress({
          activity_id,
          project_id,
          op_id,
          phase: "done",
          progress: 100,
          message: "project already running",
        });
        return {
          op_id,
          scope_type: "project",
          scope_id: project_id,
          service: PERSIST_SERVICE,
          stream_name: lroStreamName(op_id),
          phase_timings_ms: timings.phase_timings_ms,
        };
      }
      upsertProjectStopState({
        project_id,
        last_started_ms: Date.now(),
      });
      // Mark as starting immediately so hub/clients see progress even if image pulls are slow.
      ensureProjectRow({
        project_id,
        opts: {
          title: startMetadata.title,
          users: startMetadata.users,
          authorized_keys: startMetadata.authorized_keys,
          run_quota: startMetadata.run_quota,
          image: startMetadata.image,
        },
        state: "starting",
      });
      publishStartProgress({
        activity_id,
        project_id,
        op_id,
        phase: "apply_pending_copies",
        progress: 5,
        message: "preparing project state",
      });
      await timings.measure("apply_pending_copies", async () => {
        await applyPendingCopies({ project_id });
      });
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
          },
          {
            restore,
            restore_backup_id,
            lro_op_id: op_id,
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
              },
              {
                restore,
                restore_backup_id,
                lro_op_id: op_id,
                rotate_ports: true,
                avoid_port_offsets: retryOpts.avoid_port_offsets,
              },
            ),
          startRunner: async (runnerConfig: Configuration) =>
            await startRunnerWithStorageReservation({
              project_id,
              image: getImage(runnerConfig),
              op_id,
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
      runnerPhaseTimings = (status as any)?.phase_timings_ms;
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
        .filter(([phase]) => !phase.startsWith("runner_start."))
        .reduce((sum, [_phase, value]) => sum + value, 0);
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
  }: {
    project_id: string;
    force?: boolean;
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
      });
      if (finalState !== "opened") {
        throw new Error(
          `project stop did not converge; runner still reports state='${finalState}'`,
        );
      }
      try {
        const base = getMountPoint();
        const projectPath = join(base, `project-${project_id}`);
        const generation = await getGeneration(projectPath);
        await touchProjectLastEditedRunning(project_id, generation, "stop", {
          force: true,
        });
      } catch (err) {
        logger.debug("stop last_edited check failed", {
          project_id,
          err: `${err}`,
        });
      } finally {
        resetProjectLastEditedRunning(project_id);
      }
      logger.debug("stop: project-host request finished", {
        project_id,
        force,
      });
    } finally {
      endProjectHostActivity(activity_id);
    }
  }

  async function status({ project_id }: { project_id: string }) {
    return await getProjectRuntimeStatus({ runnerApi, project_id });
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
    return await startCodexDeviceAuth(project_id, account_id);
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
  hubApi.projects.chatStoreStats = chatStoreStats;
  hubApi.projects.chatStoreRotate = chatStoreRotate;
  hubApi.projects.chatStoreListSegments = chatStoreListSegments;
  hubApi.projects.chatStoreReadArchived = chatStoreReadArchived;
  hubApi.projects.chatStoreReadArchivedHit = chatStoreReadArchivedHit;
  hubApi.projects.chatStoreSearch = chatStoreSearch;
  hubApi.projects.chatStoreDelete = chatStoreDelete;
  hubApi.projects.chatStoreVacuum = chatStoreVacuum;
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
