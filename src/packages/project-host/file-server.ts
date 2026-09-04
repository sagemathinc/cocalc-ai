// Minimal file-server for project-host.
// This allows users to browse and generally use the filesystem of any project,
// without having to run that project.

import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { executeCode } from "@cocalc/backend/execute-code";
import {
  ARCHIVE_BACKUP_SOURCE_RELEASED_ERROR_CODE,
  server as createFileServer,
  client as createFileClient,
  type Fileserver,
  type CopyOptions,
  type DirectorySummary,
  type DirectorySummaryEntry,
  type ExternalProjectBackupResult,
  type LroRef,
  type ManagedBackupEgressOverride,
  type PathCopyArchive,
  type PathCopyArchiveDestination,
  type PathCopyArchiveRoot,
  type RestoreMode,
  type RestoreStagingHandle,
  type SnapshotRestoreMode,
  type SnapshotUsage,
} from "@cocalc/conat/files/file-server";
import { createServer as createReadServer } from "@cocalc/conat/files/read";
import { PROJECT_HOST_FILE_DOWNLOAD_READ_SERVICE } from "@cocalc/conat/files/file-download";
import { createServer as createWriteServer } from "@cocalc/conat/files/write";
import {
  ConatError,
  type Client as ConatClient,
} from "@cocalc/conat/core/client";
import type {
  ProjectBackupConfig,
  ProjectBackupIndexStoreConfig,
} from "@cocalc/conat/hub/api/hosts";
import { hubApi } from "@cocalc/lite/hub/api";
import { formatManagedEgressPolicyDetails } from "@cocalc/util/managed-egress-message";
import { reuseInFlight } from "@cocalc/util/reuse-in-flight";
import { assertValidSnapshotName } from "@cocalc/util/snapshot-name";
import getLogger from "@cocalc/backend/logger";
import {
  data,
  fileServerMountpoint,
  secrets,
  rusticRepo,
} from "@cocalc/backend/data";
import { filesystem, type Filesystem } from "@cocalc/file-server/btrfs";
import {
  BACKUP_INDEX_LABEL_PREFIX,
  backupIndexDir,
  backupIndexFileName,
  backupIndexHost,
} from "@cocalc/file-server/btrfs/backup-index";
import {
  beginRestoreStaging as beginRestoreStagingBtrfs,
  ensureRestoreStaging as ensureRestoreStagingBtrfs,
  finalizeRestoreStaging as finalizeRestoreStagingBtrfs,
  releaseRestoreStaging as releaseRestoreStagingBtrfs,
  cleanupRestoreStaging as cleanupRestoreStagingBtrfs,
} from "@cocalc/file-server/btrfs/restore-staging";
import {
  getSubvolumeIdentity,
  isBtrfsSubvolume,
} from "@cocalc/file-server/btrfs/subvolume";
import { getGeneration } from "@cocalc/file-server/btrfs/subvolume-snapshots";
import { exists } from "@cocalc/backend/misc/async-utils-node";
import { type SnapshotCounts } from "@cocalc/util/db-schema/projects";
import { PROJECT_IMAGE_PATH } from "@cocalc/util/db-schema/defaults";
import {
  managedRootfsImageName,
  isManagedRootfsImageName,
  ROOTFS_CONTENT_MAX_JSON_BYTES,
  type RootfsImageArch,
  type RootfsContentValidationWarning,
  type RootfsPhaseTimings,
  type PublishProjectRootfsArtifact,
  type RootfsArtifactTransferTarget,
  type RootfsUploadedArtifactResult,
} from "@cocalc/util/rootfs-images";
import { init as initSshServer } from "@cocalc/project-proxy/ssh-server";
import {
  authorizedKeysContainAnyFingerprint,
  matchingAuthorizedKeyFingerprint,
  sshPublicKeyCandidateFingerprints,
} from "@cocalc/project-proxy/ssh-keys";
import {
  DEFAULT_PROJECT_RUNTIME_HOME,
  DEFAULT_PROJECT_RUNTIME_USER,
  projectRuntimeHomeRelativePath,
} from "@cocalc/util/project-runtime";
import {
  fsServer,
  fsReadOnlyServer,
  DEFAULT_FILE_SERVICE,
  SHARE_FILE_SERVICE,
  VIEWER_FILE_SERVICE,
  fsSubject,
  shareFsSubject,
  viewerFsSubject,
  parseShareFsSubject,
  parseViewerFsSubject,
} from "@cocalc/conat/files/fs";
import { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import cpExec from "@cocalc/backend/sandbox/cp";
import execSandbox from "@cocalc/backend/sandbox/exec";
import rustic, {
  getHost as getRusticSnapshotHost,
} from "@cocalc/backend/sandbox/rustic";
import { envToInt } from "@cocalc/backend/misc/env-to-number";
import { isValidUUID } from "@cocalc/util/misc";
import { getProject } from "./sqlite/projects";
import {
  acceptProjectVolumeQuotaDesired,
  bootstrapProjectVolumeQuotaLedger,
  deleteProjectVolumeQuotas,
  invalidateProjectVolumeQuota,
  listProjectVolumeQuotaAuditBatch,
  markProjectVolumeQuotaApplied,
  markProjectVolumeQuotaFailed,
  type ProjectVolumeQuotaRow,
} from "./sqlite/volume-quotas";
import {
  deleteProjectVolumeQuotaOverrides,
  effectiveProjectVolumeQuotaBytes,
  pruneReleasedProjectVolumeQuotaOverrides,
} from "./sqlite/volume-quota-overrides";
import {
  currentProjectFilesystemQuotaState,
  reconcileProjectFilesystemQuotaState,
} from "./sqlite/filesystem-quota-state";
import {
  bootstrapProjectVolumeInventory,
  getProjectVolume,
  getRecordedProjectVolumeIdentity,
  listProvisionedProjectIds as listProvisionedProjectIdsFromInventory,
  markProjectVolumeAbsent,
  nextProjectVolumeVerificationBatch,
  projectVolumeInventoryBootstrapped,
  projectVolumeIdentityKey,
  recordProjectVolume,
} from "./sqlite/project-volumes";
import {
  assertProjectVolumeLifecycleGeneration,
  currentProjectVolumeLifecycleGeneration,
  invalidateProjectVolumeLifecycle,
  withCurrentProjectVolumeLifecycleLock,
  withProjectVolumeLifecycleLock,
} from "./project-volume-lifecycle";
import { INTERNAL_SSH_CONFIG } from "@cocalc/conat/project/runner/constants";
import { ensureSshpiperdKey } from "./ssh/sshpiperd-key";
import { requireManagedSshKeyAccount } from "./ssh/managed-key-account";
import { managedProjectEgressResidualTracker } from "./managed-egress-residual";
import { planBackupRetention } from "./backup-retention";
import {
  assertFrozenVolumeMatchesBackup,
  deleteOrphanedStagedArchiveSnapshots,
  deleteStagedArchiveSnapshots,
  freezeVolumeForArchiveBackup,
  getFrozenVolumeGeneration,
  isSubvolumeReadonly,
  listStagedArchiveVolumeNames,
  releaseArchiveVolumeFreeze,
  releaseArchiveVolumeFreezeIfGenerationMatches,
} from "./archive-volume-barrier";
import { getLocalHostId } from "./sqlite/hosts";
import { setContainerFileIO } from "@cocalc/lite/hub/acp/executor/container";
import { open as nodeOpen } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { getMasterConatClient, queueProjectProvisioned } from "./master-status";
import callHub from "@cocalc/conat/hub/call-hub";
import type {
  AuthorizePublicDirectoryShareReadResponse,
  GetTemporaryViewerReadPolicyResponse,
} from "@cocalc/conat/hub/api/public-directory-shares";
import { startProjectWithAdmission } from "./project-start-admission";
import {
  createRusticProgressHandler,
  type RusticProgressUpdate,
} from "@cocalc/file-server/btrfs/rustic-progress";
import { publishLroEvent } from "./lro/stream";
import { touchProjectLastEdited } from "./last-edited";
import { normalizeArchivePath } from "./archive-path";
import { getRootfsMountpoint } from "@cocalc/project-runner/run/rootfs";
import {
  extractBaseImage,
  imageCachePath,
  imagePathComponent,
  inspect,
  inspectFilePath,
  IMAGE_CACHE,
} from "@cocalc/project-runner/run/rootfs-base";
import { createProjectSandboxFilesystem } from "./file-server-sandbox-policy";
import { importJupyterIpynb, saveJupyterIpynb } from "./jupyter-ipynb";
import { resetClonedProjectState } from "./clone-state";
import { withBackupParallelLimit } from "./backup-queue";
export { getBackupExecutionStatus } from "./backup-queue";
import {
  isProjectViewerRole,
  type ProjectViewerReadPolicy,
} from "@cocalc/util/project-access";
import {
  assertViewerCanonicalPathAllowed,
  createViewerReadOnlyFilesystem,
} from "./viewer-read-only-filesystem";
import {
  projectRuntimeRootfsContractLabelsForCurrentHost,
  readCurrentProjectRuntimeUsernsMapFingerprint,
} from "./rootfs-runtime-contract";
import {
  ProjectRusticUnsupportedError,
  projectRusticBackup,
  projectRusticRestore,
} from "./project-rustic";
import { isMissingRusticRepositoryError } from "./backup-index-errors";
import {
  checkManagedBackupAllowedBestEffort,
  recordManagedBackupEgressBestEffort,
} from "./backup-egress";
import {
  newestBackupTimeForIds,
  parseCreatedBackupSnapshot,
} from "./backup-created";
import { btrfs, sudo } from "@cocalc/file-server/btrfs/util";
import {
  BtrfsMutationDeferredError,
  withBtrfsMutationContext,
  withBtrfsMutationLock,
} from "@cocalc/file-server/btrfs/operation-cache";
import { subvolume } from "@cocalc/file-server/btrfs/subvolume";
import { ensureRootfsRusticRepoProfile } from "./rootfs-rustic";
import { createLegacyProjectArchiveHandlers } from "./legacy-migration/project-archive";
import { ProjectVolumeQuotaManager } from "./project-volume-quota-manager";
import {
  rusticBackupBrowser,
  type BackupBrowserSearchResponse,
  type BackupBrowserSearchResult,
} from "./rustic-backup-browser";
import {
  archivePathIsAllowed,
  decodePathCopyArchiveListing,
  installPathFromStaging,
  replacePathFromStaging,
} from "./path-copy-archive";
import { flushJupyterNotebooksToDisk } from "./jupyter-collaborative-flush";

type SshTarget = { type: "project"; project_id: string };

const logger = getLogger("project-host:file-server");
const RESTORE_STAGING_ROOT = ".restore-staging";
const SNAPSHOT_RESTORE_STAGING_ROOT = ".snapshot-restore-staging";
const MAX_TEXT_PREVIEW_BYTES = 10 * 1024 * 1024;
const DEFAULT_ADMIN_DIRECTORY_SUMMARY_ROOT = DEFAULT_PROJECT_RUNTIME_HOME;
const DEFAULT_ADMIN_DIRECTORY_SUMMARY_DEPTH = 2;
const DEFAULT_ADMIN_DIRECTORY_SUMMARY_LIMIT = 80;
const ROOTFS_PUBLISH_TIMEOUT_S = 60 * 60;
const PATH_COPY_ARCHIVE_FORMAT = "cocalc-path-copy-tar-gzip-v1";
const PATH_COPY_ARCHIVE_LIMIT_PREFIX = "PATH_COPY_ARCHIVE_LIMIT:";
const PATH_COPY_ARCHIVE_TIMEOUT_MS = 5 * 60 * 1000;
const STORAGE_WRAPPER = "/usr/local/sbin/cocalc-runtime-storage";
const PROJECT_RUSTIC_TIMEOUT_MS = 30 * 60 * 1000;
const BACKUP_SNAPSHOT_LOOKUP_TIMEOUT_MS = 5 * 60 * 1000;
const PROJECT_ROOTS_CACHE = join(data, "cache", "project-roots");
const PROJECT_SITE_MIGRATION_STAGING_DIR = ".project-site-migration-staging";
const PROJECT_SITE_MIGRATION_ROOTFS_STATE_PATH = ".local/share/cocalc/rootfs";
const SSH_WAKE_TIMEOUT_MS = Math.max(
  5_000,
  envToInt("COCALC_PROJECT_HOST_SSH_WAKE_TIMEOUT_MS", 120_000),
);
const SSH_WAKE_POLL_MS = Math.max(
  100,
  envToInt("COCALC_PROJECT_HOST_SSH_WAKE_POLL_MS", 500),
);
const QUOTA_CACHE_TTL_MS = Math.max(
  0,
  envToInt("COCALC_PROJECT_HOST_QUOTA_CACHE_TTL_MS", 60_000),
);
const PROJECT_QUOTA_REPAIR_SWEEP_MS = Math.max(
  60_000,
  envToInt("COCALC_PROJECT_QUOTA_REPAIR_SWEEP_MS", 60_000),
);
const PROJECT_QUOTA_REPAIR_BATCH_SIZE = Math.max(
  1,
  Math.min(256, envToInt("COCALC_PROJECT_QUOTA_REPAIR_BATCH_SIZE", 32)),
);
const PROJECT_QUOTA_OVERRIDE_SCAVENGE_MS = Math.max(
  60_000,
  envToInt("COCALC_PROJECT_QUOTA_OVERRIDE_SCAVENGE_MS", 5 * 60_000),
);
const PROJECT_QUOTA_OVERRIDE_DEFAULT_TTL_MS = Math.max(
  60 * 60_000,
  envToInt("COCALC_PROJECT_QUOTA_OVERRIDE_DEFAULT_TTL_MS", 12 * 60 * 60_000),
);
const PROJECT_QUOTA_OVERRIDE_HISTORY_RETENTION_MS = Math.max(
  24 * 60 * 60_000,
  envToInt(
    "COCALC_PROJECT_QUOTA_OVERRIDE_HISTORY_RETENTION_MS",
    7 * 24 * 60 * 60_000,
  ),
);
const sshWakeInFlight = new Map<string, Promise<number | null>>();
const quotaCache = new Map<
  string,
  {
    expires: number;
    value: {
      size: number;
      used: number;
      qgroupid?: string;
      scope?: "subvolume";
      warning?: string;
    };
  }
>();
const quotaInFlight = new Map<
  string,
  Promise<{
    size: number;
    used: number;
    qgroupid?: string;
    scope?: "subvolume";
    warning?: string;
  }>
>();
const projectQuotaGraceActive = new Set<string>();
const legacyProjectArchiveRestoreActive = new Set<string>();
const legacyProjectInitialBackupEgressExempt = new Set<string>();
const LEGACY_MIGRATION_INITIAL_BACKUP_OVERRIDE: ManagedBackupEgressOverride =
  "legacy-migration-initial-backup";
const LEGACY_MIGRATION_INITIAL_BACKUP_TAGS = [
  "legacy-migration",
  "legacy-migration-initial",
  "scheduled",
];
const projectVolumeQuotaManager = new ProjectVolumeQuotaManager(
  {
    observe: async (project_id, volume_kind) => {
      const vol = await getVolume(project_id, volume_kind === "scratch");
      return await vol.quota.get();
    },
    applyRaw: async (opts) => await applyManagedProjectVolumeQuotaRaw(opts),
  },
  logger,
);
const legacyProjectArchiveHandlers = createLegacyProjectArchiveHandlers({
  getOrEnsureVolume,
  getProjectQuota: async (project_id) => await getQuota({ project_id }),
  beginProjectQuotaOverride: async ({
    project_id,
    operation_id,
    minimum_bytes,
  }) =>
    await projectVolumeQuotaManager.beginTemporaryOverride({
      project_id,
      operation_id,
      kind: "legacy_project_archive_restore",
      minimum_bytes,
      expires_at: Date.now() + PROJECT_QUOTA_OVERRIDE_DEFAULT_TTL_MS,
      operation_class: "legacy_project_archive_restore",
      priority: "lifecycle",
    }),
  setProjectQuotaGraceActive: (project_id, active) => {
    if (active) {
      projectQuotaGraceActive.add(project_id);
    } else {
      projectQuotaGraceActive.delete(project_id);
    }
  },
  setProjectArchiveRestoreActive: (project_id, active) => {
    if (active) {
      legacyProjectArchiveRestoreActive.add(project_id);
    } else {
      legacyProjectArchiveRestoreActive.delete(project_id);
    }
  },
  markProjectArchiveInitialBackupExempt: (project_id) => {
    legacyProjectInitialBackupEgressExempt.add(project_id);
  },
  projectMountpoint,
  createWritableSnapshot: async (source, dest) =>
    await btrfsSnapshotWritable({ source, dest }),
  createReadonlySnapshot: async (source, dest) =>
    await btrfsSnapshotReadonly({ source, dest }),
  setSubvolumeReadonly: async (path, readOnly) =>
    await btrfsSetSubvolumeReadonly({ path, readOnly }),
  deleteSubvolumeTree,
  invalidateProjectFsServer,
  touchProjectLastEdited,
  logger,
});

function volName(project_id: string) {
  return `project-${project_id}`;
}

function normalizePositivePort(value: unknown): number | null {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function quotaCacheKey(project_id: string, scratch?: boolean): string {
  return `${project_id}:${scratch ? "scratch" : "project"}`;
}

function invalidateQuotaCache(project_id: string, scratch?: boolean): void {
  quotaCache.delete(quotaCacheKey(project_id, scratch));
}

async function waitForProjectSshPort(
  project_id: string,
  timeoutMs = SSH_WAKE_TIMEOUT_MS,
  pollMs = SSH_WAKE_POLL_MS,
): Promise<number | null> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const port = normalizePositivePort(getProject(project_id)?.ssh_port);
    if (port != null) {
      return port;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return null;
}

async function ensureProjectSshWake({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<number | null> {
  const existingPort = normalizePositivePort(getProject(project_id)?.ssh_port);
  if (existingPort != null) {
    return existingPort;
  }
  const wakeKey = `${project_id}:${account_id}`;
  const existing = sshWakeInFlight.get(wakeKey);
  if (existing) {
    return await existing;
  }
  const task = (async () => {
    const row = getProject(project_id);
    if (!row) {
      return null;
    }
    const currentPort = normalizePositivePort(row.ssh_port);
    if (currentPort != null) {
      return currentPort;
    }

    const hostId = getLocalHostId();
    if (row.state !== "starting") {
      try {
        logger.debug("ssh wake start requested", {
          project_id,
          account_id,
          host_id: hostId,
          state: row.state,
        });
        await startProjectWithAdmission({
          account_id,
          project_id,
          autostart: true,
          timeout: SSH_WAKE_TIMEOUT_MS,
        });
      } catch (err) {
        logger.warn("ssh wake start project failed", {
          project_id,
          account_id,
          host_id: hostId,
          err: `${err}`,
        });
      }
    }

    const port = await waitForProjectSshPort(project_id);
    if (port == null) {
      logger.warn("ssh wake timed out waiting for ssh port", { project_id });
    } else {
      logger.debug("ssh wake project ready", { project_id, ssh_port: port });
    }
    return port;
  })().finally(() => {
    if (sshWakeInFlight.get(wakeKey) === task) {
      sshWakeInFlight.delete(wakeKey);
    }
  });
  sshWakeInFlight.set(wakeKey, task);
  return await task;
}

function scratchVolName(project_id: string) {
  return `${volName(project_id)}-scratch`;
}

function volumeName(project_id: string, scratch?: boolean) {
  return scratch ? scratchVolName(project_id) : volName(project_id);
}

function managedVolumeKind(scratch?: boolean): "home" | "scratch" {
  return scratch ? "scratch" : "home";
}

function managedProjectVolumeName(
  name: string,
): { project_id: string; volume_kind: "home" | "scratch" } | undefined {
  if (!name.startsWith("project-")) return;
  const raw = name.slice("project-".length);
  const scratch = raw.endsWith("-scratch");
  const project_id = scratch ? raw.slice(0, -"-scratch".length) : raw;
  if (!isValidUUID(project_id)) return;
  return {
    project_id,
    volume_kind: scratch ? "scratch" : "home",
  };
}

function withManagedTemporaryQuotaOverride<T>({
  subvolume_name,
  operation,
  minimum_bytes,
  run,
}: {
  subvolume_name: string;
  operation: string;
  minimum_bytes: number;
  run: () => Promise<T>;
}): Promise<T> | undefined {
  const managed = managedProjectVolumeName(subvolume_name);
  if (!managed) return;
  return projectVolumeQuotaManager.withTemporaryOverride(
    {
      ...managed,
      kind: "snapshot_cleanup",
      minimum_bytes,
      expires_at: Date.now() + PROJECT_QUOTA_OVERRIDE_DEFAULT_TTL_MS,
      operation_class: operation,
      priority: "interactive",
    },
    run,
  );
}

function currentFilesystemState() {
  const state = currentProjectFilesystemQuotaState();
  if (!state || fs == null || state.mountpoint !== fs.opts.mount) {
    throw new Error("project filesystem quota state is not initialized");
  }
  return state;
}

async function recordManagedProjectVolume({
  project_id,
  scratch,
  path,
  force = false,
}: {
  project_id: string;
  scratch?: boolean;
  path: string;
  force?: boolean;
}): Promise<string> {
  if (fs == null) {
    throw Error("file server not initialized");
  }
  const volume_kind = managedVolumeKind(scratch);
  const existing = getProjectVolume(project_id, volume_kind);
  const filesystem = currentFilesystemState();
  if (
    !force &&
    existing?.present &&
    existing.mountpoint === fs.opts.mount &&
    existing.relative_path === volumeName(project_id, scratch) &&
    existing.filesystem_uuid === filesystem.filesystem_uuid
  ) {
    return projectVolumeIdentityKey(existing);
  }
  const identity = await getSubvolumeIdentity(path, { cache: !force });
  const recorded = recordProjectVolume({
    project_id,
    volume_kind,
    mountpoint: fs.opts.mount,
    relative_path: volumeName(project_id, scratch),
    identity: {
      ...identity,
      filesystem_uuid: filesystem.filesystem_uuid,
    },
  });
  if (recorded.changed) {
    invalidateProjectVolumeQuota({
      project_id,
      volume_kind,
      reason: "managed volume identity changed",
    });
  }
  return projectVolumeIdentityKey(recorded.row);
}

export async function ensureProjectVolumeIdentity(
  project_id: string,
  scratch?: boolean,
): Promise<string> {
  const recorded = getRecordedProjectVolumeIdentity(
    project_id,
    managedVolumeKind(scratch),
  );
  if (recorded) return recorded;
  const vol = await getVolume(project_id, scratch);
  return await recordManagedProjectVolume({
    project_id,
    scratch,
    path: vol.path,
    force: true,
  });
}

function requireHostId(): string {
  const id = getLocalHostId();
  if (!id) {
    throw Error("project-host id not set");
  }
  return id;
}

let fs: Filesystem | null = null;

function projectIdFromSubject(subject: string): string {
  const parts = subject.split(".");
  if (parts.length !== 2) {
    throw Error("subject must have 2 segments");
  }
  const raw = parts[1];
  if (!raw.startsWith("project-")) {
    throw Error("second segment must start with 'project-'");
  }
  const project_id = raw.slice("project-".length);
  if (!isValidUUID(project_id)) {
    throw Error("not a valid project id");
  }
  return project_id;
}

function viewerSubjectFromSubject(subject: string): {
  project_id: string;
  account_id: string;
} {
  const parsed = parseViewerFsSubject(subject);
  if (!parsed) {
    throw Error("invalid viewer fs subject");
  }
  return parsed;
}

function shareSubjectFromSubject(subject: string): {
  project_id: string;
  share_id: string;
  account_id: string;
} {
  const parsed = parseShareFsSubject(subject);
  if (!parsed) {
    throw Error("invalid share fs subject");
  }
  return parsed;
}

async function getTemporaryViewerReadPolicy({
  project_id,
  account_id,
}: {
  project_id: string;
  account_id: string;
}): Promise<ProjectViewerReadPolicy | undefined> {
  const client = getMasterConatClient();
  if (!client) {
    return undefined;
  }
  let response: GetTemporaryViewerReadPolicyResponse;
  try {
    response = (await callHub({
      client,
      host_id: requireHostId(),
      name: "publicDirectoryShares.getTemporaryViewerReadPolicy",
      args: [{ account_id, project_id }],
      timeout: 15_000,
    })) as GetTemporaryViewerReadPolicyResponse;
  } catch {
    return undefined;
  }
  if (
    response.project_id !== project_id ||
    response.account_id !== account_id
  ) {
    throw Error("temporary viewer grant authorization mismatch");
  }
  return response.read_policy;
}

async function getViewerReadPolicy({
  project_id,
  account_id,
}: {
  project_id: string;
  account_id: string;
}): Promise<ProjectViewerReadPolicy> {
  const row = getProject(project_id);
  const userEntry = row?.users?.[account_id];
  const group = typeof userEntry === "string" ? userEntry : userEntry?.group;
  const readPolicy =
    typeof userEntry === "string" ? undefined : userEntry?.read_policy;
  const temporaryPolicy = await getTemporaryViewerReadPolicy({
    project_id,
    account_id,
  });
  if (
    isProjectViewerRole(group) &&
    readPolicy &&
    Array.isArray(readPolicy.rules)
  ) {
    return temporaryPolicy
      ? { rules: [...readPolicy.rules, ...temporaryPolicy.rules] }
      : readPolicy;
  }
  if (temporaryPolicy && Array.isArray(temporaryPolicy.rules)) {
    return temporaryPolicy;
  }
  if (!isProjectViewerRole(group)) {
    throw new Error("account is not a viewer on this project");
  }
  if (!readPolicy || !Array.isArray(readPolicy.rules)) {
    throw new Error("viewer read policy is not configured");
  }
  return readPolicy;
}

async function getShareReadPolicy({
  project_id,
  share_id,
  account_id,
}: {
  project_id: string;
  share_id: string;
  account_id: string;
}): Promise<ProjectViewerReadPolicy> {
  const client = getMasterConatClient();
  if (!client) {
    throw Error("master Conat client is not initialized");
  }
  const response = (await callHub({
    client,
    host_id: requireHostId(),
    name: "publicDirectoryShares.authorizeRead",
    args: [{ account_id, project_id, share_id }],
    timeout: 15_000,
  })) as AuthorizePublicDirectoryShareReadResponse;
  if (response.project_id !== project_id || response.share_id !== share_id) {
    throw Error("public directory share authorization mismatch");
  }
  if (!response.read_policy || !Array.isArray(response.read_policy.rules)) {
    throw Error("public directory share read policy is not configured");
  }
  return response.read_policy;
}

function snapshotRestoreRoot(): string {
  return join(resolveProjectMountRoot(), SNAPSHOT_RESTORE_STAGING_ROOT);
}

async function ensureSnapshotRestoreRoot(): Promise<string> {
  const root = snapshotRestoreRoot();
  await sudo({ command: "mkdir", args: ["-p", root] });
  return root;
}

async function createSnapshotRestoreTempPath(prefix: string): Promise<string> {
  const root = await ensureSnapshotRestoreRoot();
  return join(root, `${prefix}${randomUUID()}`);
}

async function createImageCacheTempSubvolume(prefix: string): Promise<string> {
  await mkdir(IMAGE_CACHE, { recursive: true });
  const path = join(IMAGE_CACHE, `${prefix}${randomUUID()}`);
  await btrfs({
    args: ["subvolume", "create", path],
    err_on_exit: true,
    verbose: false,
  });
  return path;
}

async function createOverlayMountTempPath(): Promise<string> {
  await mkdir(PROJECT_ROOTS_CACHE, { recursive: true });
  const path = join(PROJECT_ROOTS_CACHE, randomUUID());
  await mkdir(path, { recursive: true });
  return path;
}

async function replaceTreeByMove({
  src,
  dest,
}: {
  src?: string;
  dest: string;
}): Promise<void> {
  if (await exists(dest)) {
    await sudo({ command: "rm", args: ["-rf", dest] });
  }
  if (!src || !(await exists(src))) {
    return;
  }
  await sudo({ command: "mkdir", args: ["-p", dirname(dest)] });
  await sudo({ command: "mv", args: [src, dest] });
}

async function removeDirectoryTree(pathToRemove?: string): Promise<void> {
  if (!pathToRemove || !(await exists(pathToRemove))) return;
  await sudo({ command: "rm", args: ["-rf", pathToRemove] });
}

async function mountOverlayForPublish({
  lowerdir,
  upperdir,
  workdir,
  merged,
}: {
  lowerdir: string;
  upperdir: string;
  workdir: string;
  merged: string;
}): Promise<void> {
  await executeCode({
    verbose: false,
    err_on_exit: true,
    timeout: ROOTFS_PUBLISH_TIMEOUT_S,
    command: "sudo",
    args: [
      "-n",
      STORAGE_WRAPPER,
      "mount-overlay-project",
      lowerdir,
      upperdir,
      workdir,
      merged,
    ],
  });
}

async function unmountOverlayForPublish(merged: string): Promise<void> {
  await executeCode({
    verbose: false,
    timeout: ROOTFS_PUBLISH_TIMEOUT_S,
    command: "sudo",
    args: ["-n", STORAGE_WRAPPER, "umount-overlay-project", merged],
  }).catch(() => {});
}

async function rsyncTree({
  src,
  dest,
}: {
  src: string;
  dest: string;
}): Promise<void> {
  // This is used to materialize a merged overlayfs view into a publishable
  // tree. We intentionally do not preserve hardlinks from the merged view,
  // because overlayfs inode identity is not reliable enough for rsync -H and
  // can create bogus hardlinks between unrelated files in child images.
  await sudo({
    verbose: false,
    timeout: ROOTFS_PUBLISH_TIMEOUT_S,
    command: "copy-tree-preserve",
    args: [src, dest],
  });
}

async function tarSha256(pathToHash: string): Promise<string> {
  const { stdout } = await sudo({
    verbose: false,
    timeout: ROOTFS_PUBLISH_TIMEOUT_S,
    command: "tar-sha256-tree",
    args: [pathToHash],
  });
  const digest = `${stdout ?? ""}`.trim();
  if (!digest) {
    throw new Error("failed to compute published rootfs digest");
  }
  return digest;
}

async function directorySizeBytes(pathToMeasure: string): Promise<number> {
  const result = await sudo({
    verbose: false,
    err_on_exit: false,
    timeout: ROOTFS_PUBLISH_TIMEOUT_S,
    command: "du-bytes",
    args: [pathToMeasure],
  });
  const value = Number.parseInt(`${result.stdout}`.trim().split(/\s+/)[0], 10);
  if (!Number.isFinite(value)) {
    throw new Error(
      `failed to measure published rootfs size for ${pathToMeasure}`,
    );
  }
  if (result.exit_code !== 0) {
    logger.debug("du-bytes exited nonzero but returned a usable size", {
      path: pathToMeasure,
      exit_code: result.exit_code,
      stderr: result.stderr,
    });
  }
  return value;
}

async function backupRootfsTreeToRustic({
  sourcePath,
  backupHost,
  upload,
  lro,
  timings,
  timingPhase = "rustic_backup",
}: {
  sourcePath: string;
  backupHost: string;
  upload: Extract<RootfsArtifactTransferTarget, { backend: "rustic" }>;
  lro?: LroRef;
  timings?: ReturnType<typeof createPhaseTimingRecorder>;
  timingPhase?: string;
}): Promise<Extract<RootfsUploadedArtifactResult, { backend: "rustic" }>> {
  logger.info("rootfs rustic backup start", {
    backupHost,
    sourcePath,
    repo_selector: upload.repo_selector,
    artifact_backend: upload.artifact_backend,
  });
  const repoProfile = await ensureRootfsRusticRepoProfile({
    repo_selector: upload.repo_selector,
    repo_toml: upload.repo_toml,
  });
  const progress = createLroRusticReporter(lro, "upload");
  const progressHandler = progress
    ? createRusticProgressHandler({ onProgress: progress })
    : undefined;
  let stderrBuffer = "";
  const pushProgressChunk = (chunk?: string) => {
    if (!progressHandler || !chunk) return;
    stderrBuffer += chunk.replace(/\r/g, "\n");
    const parts = stderrBuffer.split("\n");
    stderrBuffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.trim();
      if (line) {
        progressHandler(line);
      }
    }
  };
  const flushProgressChunk = () => {
    if (!progressHandler) return;
    const line = stderrBuffer.trim();
    stderrBuffer = "";
    if (line) {
      progressHandler(line);
    }
  };
  const tagArgs = ["--tag", "rootfs-release"];
  const profileArg = repoProfile.endsWith(".toml")
    ? repoProfile.slice(0, -5)
    : repoProfile;
  const runBackup = async () =>
    (await executeCode({
      verbose: false,
      err_on_exit: true,
      timeout: 6 * 60 * 60,
      command: "sudo",
      args: [
        "-n",
        STORAGE_WRAPPER,
        "rootfs-rustic-backup",
        sourcePath,
        profileArg,
        backupHost,
        ...tagArgs,
      ],
      env: progress ? { RUSTIC_PROGRESS_INTERVAL: "1s" } : undefined,
      streamCB: (event) => {
        if (event.type === "stderr" && typeof event.data === "string") {
          pushProgressChunk(event.data);
        } else if (event.type === "done") {
          flushProgressChunk();
        }
      },
    })) as { stdout: string };
  const { stdout } = timings
    ? await timings.measure(timingPhase, runBackup)
    : await runBackup();
  logger.info("rootfs rustic backup finished", {
    backupHost,
    sourcePath,
  });
  const parsed = JSON.parse(stdout);
  const snapshot_id = `${parsed?.id ?? ""}`.trim();
  if (!snapshot_id) {
    throw new Error("rustic backup did not return a snapshot id");
  }
  const summary = parsed?.summary ?? {};
  const packedBytes =
    Number(summary?.data_added_packed) ||
    Number(summary?.data_added) ||
    Number(summary?.total_bytes_processed) ||
    0;
  return {
    ok: true,
    backend: "rustic",
    artifact_kind: "full",
    artifact_format: "rustic",
    artifact_backend: upload.artifact_backend,
    artifact_sha256: snapshot_id,
    artifact_bytes: packedBytes,
    artifact_path: snapshot_id,
    snapshot_id,
    repo_selector: upload.repo_selector,
    repo_id: upload.repo_id,
    repo_root: upload.repo_root,
    region: upload.region,
    bucket_id: upload.bucket_id,
    bucket_name: upload.bucket_name,
    bucket_purpose: upload.bucket_purpose,
    phase_timings_ms: timings?.phase_timings_ms,
  };
}

async function btrfsSnapshotReadonly({
  source,
  dest,
}: {
  source: string;
  dest: string;
}): Promise<void> {
  await btrfs({
    args: ["subvolume", "snapshot", "-r", source, dest],
    err_on_exit: true,
    verbose: false,
  });
}

async function btrfsSnapshotWritable({
  source,
  dest,
}: {
  source: string;
  dest: string;
}): Promise<void> {
  await btrfs({
    args: ["subvolume", "snapshot", source, dest],
    err_on_exit: true,
    verbose: false,
  });
}

async function btrfsSetSubvolumeReadonly({
  path,
  readOnly,
}: {
  path: string;
  readOnly: boolean;
}): Promise<void> {
  await btrfs({
    args: ["property", "set", "-ts", path, "ro", readOnly ? "true" : "false"],
    err_on_exit: true,
    verbose: false,
  });
}

async function deleteSubvolumeTree(pathToDelete?: string): Promise<void> {
  if (!pathToDelete || !(await exists(pathToDelete))) return;
  const root = resolveProjectMountRoot();
  if (!isSubPath(root, pathToDelete)) {
    throw new Error(
      `refusing to delete subvolume outside mount root: ${pathToDelete}`,
    );
  }
  const rel = path.relative(root, pathToDelete);
  const tmp = await subvolume({ filesystem: fs!, name: rel, noCache: true });
  const snapshots = await tmp.snapshots.readdir().catch(() => []);
  for (const snapshot of snapshots) {
    await tmp.snapshots.delete(snapshot);
  }
  await btrfs({
    args: ["subvolume", "delete", pathToDelete],
    err_on_exit: true,
    verbose: false,
  });
}

async function createSnapshotRestoreClone({
  project_id,
  snapshot,
  applyQuota = true,
}: {
  project_id: string;
  snapshot: string;
  applyQuota?: boolean;
}): Promise<{ path: string }> {
  if (fs == null) {
    throw Error("file server not initialized");
  }
  const vol = await getVolume(project_id);
  if (!(await vol.snapshots.exists(snapshot))) {
    throw new Error(`snapshot does not exist: ${snapshot}`);
  }
  const stagingRoot = await ensureSnapshotRestoreRoot();
  const stagedPath = join(
    stagingRoot,
    `${volName(project_id)}.snapshot-restore.${randomUUID()}`,
  );
  const snapshotPath = join(vol.path, vol.snapshots.path(snapshot));
  await btrfs({
    args: ["subvolume", "snapshot", snapshotPath, stagedPath],
    err_on_exit: true,
    verbose: false,
  });
  const { size } = await vol.quota.get();
  if (applyQuota && size) {
    const rel = path.relative(resolveProjectMountRoot(), stagedPath);
    const stagedSubvolume = await subvolume({
      filesystem: fs,
      name: rel,
      noCache: true,
    });
    await stagedSubvolume.quota.set(size);
  }
  return { path: stagedPath };
}

async function swapProjectHome({
  project_id,
  replacementPath,
}: {
  project_id: string;
  replacementPath: string;
}): Promise<{ oldHomePath: string }> {
  const home = projectMountpoint(project_id);
  if (!(await exists(home))) {
    throw new Error(`project home does not exist: ${home}`);
  }
  const stagingRoot = await ensureSnapshotRestoreRoot();
  const oldHomePath = join(
    stagingRoot,
    `${volName(project_id)}.restore-old.${randomUUID()}`,
  );
  invalidateProjectVolumeQuota({
    project_id,
    volume_kind: "home",
    reason: "project home replacement started",
  });
  markProjectVolumeAbsent(project_id, "home");
  await sudo({ command: "mv", args: [home, oldHomePath] });
  await sudo({ command: "mv", args: [replacementPath, home] });
  await recordManagedProjectVolume({
    project_id,
    path: home,
    force: true,
  });
  return { oldHomePath };
}

async function rollbackProjectHomeSwap({
  project_id,
  oldHomePath,
}: {
  project_id: string;
  oldHomePath: string;
}): Promise<void> {
  const home = projectMountpoint(project_id);
  if (await exists(home)) {
    const failedHomePath = join(
      snapshotRestoreRoot(),
      `${volName(project_id)}.restore-failed.${randomUUID()}`,
    );
    await sudo({ command: "mv", args: [home, failedHomePath] });
    await deleteSubvolumeTree(failedHomePath).catch(() => {});
  }
  if (await exists(oldHomePath)) {
    await sudo({ command: "mv", args: [oldHomePath, home] });
    await recordManagedProjectVolume({
      project_id,
      path: home,
      force: true,
    });
  }
}

async function createSafetySnapshotFromPath({
  snapshotPath,
  project_id,
  snapshot,
}: {
  snapshotPath: string;
  project_id: string;
  snapshot: string;
}): Promise<void> {
  snapshot = assertValidSnapshotName(snapshot);
  if (!(await exists(snapshotPath))) return;
  const home = projectMountpoint(project_id);
  const destDir = join(home, ".snapshots");
  const dest = join(destDir, snapshot);
  await sudo({ command: "mkdir", args: ["-p", destDir] });
  if (await exists(dest)) {
    throw new Error(`snapshot already exists after restore: ${snapshot}`);
  }
  await btrfs({
    args: ["subvolume", "snapshot", "-r", snapshotPath, dest],
    err_on_exit: true,
    verbose: false,
  });
}

export async function getVolume(project_id: string, scratch?: boolean) {
  if (fs == null) {
    throw Error("file server not initialized");
  }
  const vol = await fs.subvolumes.get(volumeName(project_id, scratch));
  if (!(await exists(vol.path))) {
    throw new Error(`project volume does not exist: ${vol.path}`);
  }
  const isSubvolume = await isBtrfsSubvolume(vol.path);
  if (!isSubvolume) {
    throw new Error(`project volume is not a btrfs subvolume: ${vol.path}`);
  }
  return vol;
}

async function getOrEnsureVolume(project_id: string) {
  if (fs == null) {
    throw Error("file server not initialized");
  }
  const vol = await fs.subvolumes.get(volName(project_id));
  if (!(await exists(vol.path))) {
    return await ensureVolume(project_id, undefined, {
      reportProvisioned: false,
    });
  }
  const isSubvolume = await isBtrfsSubvolume(vol.path);
  if (!isSubvolume) {
    throw new Error(`project volume is not a btrfs subvolume: ${vol.path}`);
  }
  return vol;
}

export async function ensureVolume(
  project_id: string,
  scratch?: boolean,
  opts: { reportProvisioned?: boolean } = {},
) {
  if (fs == null) {
    throw Error("file server not initialized");
  }
  const existing = getProjectVolume(project_id, managedVolumeKind(scratch));
  const filesystem = currentFilesystemState();
  const existed = await exists(
    join(fs.opts.mount, volumeName(project_id, scratch)),
  );
  const vol = await fs.subvolumes.ensure(volumeName(project_id, scratch));
  if (
    !existing?.present ||
    !existed ||
    existing.filesystem_uuid !== filesystem.filesystem_uuid ||
    existing.mountpoint !== fs.opts.mount
  ) {
    await recordManagedProjectVolume({
      project_id,
      scratch,
      path: vol.path,
      force: true,
    });
  }
  invalidateProjectFsServer(project_id);
  if (!scratch && opts.reportProvisioned !== false) {
    queueProjectProvisioned(project_id, true);
  }
  return vol;
}

export async function resetScratchVolume(
  project_id: string,
  opts: {
    expected_lifecycle_generation?: number;
    onTiming?: (phase: string, duration_ms: number) => void;
  } = {},
) {
  if (fs == null) {
    throw Error("file server not initialized");
  }
  const measure = async <T>(phase: string, fn: () => Promise<T>) => {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      try {
        opts.onTiming?.(phase, Date.now() - started);
      } catch (err) {
        logger.warn("scratch reset timing callback failed", {
          project_id,
          phase,
          err: `${err}`,
        });
      }
    }
  };
  return await withProjectVolumeLifecycleLock(project_id, async () => {
    if (opts.expected_lifecycle_generation != null) {
      assertProjectVolumeLifecycleGeneration(
        project_id,
        opts.expected_lifecycle_generation,
      );
    }
    const name = scratchVolName(project_id);
    const vol = await measure(
      "get",
      async () => await fs!.subvolumes.get(name),
    );
    invalidateProjectVolumeQuota({
      project_id,
      volume_kind: "scratch",
      reason: "scratch volume reset started",
    });
    markProjectVolumeAbsent(project_id, "scratch");
    if (await measure("exists", async () => await exists(vol.path))) {
      await measure("delete", async () => await fs!.subvolumes.delete(name));
    }
    const next = await measure(
      "create",
      async () => await fs!.subvolumes.ensure(name),
    );
    await measure("record", async () => {
      await recordManagedProjectVolume({
        project_id,
        scratch: true,
        path: next.path,
        force: true,
      });
    });
    invalidateProjectFsServer(project_id);
    invalidateQuotaCache(project_id, true);
    return next;
  });
}

export async function deleteVolume(
  project_id: string,
  opts: {
    reportProvisioned?: boolean;
    expected_archive_backup_id?: string;
    expected_archive_generation?: number;
  } = {},
) {
  if (fs == null) {
    throw Error("file server not initialized");
  }
  invalidateProjectVolumeLifecycle(project_id);
  await withProjectVolumeLifecycleLock(project_id, async () => {
    const deleteIfExists = async ({
      name,
      volume_kind,
      clearSnapshots = false,
    }: {
      name: string;
      volume_kind: "home" | "scratch";
      clearSnapshots?: boolean;
    }) => {
      const vol = await fs!.subvolumes.get(name);
      if (!(await exists(vol.path))) {
        if (volume_kind === "home") {
          await deleteStagedArchiveSnapshots(vol);
        }
        markProjectVolumeAbsent(project_id, volume_kind);
        return;
      }
      if (clearSnapshots) {
        try {
          const snapshots = await vol.snapshots.readdir();
          for (const snapshot of snapshots) {
            await vol.snapshots.delete(snapshot);
          }
        } catch (err) {
          logger.warn("deleteVolume: snapshot cleanup failed", {
            project_id,
            name,
            err: `${err}`,
          });
        }
      }
      await fs!.subvolumes.delete(name);
      if (volume_kind === "home") {
        // Automatic archive staging lives outside the project subvolume. This
        // also covers deferred inventory cleanup after an unavailable host
        // returns, including the idempotent parent-already-absent case above.
        await deleteStagedArchiveSnapshots(vol);
      }
      markProjectVolumeAbsent(project_id, volume_kind);
    };

    if (opts.expected_archive_generation == null) {
      await deleteIfExists({
        name: volName(project_id),
        volume_kind: "home",
        clearSnapshots: true,
      });
      await deleteIfExists({
        name: scratchVolName(project_id),
        volume_kind: "scratch",
      });
    } else {
      const expectedBackupId =
        `${opts.expected_archive_backup_id ?? ""}`.trim();
      if (!expectedBackupId) {
        throw new Error("an archive backup snapshot id is required");
      }
      const expectedGeneration = Number(opts.expected_archive_generation);
      if (
        !Number.isSafeInteger(expectedGeneration) ||
        expectedGeneration <= 0
      ) {
        throw new Error("a valid archive backup generation is required");
      }
      const volume = await getVolumeForBackup(project_id);
      try {
        if (!(await volume.rustic.snapshotExists({ id: expectedBackupId }))) {
          throw new Error(
            `refusing to archive project because final backup ${expectedBackupId} no longer exists`,
          );
        }
        const status = await assertFrozenVolumeMatchesBackup({
          volume,
          expectedGeneration,
        });
        // Scratch is ephemeral. Delete it before the durable home volume so a
        // scratch cleanup failure can never reopen a project after home data
        // was already removed. The durable backup was verified first.
        await deleteIfExists({
          name: scratchVolName(project_id),
          volume_kind: "scratch",
        });
        if (status === "present") {
          await fs!.subvolumes.delete(volName(project_id));
        }
        await deleteStagedArchiveSnapshots(volume);
        markProjectVolumeAbsent(project_id, "home");
      } catch (err) {
        // If cleanup did not complete, return the retained volume to a writable
        // state before a retry. A missing volume is the idempotent-success case
        // and releaseArchiveVolumeFreeze is a no-op.
        await releaseArchiveVolumeFreeze(volume).catch((releaseErr) => {
          logger.error("unable to release failed archive deletion freeze", {
            project_id,
            err: `${releaseErr}`,
          });
        });
        throw err;
      }
    }
    deleteProjectVolumeQuotas(project_id);
    deleteProjectVolumeQuotaOverrides(project_id);
    invalidateProjectFsServer(project_id);
  });
  if (opts.reportProvisioned !== false) {
    queueProjectProvisioned(project_id, false);
  }
  await deleteBackupIndexCache(project_id);
}

export async function releaseProjectArchiveFreeze(
  project_id: string,
  expected_generation: number,
): Promise<{ status: "absent" | "already-writable" | "released" }> {
  if (fs == null) {
    throw Error("file server not initialized");
  }
  return await withProjectVolumeLifecycleLock(project_id, async () => {
    const volume = await fs!.subvolumes.get(volName(project_id));
    const status = await releaseArchiveVolumeFreezeIfGenerationMatches({
      volume,
      expectedGeneration: expected_generation,
    });
    return { status };
  });
}

async function getVolumeUnchecked(project_id: string) {
  if (fs == null) {
    throw Error("file server not initialized");
  }
  return await fs.subvolumes.get(volName(project_id));
}

async function getVolumeForBackup(project_id: string) {
  const vol = await getVolumeUnchecked(project_id);
  // Safe to override: each Subvolume owns its SandboxedFilesystem instance.
  vol.fs.rusticRepo = await resolveRusticRepo(project_id);
  return vol;
}

export function getMountPoint(): string {
  if (fs == null) {
    throw Error("file server not initialized");
  }
  return fs.opts.mount;
}

function resolveProjectMountRoot(): string {
  if (fs != null) {
    return fs.opts.mount;
  }
  if (fileServerMountpoint) {
    return fileServerMountpoint;
  }
  return join(data, "btrfs", "mnt");
}

export function getFileServerRuntimeStatus():
  | {
      mount: string;
      bees: ReturnType<Filesystem["getBeesStatus"]>;
      quota_queue: ReturnType<Filesystem["getQuotaQueueStatus"]>;
    }
  | undefined {
  if (fs == null) return undefined;
  return {
    mount: fs.opts.mount,
    bees: fs.getBeesStatus(),
    quota_queue: fs.getQuotaQueueStatus(),
  };
}

export async function listProvisionedProjects(): Promise<string[]> {
  return listProvisionedProjectIdsFromInventory();
}

async function cleanupOrphanedArchiveSnapshotStaging(): Promise<void> {
  if (fs == null) {
    throw Error("file server not initialized");
  }
  let cleaned = 0;
  let errors = 0;
  for (const name of await listStagedArchiveVolumeNames(fs.opts.mount)) {
    const match = name.match(/^project-([0-9a-f-]{36})$/i);
    if (!match || !isValidUUID(match[1])) continue;
    try {
      const volume = await fs.subvolumes.get(name);
      const status = await deleteOrphanedStagedArchiveSnapshots(volume);
      if (status === "deleted") cleaned += 1;
    } catch (err) {
      errors += 1;
      logger.warn("orphaned archive snapshot staging cleanup failed", {
        project_id: match[1].toLowerCase(),
        err: `${err}`,
      });
    }
  }
  if (cleaned || errors) {
    logger.info("orphaned archive snapshot staging cleanup complete", {
      cleaned,
      errors,
    });
  }
}

export async function bootstrapProvisionedProjectInventory(): Promise<
  string[] | undefined
> {
  if (fs == null) {
    throw Error("file server not initialized");
  }
  await cleanupOrphanedArchiveSnapshotStaging();
  const filesystem = currentFilesystemState();
  if (projectVolumeInventoryBootstrapped(filesystem.filesystem_uuid)) {
    return;
  }
  const listed = await fs.subvolumes.listWithIdentity();
  const volumes: Parameters<
    typeof bootstrapProjectVolumeInventory
  >[0]["volumes"] = [];
  for (const entry of listed) {
    const match = entry.path.match(/^project-([0-9a-f-]{36})(-scratch)?$/i);
    if (!match || !isValidUUID(match[1])) continue;
    volumes.push({
      project_id: match[1].toLowerCase(),
      volume_kind: match[2] ? "scratch" : "home",
      mountpoint: fs.opts.mount,
      relative_path: entry.path,
      identity: {
        filesystem_uuid: filesystem.filesystem_uuid,
        subvolume_id: entry.subvolume_id,
        volume_uuid: entry.volume_uuid,
        generation: entry.generation,
      },
    });
  }
  bootstrapProjectVolumeInventory({
    filesystem_uuid: filesystem.filesystem_uuid,
    mountpoint: fs.opts.mount,
    volumes,
  });
  logger.info("bootstrapped managed project volume inventory", {
    filesystem_uuid: filesystem.filesystem_uuid,
    volumes: volumes.length,
  });
  return listProvisionedProjectIdsFromInventory();
}

export async function verifyProvisionedProjectInventoryBatch(
  limit = 32,
): Promise<{
  checked: number;
  missing: number;
  identity_changed: number;
  errors: number;
}> {
  if (fs == null) {
    throw Error("file server not initialized");
  }
  await cleanupOrphanedArchiveSnapshotStaging();
  const filesystem = currentFilesystemState();
  const counts = {
    checked: 0,
    missing: 0,
    identity_changed: 0,
    errors: 0,
  };
  for (const row of nextProjectVolumeVerificationBatch(limit)) {
    counts.checked += 1;
    const path = join(row.mountpoint, row.relative_path);
    try {
      if (
        row.mountpoint !== fs.opts.mount ||
        row.filesystem_uuid !== filesystem.filesystem_uuid ||
        !(await exists(path))
      ) {
        if (markProjectVolumeAbsent(row.project_id, row.volume_kind)) {
          invalidateProjectVolumeQuota({
            project_id: row.project_id,
            volume_kind: row.volume_kind,
            reason: "managed volume missing during bounded inventory audit",
          });
          if (row.volume_kind === "home") {
            queueProjectProvisioned(row.project_id, false);
          }
        }
        counts.missing += 1;
        continue;
      }
      const identity = await getSubvolumeIdentity(path, { cache: false });
      const recorded = recordProjectVolume({
        project_id: row.project_id,
        volume_kind: row.volume_kind,
        mountpoint: fs.opts.mount,
        relative_path: row.relative_path,
        identity: {
          ...identity,
          filesystem_uuid: filesystem.filesystem_uuid,
        },
      });
      if (recorded.changed) {
        counts.identity_changed += 1;
        invalidateProjectVolumeQuota({
          project_id: row.project_id,
          volume_kind: row.volume_kind,
          reason: "managed volume identity changed during bounded audit",
        });
      }
    } catch (err) {
      counts.errors += 1;
      logger.warn("managed project volume inventory verification failed", {
        project_id: row.project_id,
        volume_kind: row.volume_kind,
        path,
        err: `${err}`,
      });
    }
  }
  return counts;
}

function projectMountpoint(project_id: string): string {
  return join(resolveProjectMountRoot(), volName(project_id));
}

export function getScratchMountpoint(project_id: string): string {
  return join(getMountPoint(), scratchVolName(project_id));
}

function truthyEnv(value: string | undefined): boolean {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

export function getSharedScratchMountpoint(): string | undefined {
  if (!truthyEnv(process.env.COCALC_SHARED_SCRATCH_ENABLED)) {
    return undefined;
  }
  const mount =
    `${process.env.COCALC_SHARED_SCRATCH_HOST_MOUNT ?? "/mnt/cocalc-scratch"}`.trim();
  return mount.startsWith("/") ? mount : undefined;
}

export function getProjectSandboxFilesystem(
  project_id: string,
): SandboxedFilesystem {
  return createProjectSandboxFilesystem({
    project_id,
    home: projectMountpoint(project_id),
    rootfs: getRootfsMountpoint(project_id),
    scratch: getScratchMountpoint(project_id),
    sharedScratch: getSharedScratchMountpoint(),
  });
}

function isSubPath(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function normalizeProjectRelativePath(rawPath: string): string {
  const normalized = path.posix.normalize(rawPath.replace(/\\/g, "/"));
  if (normalized === "." || normalized === "/") {
    return "";
  }
  const runtimeRelative = projectRuntimeHomeRelativePath(normalized);
  if (runtimeRelative != null) {
    return runtimeRelative;
  }
  return normalized.replace(/^\/+/, "");
}

function isProjectRootfsRelativePath(rawPath: string): boolean {
  const relativePath = normalizeProjectRelativePath(rawPath);
  return (
    relativePath === PROJECT_IMAGE_PATH ||
    relativePath.startsWith(`${PROJECT_IMAGE_PATH}/`)
  );
}

function needsPrivilegedProjectRestore({
  root,
  scratch,
  restorePath,
  relDest,
}: {
  root: string;
  scratch: string;
  restorePath: string;
  relDest: string;
}): boolean {
  if (!restorePath) {
    return root !== scratch;
  }
  if (isProjectRootfsRelativePath(restorePath)) {
    return true;
  }
  if (root === scratch) {
    return false;
  }
  return relDest.length > 0 && isProjectRootfsRelativePath(relDest);
}

async function assertBackupSnapshotExists({
  project_id,
  id,
}: {
  project_id: string;
  id: string;
}): Promise<void> {
  const profilePath = await resolveRusticRepo(project_id);
  const snapshotHost = await getRusticSnapshotHost({
    id,
    repo: profilePath,
    timeout: BACKUP_SNAPSHOT_LOOKUP_TIMEOUT_MS,
  });
  if (snapshotHost !== `project-${project_id}` && snapshotHost !== project_id) {
    throw new Error(`backup ${id} not found for project ${project_id}`);
  }
}

const backupConfigCache = new Map<
  string,
  {
    toml: string;
    expiresAt: number;
    path: string;
    index_store?: ProjectBackupIndexStoreConfig | null;
  }
>();
let backupConfigInvalidationSub: any = null;
const BACKUP_CONFIG_FETCH_RETRY_MS = 5000;
const BACKUP_CONFIG_FETCH_TIMEOUT_MS = 2 * 60 * 1000;

function looksLikeMissingBackupBucketError(err: unknown): boolean {
  const s = `${err ?? ""}`.toLowerCase();
  return (
    s.includes("nosuchbucket") ||
    s.includes("specified bucket does not exist") ||
    s.includes("path `config` does not exist")
  );
}

export async function invalidateBackupConfig(
  project_id?: string,
): Promise<void> {
  if (!project_id) {
    backupConfigCache.clear();
    return;
  }
  backupConfigCache.delete(project_id);
  const profilePath = join(secrets, "rustic", `project-${project_id}.toml`);
  try {
    await rm(profilePath, { force: true });
  } catch (err) {
    logger.debug("backup profile removal failed (ignored)", {
      project_id,
      err: `${err}`,
    });
  }
}

async function withBackupConfigRefreshOnMissingBucket<T>({
  project_id,
  op,
  run,
}: {
  project_id: string;
  op: string;
  run: () => Promise<T>;
}): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!looksLikeMissingBackupBucketError(err)) {
      throw err;
    }
    logger.warn("backup op detected missing bucket; refreshing config", {
      project_id,
      op,
      err: `${err}`,
    });
    await invalidateBackupConfig(project_id);
    await ensureBackupConfig(project_id);
    return await run();
  }
}

async function startBackupConfigInvalidation(client: ConatClient) {
  if (backupConfigInvalidationSub) return;
  const hostId = getLocalHostId();
  if (!hostId) return;
  const subject = `project-host.${hostId}.backup.invalidate`;
  try {
    backupConfigInvalidationSub = await client.subscribe(subject);
  } catch (err) {
    logger.warn("backup config invalidation subscribe failed", {
      subject,
      err: String(err),
    });
    return;
  }
  (async () => {
    for await (const _msg of backupConfigInvalidationSub) {
      try {
        await invalidateBackupConfig();
      } catch (err) {
        logger.warn("backup config refresh failed", err);
      }
    }
  })().catch((err) =>
    logger.error("backup config invalidation loop failed", err),
  );
}

async function fetchBackupConfig(
  project_id: string,
): Promise<ProjectBackupConfig | null> {
  logger.debug("fetchBackupConfig", { project_id });
  const client = getMasterConatClient();
  if (!client) {
    logger.debug("ERROR: master");
    throw Error(
      "master conat client must be configured before calling fetchBackupConfig",
    );
  }
  void startBackupConfigInvalidation(client);
  if (!client) return null;
  const hostId = getLocalHostId();
  if (!hostId) return null;
  return await callHub({
    client,
    host_id: hostId,
    name: "hosts.getBackupConfig",
    args: [{ project_id }],
    timeout: 30000,
  });
}

async function reportBackupSuccess(
  project_id: string,
  time: Date,
  generation?: number | null,
): Promise<void> {
  const client = getMasterConatClient();
  if (!client) {
    logger.warn("backup success not reported: master conat client missing", {
      project_id,
    });
    return;
  }
  const hostId = getLocalHostId();
  if (!hostId) return;
  await callHub({
    client,
    host_id: hostId,
    name: "hosts.recordProjectBackup",
    args: [{ project_id, time, generation }],
    timeout: 30000,
  });
}

async function getLatestKnownBackupId(
  project_id: string,
): Promise<string | undefined> {
  const backups = await getBackups({ project_id, indexed_only: true });
  return backups.at(-1)?.id;
}

async function deleteRemoteProjectBackupIndex({
  project_id,
  backup_id,
}: {
  project_id: string;
  backup_id: string;
}): Promise<void> {
  const client = getMasterConatClient();
  if (!client) {
    throw new Error("master conat client missing");
  }
  const hostId = getLocalHostId();
  if (!hostId) {
    throw new Error("local host_id missing");
  }
  await callHub({
    client,
    host_id: hostId,
    name: "hosts.deleteProjectBackupIndex",
    args: [{ project_id, backup_id }],
    timeout: 30000,
  });
}

async function ensureBackupConfig(project_id: string): Promise<string | null> {
  logger.debug("ensureBackupConfig", { project_id });
  const profilePath = join(secrets, "rustic", `project-${project_id}.toml`);
  const profileDir = path.dirname(profilePath);
  const now = Date.now();
  const cached = backupConfigCache.get(project_id);
  if (cached && now < cached.expiresAt) {
    return cached.path;
  }
  const deadline = Date.now() + BACKUP_CONFIG_FETCH_TIMEOUT_MS;
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      const remoteConfig = await fetchBackupConfig(project_id);
      const toml = remoteConfig?.toml;
      if (!toml) return null;
      const ttlSeconds = remoteConfig?.ttl_seconds ?? 0;
      const fetchedAt = Date.now();
      backupConfigCache.set(project_id, {
        toml,
        expiresAt:
          ttlSeconds > 0
            ? fetchedAt + ttlSeconds * 1000
            : fetchedAt + 3600 * 1000,
        path: profilePath,
        index_store: remoteConfig?.index_store,
      });
      await mkdir(profileDir, { recursive: true });
      await writeFile(profilePath, toml, "utf8");
      await chmod(profilePath, 0o600);
      return profilePath;
    } catch (err) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `backup config fetch failed after ${attempt} attempt(s): ${err}`,
        );
      }
      logger.warn("backup config fetch failed; retrying", {
        project_id,
        attempt,
        remaining_ms: remainingMs,
        err: `${err}`,
      });
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(BACKUP_CONFIG_FETCH_RETRY_MS, remainingMs),
        ),
      );
    }
  }
}

async function getBackupIndexStoreConfig(
  project_id: string,
): Promise<ProjectBackupIndexStoreConfig | null> {
  const now = Date.now();
  const cached = backupConfigCache.get(project_id);
  if (cached && now < cached.expiresAt) {
    return cached.index_store ?? null;
  }
  await ensureBackupConfig(project_id);
  return backupConfigCache.get(project_id)?.index_store ?? null;
}

export async function resolveRusticRepo(project_id?: string): Promise<string> {
  if (!project_id) return rusticRepo;
  const profilePath = await ensureBackupConfig(project_id);
  if (!profilePath) {
    throw new Error(`missing backup config for project ${project_id}`);
  }
  return profilePath;
}

// Map a container path (relative to the runtime home) to an absolute host path
// inside the project's btrfs subvolume. Throws if the path escapes the project
// root or if an absolute path is outside the runtime home.
// Returns both the resolved path and the project base for additional checks.
function projectHostPath(
  project_id: string,
  containerPath: string,
): { hostPath: string; base: string } {
  // absolute host path to project root
  const base = projectMountpoint(project_id);
  const runtimeRelative = path.posix.isAbsolute(containerPath)
    ? projectRuntimeHomeRelativePath(containerPath)
    : undefined;
  if (path.posix.isAbsolute(containerPath) && runtimeRelative == null) {
    throw Error(
      `container path must be within project runtime home (${DEFAULT_PROJECT_RUNTIME_HOME}): ${containerPath}`,
    );
  }
  const rel = runtimeRelative ?? containerPath;
  const joined = path.normalize(path.join(base, rel));
  if (!joined.startsWith(base)) {
    throw Error(`path escapes project root: ${containerPath}`);
  }
  return { hostPath: joined, base };
}

function normalizeAdminDirectorySummaryRoot(rawPath?: string): string {
  const raw = `${rawPath ?? DEFAULT_ADMIN_DIRECTORY_SUMMARY_ROOT}`.trim();
  const absolute = raw.startsWith("/")
    ? path.posix.normalize(raw)
    : path.posix.normalize(
        path.posix.join(DEFAULT_ADMIN_DIRECTORY_SUMMARY_ROOT, raw),
      );
  if (
    absolute !== DEFAULT_ADMIN_DIRECTORY_SUMMARY_ROOT &&
    !absolute.startsWith(`${DEFAULT_ADMIN_DIRECTORY_SUMMARY_ROOT}/`)
  ) {
    throw new Error("directory summary path must be under /home/user");
  }
  return absolute;
}

function normalizeAdminDirectorySummaryLimit(limit?: number): number {
  const n = Number(limit ?? DEFAULT_ADMIN_DIRECTORY_SUMMARY_LIMIT);
  if (!Number.isFinite(n)) return DEFAULT_ADMIN_DIRECTORY_SUMMARY_LIMIT;
  return Math.max(1, Math.min(200, Math.floor(n)));
}

function normalizeAdminDirectorySummaryDepth(max_depth?: number): number {
  const n = Number(max_depth ?? DEFAULT_ADMIN_DIRECTORY_SUMMARY_DEPTH);
  if (!Number.isFinite(n)) return DEFAULT_ADMIN_DIRECTORY_SUMMARY_DEPTH;
  return Math.max(0, Math.min(3, Math.floor(n)));
}

function directorySummaryEntryType(entry: any): DirectorySummaryEntry["type"] {
  if (entry?.isDirectory?.()) return "directory";
  if (entry?.isFile?.()) return "file";
  if (entry?.isSymbolicLink?.()) return "symlink";
  return "other";
}

function shouldDescendAdminDirectory(containerPath: string): boolean {
  const name = path.posix.basename(containerPath);
  if (!name.startsWith(".")) return true;
  return name === ".ssh";
}

async function getDirectorySummary({
  project_id,
  path: rawPath,
  max_depth,
  limit,
}: {
  project_id: string;
  path?: string;
  max_depth?: number;
  limit?: number;
}): Promise<DirectorySummary> {
  const root = normalizeAdminDirectorySummaryRoot(rawPath);
  const normalizedDepth = normalizeAdminDirectorySummaryDepth(max_depth);
  const normalizedLimit = normalizeAdminDirectorySummaryLimit(limit);
  const rootHostPath = projectHostPath(project_id, root).hostPath;
  const entries: DirectorySummaryEntry[] = [];
  let truncated = false;

  const visit = async (
    containerDir: string,
    hostDir: string,
    depth: number,
  ): Promise<void> => {
    if (entries.length >= normalizedLimit) {
      truncated = true;
      return;
    }
    let dirents: any[];
    try {
      dirents = await readdir(hostDir, { withFileTypes: true });
    } catch (err) {
      entries.push({
        path: containerDir,
        type: "other",
        size: null,
        mtime: `unreadable: ${err}`,
      });
      return;
    }
    dirents.sort((a, b) => `${a.name}`.localeCompare(`${b.name}`));
    for (const entry of dirents) {
      if (entries.length >= normalizedLimit) {
        truncated = true;
        return;
      }
      const entryContainerPath = path.posix.join(containerDir, `${entry.name}`);
      const entryHostPath = path.join(hostDir, `${entry.name}`);
      const type = directorySummaryEntryType(entry);
      let size: number | null = null;
      let mtime: string | null = null;
      try {
        const st = await lstat(entryHostPath);
        size = Number.isFinite(st.size) ? st.size : null;
        mtime = st.mtime instanceof Date ? st.mtime.toISOString() : null;
      } catch {
        // Keep the summary useful if one entry disappears mid-scan.
      }
      entries.push({
        path: entryContainerPath,
        type,
        size,
        mtime,
      });
      if (
        type === "directory" &&
        depth < normalizedDepth &&
        shouldDescendAdminDirectory(entryContainerPath)
      ) {
        await visit(entryContainerPath, entryHostPath, depth + 1);
      }
    }
  };

  await visit(root, rootHostPath, 0);
  return {
    project_id,
    root,
    max_depth: normalizedDepth,
    limit: normalizedLimit,
    truncated,
    entries,
  };
}

export function configureProjectHostAcpContainerFileIO(): void {
  setContainerFileIO({
    mountPoint: projectMountpoint,
    readFile: async (project_id: string, p: string) => {
      return (await getProjectSandboxFilesystem(project_id).readFile(
        p,
        "utf8",
      )) as string;
    },
    writeFile: async (project_id: string, p: string, content: string) => {
      await getProjectSandboxFilesystem(project_id).writeFile(p, content);
    },
  });
}

export async function resolveProjectContainerPath(
  project_id: string,
  containerPath: string,
): Promise<string> {
  const fs = getProjectSandboxFilesystem(project_id);
  return await fs.safeAbsPath(containerPath);
}

async function mount({
  project_id,
  scratch,
}: {
  project_id: string;
  scratch?: boolean;
}): Promise<{ path: string }> {
  logger.debug("mount", { project_id, scratch });
  const path = scratch
    ? getScratchMountpoint(project_id)
    : projectMountpoint(project_id);
  if (await exists(path)) {
    return { path };
  }
  const vol = await ensureVolume(project_id, scratch, {
    // Resolving a data-plane path only proves that a local cache volume exists.
    // It does not prove that an unprovisioned project's backup was recovered.
    reportProvisioned: false,
  });
  return { path: vol.path };
}

async function clone({
  project_id,
  src_project_id,
}: {
  project_id: string;
  src_project_id: string;
}): Promise<void> {
  logger.debug("clone", { project_id });

  if (fs == null) {
    throw Error("file server not initialized");
  }
  await fs.subvolumes.clone(volName(src_project_id), volName(project_id));
  await recordManagedProjectVolume({
    project_id,
    path: projectMountpoint(project_id),
    force: true,
  });
  await resetClonedProjectState(projectMountpoint(project_id));
  queueProjectProvisioned(project_id, true);
}

async function getUsage({ project_id }: { project_id: string }): Promise<{
  size: number;
  used: number;
  free: number;
}> {
  logger.debug("getUsage", { project_id });
  const vol = await getVolume(project_id);
  return await vol.quota.usage();
}

async function getQuota({
  project_id,
  scratch,
}: {
  project_id: string;
  scratch?: boolean;
}): Promise<{
  size: number;
  used: number;
  qgroupid?: string;
  scope?: "subvolume";
  warning?: string;
}> {
  logger.debug("getQuota", { project_id, scratch });
  const cacheKey = quotaCacheKey(project_id, scratch);
  if (QUOTA_CACHE_TTL_MS > 0) {
    const cached = quotaCache.get(cacheKey);
    if (cached != null && cached.expires > Date.now()) {
      return cached.value;
    }
    const inflight = quotaInFlight.get(cacheKey);
    if (inflight != null) {
      return await inflight;
    }
  }
  const volName = volumeName(project_id, scratch);
  const load = (async () => {
    if (fs == null) {
      throw Error("file server not initialized");
    }
    const vol = await fs.subvolumes.get(volName);
    const value = await vol.quota.get();
    if (QUOTA_CACHE_TTL_MS > 0) {
      quotaCache.set(cacheKey, {
        expires: Date.now() + QUOTA_CACHE_TTL_MS,
        value,
      });
    }
    return value;
  })();
  if (QUOTA_CACHE_TTL_MS <= 0) {
    return await load;
  }
  quotaInFlight.set(cacheKey, load);
  try {
    return await load;
  } finally {
    if (quotaInFlight.get(cacheKey) === load) {
      quotaInFlight.delete(cacheKey);
    }
  }
}

async function applyManagedProjectVolumeQuotaRaw({
  project_id,
  volume_kind,
  size,
  force_write = false,
  operation_id,
  operation_class,
  priority = "interactive",
}: {
  project_id: string;
  volume_kind: "home" | "scratch";
  size: number;
  force_write?: boolean;
  operation_id?: string;
  operation_class: string;
  priority?: "lifecycle" | "interactive" | "scheduled" | "scavenger";
}): Promise<{ volume_identity: string }> {
  const target = Math.floor(size);
  if (!Number.isFinite(target) || target <= 0) {
    throw new Error("raw managed project quota must be finite and positive");
  }
  const scratch = volume_kind === "scratch";
  const vol = await getVolume(project_id, scratch);
  const volume_identity = await recordManagedProjectVolume({
    project_id,
    scratch,
    path: vol.path,
  });
  if (force_write || (await vol.quota.get()).size !== target) {
    await vol.quota.set(target, {
      project_id,
      volume_kind,
      operation_id,
      operation_class,
      priority,
    });
  }
  invalidateQuotaCache(project_id, scratch);
  return { volume_identity };
}

export async function reconcileManagedProjectVolumeQuota({
  project_id,
  volume_kind,
  operation_id,
  operation_class,
  priority,
  force_write,
}: {
  project_id: string;
  volume_kind: "home" | "scratch";
  operation_id?: string;
  operation_class: string;
  priority?: "lifecycle" | "interactive" | "scheduled" | "scavenger";
  force_write?: boolean;
}): Promise<number> {
  return await projectVolumeQuotaManager.applyEffectiveQuota({
    project_id,
    volume_kind,
    operation_id,
    operation_class,
    priority,
    force_write,
  });
}

async function setQuota({
  project_id,
  size,
  scratch,
}: {
  project_id: string;
  size: number | string;
  scratch?: boolean;
}): Promise<void> {
  logger.debug("setQuota", { project_id, scratch });
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error("managed project quotas must be finite and positive");
  }
  const volume_kind = managedVolumeKind(scratch);
  acceptProjectVolumeQuotaDesired({
    project_id,
    volume_kind,
    desired_bytes: Math.floor(bytes),
  });
  await reconcileManagedProjectVolumeQuota({
    project_id,
    volume_kind,
    operation_class: "interactive_quota_update",
  });
}

function projectQuotaRepairEnabled(): boolean {
  const raw = `${process.env.COCALC_PROJECT_QUOTA_REPAIR ?? "yes"}`
    .trim()
    .toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

async function repairProjectVolumeQuota({
  row,
}: {
  row: ProjectVolumeQuotaRow;
}): Promise<"repaired" | "ok" | "missing"> {
  if (fs == null) {
    throw Error("file server not initialized");
  }
  const effective = effectiveProjectVolumeQuotaBytes({
    project_id: row.project_id,
    volume_kind: row.volume_kind,
    persistent_bytes: row.desired_bytes,
  });
  const target = effective.effective_bytes;
  const scratch = row.volume_kind === "scratch";
  const vol = await fs.subvolumes.get(volumeName(row.project_id, scratch));
  if (!(await exists(vol.path))) {
    markProjectVolumeQuotaFailed({
      project_id: row.project_id,
      volume_kind: row.volume_kind,
      state: "missing",
      error: "volume missing during bounded quota audit",
    });
    return "missing";
  }
  const current = await vol.quota.get();
  const repaired = current.size !== target;
  if (repaired) {
    logger.warn("repairing project btrfs quota limit", {
      project_id: row.project_id,
      volume_kind: row.volume_kind,
      current_size: current.size,
      desired_size: target,
      warning: current.warning,
    });
  }
  if (!repaired && effective.overrides.length === 0) {
    const volume_identity = await recordManagedProjectVolume({
      project_id: row.project_id,
      scratch,
      path: vol.path,
    });
    markProjectVolumeQuotaApplied({
      project_id: row.project_id,
      volume_kind: row.volume_kind,
      desired_bytes: row.desired_bytes,
      desired_revision: row.desired_revision,
      volume_identity,
    });
  } else {
    await reconcileManagedProjectVolumeQuota({
      project_id: row.project_id,
      volume_kind: row.volume_kind,
      operation_class: "scheduled_quota_audit",
      priority: "scheduled",
    });
  }
  return repaired ? "repaired" : "ok";
}

let quotaRepairRunning = false;
let quotaRepairTimer: ReturnType<typeof setInterval> | undefined;
let quotaOverrideScavengerRunning = false;
let quotaOverrideScavengerTimer: ReturnType<typeof setInterval> | undefined;

async function scavengeExpiredProjectQuotaOverrides(): Promise<void> {
  if (quotaOverrideScavengerRunning) return;
  quotaOverrideScavengerRunning = true;
  try {
    const result = await projectVolumeQuotaManager.recoverUnreleasedOverrides({
      reason: "expired",
      expired_before: Date.now(),
      limit: 256,
    });
    if (result.released > 0 || result.errors > 0 || result.remaining > 0) {
      logger.warn("scavenged expired project quota overrides", result);
    }
    const pruned = pruneReleasedProjectVolumeQuotaOverrides({
      released_before: Date.now() - PROJECT_QUOTA_OVERRIDE_HISTORY_RETENTION_MS,
      limit: 512,
    });
    if (pruned > 0) {
      logger.info("pruned released project quota override history", {
        pruned,
        retention_ms: PROJECT_QUOTA_OVERRIDE_HISTORY_RETENTION_MS,
      });
    }
  } finally {
    quotaOverrideScavengerRunning = false;
  }
}

function startProjectQuotaOverrideScavenger(): void {
  if (quotaOverrideScavengerTimer != null) return;
  quotaOverrideScavengerTimer = setInterval(() => {
    void scavengeExpiredProjectQuotaOverrides();
  }, PROJECT_QUOTA_OVERRIDE_SCAVENGE_MS);
  quotaOverrideScavengerTimer.unref?.();
  logger.info("started project quota override scavenger", {
    sweepMs: PROJECT_QUOTA_OVERRIDE_SCAVENGE_MS,
  });
}

async function repairProjectQuotaLimits(
  context: "periodic" | "manual",
): Promise<void> {
  if (!projectQuotaRepairEnabled() || fs == null) return;
  if (quotaRepairRunning) return;
  quotaRepairRunning = true;
  const counts = {
    checked: 0,
    repaired: 0,
    missing: 0,
    skipped: 0,
    errors: 0,
  };
  try {
    const projects = listProjectVolumeQuotaAuditBatch({
      limit: PROJECT_QUOTA_REPAIR_BATCH_SIZE,
    });
    for (const project of projects) {
      if (projectQuotaGraceActive.has(project.project_id)) {
        counts.skipped += 1;
        continue;
      }
      counts.checked += 1;
      try {
        const result = await withBtrfsMutationContext(
          {
            project_id: project.project_id,
            priority: "scheduled",
            operation_class: "scheduled_quota_audit",
          },
          async () => await repairProjectVolumeQuota({ row: project }),
        );
        if (result === "repaired") {
          counts.repaired += 1;
        } else if (result === "missing") {
          counts.missing += 1;
        }
      } catch (err) {
        if (err instanceof BtrfsMutationDeferredError) {
          counts.skipped += 1;
          invalidateProjectVolumeQuota({
            project_id: project.project_id,
            volume_kind: project.volume_kind,
            reason: err.message,
            retry_at: Date.now() + 60_000,
          });
          logger.info("deferred project quota audit at mutation boundary", {
            context,
            project_id: project.project_id,
            volume_kind: project.volume_kind,
            reason: err.reason,
          });
          continue;
        }
        counts.errors += 1;
        markProjectVolumeQuotaFailed({
          project_id: project.project_id,
          volume_kind: project.volume_kind,
          error: err,
        });
        logger.warn("project quota repair failed", {
          context,
          project_id: project.project_id,
          volume_kind: project.volume_kind,
          desired: project.desired_bytes,
          err: `${err}`,
        });
      }
    }
    if (counts.repaired > 0 || counts.errors > 0) {
      logger.warn("project quota repair sweep finished", {
        context,
        ...counts,
      });
    } else {
      logger.debug("project quota repair sweep finished", {
        context,
        ...counts,
      });
    }
  } finally {
    quotaRepairRunning = false;
  }
}

function startProjectQuotaRepairMonitor(): void {
  if (!projectQuotaRepairEnabled() || quotaRepairTimer != null) return;
  const bootstrapped = bootstrapProjectVolumeQuotaLedger();
  quotaRepairTimer = setInterval(() => {
    void repairProjectQuotaLimits("periodic");
  }, PROJECT_QUOTA_REPAIR_SWEEP_MS);
  quotaRepairTimer.unref?.();
  logger.info("started project quota repair monitor", {
    sweepMs: PROJECT_QUOTA_REPAIR_SWEEP_MS,
    batchSize: PROJECT_QUOTA_REPAIR_BATCH_SIZE,
    bootstrapped,
  });
}

async function cp({
  src,
  dest,
  options,
  exact,
}: {
  // src paths are relative to the src volume
  src: { project_id: string; path: string | string[] };
  // dest path is relative to the dest volume
  dest: { project_id: string; path: string };
  options?: CopyOptions;
  exact?: boolean;
}): Promise<void> {
  if (fs == null) {
    throw Error("file server not initialized");
  }
  const srcVolume = await getVolume(src.project_id);
  const destVolume = await getOrEnsureVolume(dest.project_id);
  // Paths may be project-relative or absolute (/..., /root/..., /tmp/...).
  // Resolve using the same home/rootfs/temp-volume policy as the fs server API.
  const srcFs = createProjectSandboxFilesystem({
    project_id: src.project_id,
    home: srcVolume.path,
    rootfs: getRootfsMountpoint(src.project_id),
    scratch: getScratchMountpoint(src.project_id),
  });
  const destFs = createProjectSandboxFilesystem({
    project_id: dest.project_id,
    home: destVolume.path,
    rootfs: getRootfsMountpoint(dest.project_id),
    scratch: getScratchMountpoint(dest.project_id),
  });
  let srcPaths = await srcFs.safeAbsPaths(src.path);
  let destPath = await destFs.safeAbsPath(dest.path);

  if (exact) {
    if (typeof src.path !== "string") {
      throw new Error("exact copy requires one source path");
    }
    if (destPath === destVolume.path) {
      throw new Error("exact copy destination cannot be project root");
    }
    const destStat = await lstatIfExists(destPath);
    const force = options?.force ?? true;
    if (destStat && !force) {
      if (options?.errorOnExist) {
        const err = new Error(
          "SystemError [ERR_FS_CP_EEXIST]: Target already exists",
        );
        // @ts-ignore
        err.code = "ERR_FS_CP_EEXIST";
        throw err;
      }
      return;
    }
    await replacePathFromStaging({
      source: srcPaths[0],
      destination: destPath,
      destinationExists: destStat != null,
      copy: async (source, destination) => {
        await cpExec(source, destination, {
          ...options,
          recursive: options?.recursive ?? true,
          reflink: true,
        });
      },
    });
    void touchProjectLastEdited(dest.project_id, "cp-exact");
    return;
  }

  const toRelative = (path: string) => {
    if (!path.startsWith(fs!.subvolumes.fs.path)) {
      throw Error("bug");
    }
    return path.slice(fs!.subvolumes.fs.path.length + 1);
  };
  const inSharedSubvolumeMount =
    destPath.startsWith(fs.subvolumes.fs.path + "/") &&
    srcPaths.every((p) => p.startsWith(fs!.subvolumes.fs.path + "/"));

  if (inSharedSubvolumeMount) {
    srcPaths = srcPaths.map(toRelative);
    destPath = toRelative(destPath);
    // Fast path: btrfs-aware copy inside the shared file-server mount.
    await fs.subvolumes.fs.cp(
      typeof src.path == "string" ? srcPaths[0] : srcPaths, // preserve string vs array
      destPath,
      { ...options, reflink: true },
    );
  } else {
    // Fallback path for absolute rootfs/temp-volume locations that are outside
    // the subvolume mount root.
    await cpExec(
      typeof src.path == "string" ? srcPaths[0] : srcPaths,
      destPath,
      {
        ...options,
        recursive: options?.recursive ?? true,
        reflink: true,
      },
    );
  }
  void touchProjectLastEdited(dest.project_id, "cp");
}

function pathCopyArchiveLimitError(message: string): Error {
  return new Error(`${PATH_COPY_ARCHIVE_LIMIT_PREFIX} ${message}`);
}

function normalizePathCopyArchivePath(raw: string, label: string): string {
  const normalized = normalizeArchivePath(raw);
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`${label} must be a non-empty project-relative path`);
  }
  if (normalized === ".snapshots" || normalized.startsWith(".snapshots/")) {
    throw new Error(`${label} must not include .snapshots`);
  }
  return normalized;
}

function assertPathCopyArchiveRoots(roots: PathCopyArchiveRoot[]): void {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new Error("at least one archive root is required");
  }
  const seen = new Set<string>();
  for (const root of roots) {
    root.archive_path = normalizePathCopyArchivePath(
      root.archive_path,
      "archive root",
    );
    root.source_path = normalizePathCopyArchivePath(
      root.source_path,
      "source path",
    );
    if (root.archive_path.startsWith("-")) {
      throw new Error("archive root must not start with '-'");
    }
    if (seen.has(root.archive_path)) {
      throw new Error(`duplicate archive root: ${root.archive_path}`);
    }
    seen.add(root.archive_path);
  }
}

async function lstatIfExists(pathToStat: string) {
  try {
    return await lstat(pathToStat);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

async function collectPathCopyArchiveStats({
  rootPath,
  maxFiles,
  maxUncompressedBytes,
}: {
  rootPath: string;
  maxFiles: number;
  maxUncompressedBytes: number;
}): Promise<{ file_count: number; uncompressed_bytes: number }> {
  let file_count = 0;
  let uncompressed_bytes = 0;
  const visit = async (pathToVisit: string): Promise<void> => {
    const info = await lstat(pathToVisit);
    file_count += 1;
    if (file_count > maxFiles) {
      throw pathCopyArchiveLimitError(
        `copy contains more than ${maxFiles} filesystem entries`,
      );
    }
    if (info.isFile() || info.isSymbolicLink()) {
      uncompressed_bytes += info.size;
      if (uncompressed_bytes > maxUncompressedBytes) {
        throw pathCopyArchiveLimitError(
          `copy is larger than ${maxUncompressedBytes} uncompressed bytes`,
        );
      }
    }
    if (!info.isDirectory()) {
      return;
    }
    const entries = await readdir(pathToVisit, { withFileTypes: true });
    for (const entry of entries) {
      await visit(path.join(pathToVisit, entry.name));
    }
  };
  await visit(rootPath);
  return { file_count, uncompressed_bytes };
}

async function createPathCopyArchive({
  project_id,
  roots,
  options,
  max_archive_bytes,
  max_uncompressed_bytes,
  max_files,
}: {
  project_id: string;
  roots: PathCopyArchiveRoot[];
  options?: Pick<CopyOptions, "dereference">;
  max_archive_bytes: number;
  max_uncompressed_bytes: number;
  max_files: number;
}): Promise<PathCopyArchive> {
  if (options?.dereference) {
    throw pathCopyArchiveLimitError(
      "dereference copies use the backup path instead",
    );
  }
  assertPathCopyArchiveRoots(roots);
  const maxArchiveBytes = Math.max(1, Math.floor(max_archive_bytes));
  const maxUncompressedBytes = Math.max(1, Math.floor(max_uncompressed_bytes));
  const maxFiles = Math.max(1, Math.floor(max_files));
  const volume = await getVolume(project_id);
  const snapshot = `path-copy-${randomUUID()}`;
  const tmpRoot = await mkdtemp(join(tmpdir(), "cocalc-path-copy-"));
  const stagingRoot = join(tmpRoot, "archive-root");
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });

  let file_count = 0;
  let uncompressed_bytes = 0;
  let snapshotCreated = false;
  try {
    await volume.snapshots.create(snapshot, { quotaMode: "skip" });
    snapshotCreated = true;
    const snapshotRoot = join(volume.path, volume.snapshots.path(snapshot));
    for (const root of roots) {
      const sourceAbs = join(snapshotRoot, root.source_path);
      if (!(await exists(sourceAbs))) {
        throw new Error(`copy source path does not exist: ${root.source_path}`);
      }
      const stats = await collectPathCopyArchiveStats({
        rootPath: sourceAbs,
        maxFiles: maxFiles - file_count,
        maxUncompressedBytes: maxUncompressedBytes - uncompressed_bytes,
      });
      file_count += stats.file_count;
      uncompressed_bytes += stats.uncompressed_bytes;
      const stagedAbs = join(stagingRoot, root.archive_path);
      await mkdir(dirname(stagedAbs), { recursive: true });
      await cpExec(sourceAbs, stagedAbs, {
        recursive: true,
        preserveTimestamps: true,
        reflink: true,
      });
    }

    const result = await execSandbox({
      cmd: "/usr/bin/tar",
      safety: [
        "-czf",
        "-",
        "-C",
        stagingRoot,
        "--",
        ...roots.map((root) => root.archive_path),
      ],
      maxSize: maxArchiveBytes + 1,
      timeout: PATH_COPY_ARCHIVE_TIMEOUT_MS,
    });
    if (result.truncated) {
      throw pathCopyArchiveLimitError(
        `compressed archive exceeded ${maxArchiveBytes} bytes`,
      );
    }
    if (result.code) {
      throw new Error(result.stderr.toString() || "tar archive failed");
    }
    const archive = Buffer.from(result.stdout);
    if (archive.length > maxArchiveBytes) {
      throw pathCopyArchiveLimitError(
        `compressed archive exceeded ${maxArchiveBytes} bytes`,
      );
    }
    return {
      format: PATH_COPY_ARCHIVE_FORMAT,
      archive,
      sha256: createHash("sha256").update(archive).digest("hex"),
      bytes: archive.length,
      uncompressed_bytes,
      file_count,
      roots: roots.map((root) => ({ ...root })),
    };
  } finally {
    if (snapshotCreated) {
      await volume.snapshots.delete(snapshot).catch((err) =>
        logger.warn("path copy snapshot cleanup failed", {
          project_id,
          snapshot,
          err: `${err}`,
        }),
      );
    }
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function validatePathCopyArchiveListing({
  archivePath,
  roots,
}: {
  archivePath: string;
  roots: PathCopyArchiveRoot[];
}): Promise<void> {
  const allowedRoots = new Set(roots.map((root) => root.archive_path));
  const result = await execSandbox({
    cmd: "/usr/bin/tar",
    safety: ["--quoting-style=c", "-tzf", archivePath],
    maxSize: Math.max(1_000_000, allowedRoots.size * 1000),
    timeout: PATH_COPY_ARCHIVE_TIMEOUT_MS,
  });
  if (result.code || result.truncated) {
    throw new Error(result.stderr.toString() || "unable to list archive");
  }
  const entries = decodePathCopyArchiveListing(result.stdout);
  for (const entry of entries) {
    if (!archivePathIsAllowed({ entry, allowedRoots })) {
      throw new Error(`archive contains unsafe path: ${entry}`);
    }
  }
}

async function applyPathCopyArchive({
  archive,
  dests,
  options,
}: {
  archive: PathCopyArchive;
  dests: PathCopyArchiveDestination[];
  options?: CopyOptions;
}): Promise<{ applied: number }> {
  if (archive?.format !== PATH_COPY_ARCHIVE_FORMAT) {
    throw new Error("unsupported path copy archive format");
  }
  assertPathCopyArchiveRoots(archive.roots);
  if (!Array.isArray(dests) || !dests.length) {
    throw new Error("at least one archive destination is required");
  }
  const archiveBuffer = Buffer.from(archive.archive);
  const actualSha256 = createHash("sha256").update(archiveBuffer).digest("hex");
  if (actualSha256 !== archive.sha256) {
    throw new Error("path copy archive sha256 mismatch");
  }
  if (archive.bytes !== archiveBuffer.length) {
    throw new Error("path copy archive byte count mismatch");
  }

  const tmpRoot = await mkdtemp(join(tmpdir(), "cocalc-path-copy-apply-"));
  const archivePath = join(tmpRoot, "copy.tar.gz");
  const stagingRoot = join(tmpRoot, "staging");
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  try {
    await writeFile(archivePath, archiveBuffer);
    await validatePathCopyArchiveListing({ archivePath, roots: archive.roots });
    const extract = await execSandbox({
      cmd: "/usr/bin/tar",
      safety: ["--no-same-owner", "-xzf", archivePath, "-C", stagingRoot],
      timeout: PATH_COPY_ARCHIVE_TIMEOUT_MS,
    });
    if (extract.code) {
      throw new Error(extract.stderr.toString() || "archive extract failed");
    }

    let applied = 0;
    const rootsByPath = new Map(
      archive.roots.map((root) => [root.archive_path, root]),
    );
    for (const dest of dests) {
      await ensureVolume(dest.project_id);
      const volume = await getVolume(dest.project_id);
      const projectRoot = volume.path;
      const destFs = createProjectSandboxFilesystem({
        project_id: dest.project_id,
        home: projectRoot,
        rootfs: getRootfsMountpoint(dest.project_id),
        scratch: getScratchMountpoint(dest.project_id),
      });
      for (const rootDest of dest.roots) {
        const archiveRootPath = normalizePathCopyArchivePath(
          rootDest.archive_path,
          "archive destination root",
        );
        const root = rootsByPath.get(archiveRootPath);
        if (!root) {
          throw new Error(`archive root not found: ${archiveRootPath}`);
        }
        const sourceAbs = join(stagingRoot, archiveRootPath);
        if (!(await exists(sourceAbs))) {
          throw new Error(`archive did not extract ${archiveRootPath}`);
        }
        const destPath = normalizePathCopyArchivePath(
          rootDest.dest_path,
          "destination path",
        );
        const destAbs = await destFs.safeAbsPath(destPath);
        if (destAbs === projectRoot) {
          throw new Error("dest_path cannot be project root");
        }

        const destStat = await lstatIfExists(destAbs);
        const installed = await installPathFromStaging({
          source: sourceAbs,
          destination: destAbs,
          destinationExists: destStat != null,
          exact: rootDest.exact,
          options,
          copy: async (source, destination) => {
            await cpExec(source, destination, {
              ...options,
              recursive: options?.recursive ?? true,
              reflink: true,
            });
          },
        });
        applied += 1;
        if (installed) {
          void touchProjectLastEdited(dest.project_id, "path-copy-archive");
        }
      }
    }
    return { applied };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

// Snapshots
async function createSnapshot({
  project_id,
  name,
  limit,
  quotaMode = "async",
}: {
  project_id: string;
  name?: string;
  limit?: number;
  quotaMode?: "sync" | "async" | "skip";
}) {
  const vol = await getVolume(project_id);
  await vol.snapshots.create(name, { limit, quotaMode });
}

async function deleteSnapshot({
  project_id,
  name,
}: {
  project_id: string;
  name: string;
}) {
  const vol = await getVolume(project_id);
  await vol.snapshots.delete(name);
}

function normalizeSnapshotPrunePath(input: string): string {
  const normalized = normalizeArchivePath(input);
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("..") ||
    normalized.includes("/..")
  ) {
    throw new Error("invalid snapshot prune path");
  }
  if (normalized === ".snapshots" || normalized.startsWith(".snapshots/")) {
    throw new Error("cannot prune snapshots from snapshots");
  }
  return normalized;
}

async function pruneSnapshotPath({
  project_id,
  path,
  snapshots,
}: {
  project_id: string;
  path: string;
  snapshots?: string[];
}): Promise<{ path: string; snapshots: string[] }> {
  const vol = await getVolume(project_id);
  return await vol.snapshots.prunePath({
    path: normalizeSnapshotPrunePath(path),
    snapshots,
  });
}

async function updateSnapshots({
  project_id,
  counts,
  limit,
  quotaMode = "async",
}: {
  project_id: string;
  counts?: Partial<SnapshotCounts>;
  limit?: number;
  quotaMode?: "sync" | "async" | "skip";
}): Promise<void> {
  const vol = await getVolume(project_id);
  await vol.snapshots.update(counts, { limit, quotaMode });
}

export async function runScheduledSnapshotMaintenance({
  project_id,
  counts,
  limit = 250,
}: {
  project_id: string;
  counts: Partial<SnapshotCounts>;
  limit?: number;
}): Promise<void> {
  await updateSnapshots({
    project_id,
    counts,
    limit,
    quotaMode: "async",
  });
}

async function allSnapshotUsage({
  project_id,
}: {
  project_id: string;
}): Promise<SnapshotUsage[]> {
  const vol = await getVolume(project_id);
  return await vol.snapshots.allUsage();
}

async function restoreSnapshot({
  project_id,
  snapshot,
  mode = "both",
  safety_snapshot_name,
  lro: _lro,
}: {
  project_id: string;
  snapshot: string;
  mode?: SnapshotRestoreMode;
  safety_snapshot_name?: string;
  lro?: LroRef;
}): Promise<void> {
  snapshot = assertValidSnapshotName(snapshot);
  if (safety_snapshot_name != null) {
    safety_snapshot_name = assertValidSnapshotName(safety_snapshot_name);
  }
  if (!["both", "home", "rootfs"].includes(mode)) {
    throw new Error(`invalid snapshot restore mode: ${mode}`);
  }
  const home = projectMountpoint(project_id);
  const rootfsPath = join(home, PROJECT_IMAGE_PATH);
  const staged = await createSnapshotRestoreClone({ project_id, snapshot });
  const stagedRootfsPath = join(staged.path, PROJECT_IMAGE_PATH);
  let cleanupStagedClone = true;
  let oldHomePath: string | undefined;
  let preservedRootfsPath: string | undefined;
  let restoredHomeRootfs = false;
  try {
    if (mode === "rootfs") {
      preservedRootfsPath = await createSnapshotRestoreTempPath(
        `${volName(project_id)}.rootfs-`,
      );
      await replaceTreeByMove({ src: rootfsPath, dest: preservedRootfsPath });
      try {
        await replaceTreeByMove({ src: stagedRootfsPath, dest: rootfsPath });
      } catch (err) {
        await replaceTreeByMove({
          src: preservedRootfsPath,
          dest: rootfsPath,
        }).catch(() => {});
        throw err;
      }
      invalidateProjectFsServer(project_id);
      void touchProjectLastEdited(project_id, "restore-snapshot");
      return;
    }

    if (mode === "home") {
      preservedRootfsPath = await createSnapshotRestoreTempPath(
        `${volName(project_id)}.rootfs-`,
      );
      await replaceTreeByMove({ src: rootfsPath, dest: preservedRootfsPath });
    }

    ({ oldHomePath } = await swapProjectHome({
      project_id,
      replacementPath: staged.path,
    }));
    cleanupStagedClone = false;

    try {
      if (mode === "home") {
        await replaceTreeByMove({
          src: preservedRootfsPath,
          dest: join(projectMountpoint(project_id), PROJECT_IMAGE_PATH),
        });
        preservedRootfsPath = undefined;
        restoredHomeRootfs = true;
      }
      if (oldHomePath && safety_snapshot_name) {
        await createSafetySnapshotFromPath({
          project_id,
          snapshotPath: join(oldHomePath, ".snapshots", safety_snapshot_name),
          snapshot: safety_snapshot_name,
        });
      }
    } catch (err) {
      if (mode === "home" && oldHomePath) {
        const oldRootfsPath = join(oldHomePath, PROJECT_IMAGE_PATH);
        if (preservedRootfsPath && (await exists(preservedRootfsPath))) {
          await replaceTreeByMove({
            src: preservedRootfsPath,
            dest: oldRootfsPath,
          }).catch(() => {});
          preservedRootfsPath = undefined;
        } else if (restoredHomeRootfs) {
          await replaceTreeByMove({
            src: join(projectMountpoint(project_id), PROJECT_IMAGE_PATH),
            dest: oldRootfsPath,
          }).catch(() => {});
        }
      }
      if (oldHomePath) {
        await rollbackProjectHomeSwap({
          project_id,
          oldHomePath,
        }).catch(() => {});
      }
      throw err;
    }
  } finally {
    if (cleanupStagedClone) {
      await deleteSubvolumeTree(staged.path).catch(() => {});
    }
    await removeDirectoryTree(preservedRootfsPath).catch(() => {});
  }

  if (oldHomePath) {
    await deleteSubvolumeTree(oldHomePath);
  }
  invalidateProjectFsServer(project_id);
  void touchProjectLastEdited(project_id, "restore-snapshot");
}

function defaultPublishSnapshotName(): string {
  return `rootfs-publish-${new Date().toISOString()}-${randomUUID()}`;
}

function normalizePublishedArch(value: unknown): RootfsImageArch {
  const arch = `${value ?? ""}`.trim().toLowerCase();
  if (arch === "amd64" || arch === "arm64") {
    return arch;
  }
  return "any";
}

function publishRootfsProgress({
  lro,
  phase,
  progress,
  message,
  detail,
}: {
  lro?: LroRef;
  phase: string;
  progress: number;
  message: string;
  detail?: any;
}) {
  if (!lro) return;
  void publishLroEvent({
    scope_type: lro.scope_type,
    scope_id: lro.scope_id,
    op_id: lro.op_id,
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

function createPhaseTimingRecorder() {
  const phase_timings_ms: RootfsPhaseTimings = {};
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

async function readRootfsContentManifestFromMergedRootfs(
  root: string,
): Promise<{
  content?: unknown;
  warnings?: RootfsContentValidationWarning[];
}> {
  const manifestPath = join(root, ".cocalc", "rootfs-content.json");
  let manifestStat;
  try {
    manifestStat = await stat(manifestPath);
  } catch (err) {
    const code = (err as any)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return {};
    }
    return {
      warnings: [
        {
          code: "manifest-read-failed",
          message: `Unable to inspect RootFS content manifest: ${err}`,
          path: "/.cocalc/rootfs-content.json",
        },
      ],
    };
  }
  if (!manifestStat.isFile()) {
    return {
      warnings: [
        {
          code: "manifest-not-file",
          message: "RootFS content manifest path is not a regular file",
          path: "/.cocalc/rootfs-content.json",
        },
      ],
    };
  }
  if (manifestStat.size > ROOTFS_CONTENT_MAX_JSON_BYTES) {
    return {
      warnings: [
        {
          code: "content-too-large",
          message: `Content manifest must be at most ${ROOTFS_CONTENT_MAX_JSON_BYTES} bytes`,
          path: "/.cocalc/rootfs-content.json",
        },
      ],
    };
  }
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (err) {
    return {
      warnings: [
        {
          code: "manifest-read-failed",
          message: `Unable to read RootFS content manifest: ${err}`,
          path: "/.cocalc/rootfs-content.json",
        },
      ],
    };
  }
  try {
    return { content: JSON.parse(raw) };
  } catch (err) {
    return {
      warnings: [
        {
          code: "invalid-json",
          message: `RootFS content manifest is invalid JSON: ${err}`,
          path: "/.cocalc/rootfs-content.json",
        },
      ],
    };
  }
}

async function publishRootfsImage({
  project_id,
  snapshot,
  upload,
  lro,
}: {
  project_id: string;
  snapshot?: string;
  upload?: RootfsArtifactTransferTarget;
  lro?: LroRef;
}): Promise<PublishProjectRootfsArtifact> {
  const timings = createPhaseTimingRecorder();
  const snapshotName = snapshot?.trim() || defaultPublishSnapshotName();
  const createdSnapshot = !snapshot?.trim();
  if (createdSnapshot) {
    publishRootfsProgress({
      lro,
      phase: "snapshot",
      progress: 15,
      message: "creating publish snapshot",
      detail: { snapshot: snapshotName },
    });
    await timings.measure("create_snapshot", async () => {
      await createSnapshot({
        project_id,
        name: snapshotName,
        quotaMode: "skip",
      });
    });
  }

  publishRootfsProgress({
    lro,
    phase: "snapshot",
    progress: 25,
    message: createdSnapshot ? "snapshot ready" : "using existing snapshot",
    detail: { snapshot: snapshotName, created_snapshot: createdSnapshot },
  });

  const staged = await timings.measure("clone_snapshot", async () => {
    return await createSnapshotRestoreClone({
      project_id,
      snapshot: snapshotName,
      applyQuota: false,
    });
  });
  const rootfsPath = join(staged.path, PROJECT_IMAGE_PATH);
  let mergedPath: string | undefined;
  let workdirPath: string | undefined;
  let stagedRootfsPath: string | undefined;
  let publishSucceeded = false;
  try {
    const currentImagePath = join(rootfsPath, "current-image.txt");
    const sourceImage = `${await readFile(currentImagePath, "utf8")}`.trim();
    if (!sourceImage) {
      throw new Error(
        "project has no current RootFS image recorded; start the project at least once before publishing",
      );
    }

    const lowerdir = await timings.measure("extract_base_image", async () => {
      return await extractBaseImage(sourceImage);
    });
    const overlayRoot = join(rootfsPath, imagePathComponent(sourceImage));
    const upperdir = join(overlayRoot, "upperdir");
    await mkdir(upperdir, { recursive: true });

    workdirPath = join(overlayRoot, `publish-workdir-${randomUUID()}`);
    await mkdir(workdirPath, { recursive: true });
    mergedPath = await createOverlayMountTempPath();
    const inspectData = await inspect(sourceImage);
    const merged = mergedPath!;
    await mountOverlayForPublish({
      lowerdir,
      upperdir,
      workdir: workdirPath!,
      merged,
    });
    const rootfsContent = await timings.measure(
      "read_rootfs_content_manifest",
      async () => await readRootfsContentManifestFromMergedRootfs(merged),
    );

    publishRootfsProgress({
      lro,
      phase: "publish",
      progress: upload?.backend === "rustic" ? 45 : 40,
      message:
        upload?.backend === "rustic"
          ? "preparing merged RootFS release"
          : "materializing merged RootFS",
      detail: { source_image: sourceImage },
    });

    let uploadResult:
      | Extract<RootfsUploadedArtifactResult, { backend: "rustic" }>
      | undefined;
    let image: string;
    let digest: string | undefined;
    let contentKey: string;
    let sizeBytes: number | undefined;
    let finalInspectPath: string;

    if (upload?.backend === "rustic") {
      logger.info("rootfs publish direct rustic begin", {
        project_id,
        snapshot: snapshotName,
        source_image: sourceImage,
        merged,
      });
      sizeBytes = await directorySizeBytes(merged);
      logger.info("rootfs publish direct rustic sized", {
        project_id,
        source_image: sourceImage,
        merged,
        sizeBytes,
      });

      publishRootfsProgress({
        lro,
        phase: "upload",
        progress: 70,
        message: "saving RootFS release to rustic storage",
        detail: { source_image: sourceImage },
      });
      const uploadTimings = createPhaseTimingRecorder();
      logger.info("rootfs publish direct rustic backup starting", {
        project_id,
        source_image: sourceImage,
        merged,
        backup_host: snapshotName,
      });
      uploadResult = await timings.measure("upload_rustic", async () => {
        return await backupRootfsTreeToRustic({
          sourcePath: merged,
          backupHost: snapshotName,
          upload,
          lro,
          timings: uploadTimings,
        });
      });
      contentKey = uploadResult.snapshot_id;
      image = managedRootfsImageName(contentKey);
      finalInspectPath = inspectFilePath(image);
      logger.info("rootfs publish direct rustic backup finished", {
        project_id,
        source_image: sourceImage,
        merged,
        image,
        content_key: contentKey,
        snapshot_id: uploadResult.snapshot_id,
      });
      publishRootfsProgress({
        lro,
        phase: "publish",
        progress: 92,
        message: "finalizing published RootFS metadata",
        detail: { image, content_key: contentKey, source_image: sourceImage },
      });
    } else {
      if (isManagedRootfsImageName(sourceImage)) {
        const managedParentPath = imageCachePath(sourceImage);
        if (
          (await exists(managedParentPath)) &&
          (await isBtrfsSubvolume(managedParentPath))
        ) {
          await mkdir(IMAGE_CACHE, { recursive: true });
          stagedRootfsPath = join(
            IMAGE_CACHE,
            `.rootfs-publish-tree-${randomUUID()}`,
          );
          await btrfsSnapshotWritable({
            source: managedParentPath,
            dest: stagedRootfsPath,
          });
        }
      }
      stagedRootfsPath =
        stagedRootfsPath ??
        (await createImageCacheTempSubvolume(".rootfs-publish-tree-"));

      await timings.measure("materialize_tree", async () => {
        await rsyncTree({
          src: merged,
          dest: stagedRootfsPath!,
        });
      });

      publishRootfsProgress({
        lro,
        phase: "publish",
        progress: 75,
        message: "hashing published RootFS",
      });
      digest = await timings.measure("hash_tree", async () => {
        return await tarSha256(stagedRootfsPath!);
      });
      contentKey = digest;
      image = managedRootfsImageName(digest);
      const finalPath = imageCachePath(image);
      finalInspectPath = inspectFilePath(image);

      publishRootfsProgress({
        lro,
        phase: "publish",
        progress: 90,
        message: "registering host cache entry",
        detail: { image, content_key: digest },
      });
      if (!(await exists(finalPath))) {
        await timings.measure("register_cache_entry", async () => {
          const stagedRootfs = stagedRootfsPath!;
          await mkdir(dirname(finalPath), { recursive: true });
          await btrfsSnapshotReadonly({
            source: stagedRootfs,
            dest: finalPath,
          });
          await deleteSubvolumeTree(stagedRootfs);
          stagedRootfsPath = undefined;
        });
      }
      sizeBytes = await directorySizeBytes(finalPath);
    }

    let runtimeContractLabels: Record<string, string> | undefined;
    try {
      runtimeContractLabels = projectRuntimeRootfsContractLabelsForCurrentHost({
        usernsMapFingerprint:
          await readCurrentProjectRuntimeUsernsMapFingerprint(),
      });
    } catch (err) {
      logger.warn("unable to stamp RootFS runtime contract labels", {
        project_id,
        source_image: sourceImage,
        err: `${err}`,
      });
    }

    const publishedInspectData = {
      ...inspectData,
      RepoTags: [image],
      Config: {
        ...(inspectData?.Config ?? {}),
        Labels: {
          ...(inspectData?.Config?.Labels ?? {}),
          "com.cocalc.rootfs.managed": "true",
          "com.cocalc.rootfs.content_key": contentKey,
          "com.cocalc.rootfs.source_image": sourceImage,
          ...(runtimeContractLabels ?? {}),
        },
      },
    };
    if (digest) {
      publishedInspectData.Digest = digest;
      publishedInspectData.RepoDigests = [digest];
    }

    if (!(await exists(finalInspectPath))) {
      await mkdir(dirname(finalInspectPath), { recursive: true });
      await writeFile(finalInspectPath, JSON.stringify(publishedInspectData));
    }

    publishSucceeded = true;
    return {
      image,
      content_key: contentKey,
      digest,
      arch: normalizePublishedArch(publishedInspectData?.Architecture),
      size_bytes: sizeBytes,
      snapshot: snapshotName,
      created_snapshot: createdSnapshot,
      source_image: sourceImage,
      artifact_kind: "full",
      inspect_data: publishedInspectData,
      rootfs_content: rootfsContent.content,
      rootfs_content_warnings: rootfsContent.warnings,
      upload_result: uploadResult,
      phase_timings_ms: timings.phase_timings_ms,
    };
  } finally {
    if (mergedPath) {
      await unmountOverlayForPublish(mergedPath);
    }
    await removeDirectoryTree(workdirPath).catch(() => {});
    await removeDirectoryTree(mergedPath).catch(() => {});
    await deleteSubvolumeTree(stagedRootfsPath).catch(() => {});
    await deleteSubvolumeTree(staged.path).catch(() => {});
    if (createdSnapshot && publishSucceeded) {
      await deleteSnapshot({
        project_id,
        name: snapshotName,
      }).catch((err) => {
        logger.warn("unable to delete temporary rootfs publish snapshot", {
          project_id,
          snapshot: snapshotName,
          err: `${err}`,
        });
      });
    }
  }
}

async function uploadRootfsReleaseArtifact({
  image,
  upload,
  lro,
}: {
  project_id: string;
  image: string;
  upload: RootfsArtifactTransferTarget;
  lro?: LroRef;
}): Promise<RootfsUploadedArtifactResult> {
  const timings = createPhaseTimingRecorder();
  const finalPath = imageCachePath(image);
  if (!(await exists(finalPath))) {
    throw new Error(
      `cached RootFS image '${image}' does not exist on this host`,
    );
  }

  return await backupRootfsTreeToRustic({
    sourcePath: finalPath,
    backupHost: image,
    upload,
    lro,
    timings,
  });
}

function createLroRusticReporter(
  lro: LroRef | undefined,
  phase: string,
): ((update: RusticProgressUpdate) => void) | undefined {
  if (!lro) return undefined;
  const start = Date.now();
  return (update: RusticProgressUpdate) => {
    const ts = Date.now();
    const detail = { ...(update.detail ?? {}) };
    if (detail.elapsed == null) {
      detail.elapsed = ts - start;
    }
    void publishLroEvent({
      scope_type: lro.scope_type,
      scope_id: lro.scope_id,
      op_id: lro.op_id,
      event: {
        type: "progress",
        ts,
        phase,
        message: update.message,
        progress: update.progress,
        detail: Object.keys(detail).length ? detail : undefined,
      },
    }).catch(() => {});
  };
}

async function removeBackupIndexLocal(
  project_id: string,
  backup_id: string,
): Promise<void> {
  await rm(join(backupIndexDir(project_id), backupIndexFileName(backup_id)), {
    force: true,
  });
}

export async function deleteBackupIndexCache(project_id: string) {
  await rm(backupIndexDir(project_id), { recursive: true, force: true });
}

function normalizePreviewPath(input: string): string {
  const normalized = normalizeArchivePath(input);
  if (!normalized || normalized === "." || normalized.startsWith("..")) {
    throw new Error("invalid path");
  }
  return normalized;
}

function isLikelyBinary(data: Buffer): boolean {
  if (!data.length) return false;
  let suspicious = 0;
  for (const byte of data) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 14 && byte < 32) || byte === 127) {
      suspicious += 1;
    }
  }
  return suspicious / data.length > 0.3;
}

async function readTextPreview({
  filePath,
  size,
  mtime,
  maxBytes,
}: {
  filePath: string;
  size?: number;
  mtime?: number;
  maxBytes: number;
}): Promise<{
  content: string;
  truncated: boolean;
  size: number;
  mtime: number;
}> {
  const stats = size == null || mtime == null ? await stat(filePath) : null;
  if (stats && !stats.isFile()) {
    throw new Error("path is not a file");
  }
  const totalSize = size ?? stats?.size ?? 0;
  const mtimeMs = Math.floor(mtime ?? stats?.mtimeMs ?? 0);
  const readSize = Math.min(totalSize, maxBytes);
  const fd = await nodeOpen(
    filePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const buffer = Buffer.alloc(readSize);
    const { bytesRead } = await fd.read(buffer, 0, readSize, 0);
    const data = buffer.subarray(0, bytesRead);
    if (isLikelyBinary(data)) {
      throw new Error("binary file preview not supported");
    }
    return {
      content: data.toString("utf8"),
      truncated: totalSize > maxBytes,
      size: totalSize,
      mtime: mtimeMs,
    };
  } finally {
    await fd.close();
  }
}

// Rustic backups
function requireProjectSiteMigrationUuid(value: string, name: string): string {
  const normalized = `${value ?? ""}`.trim();
  if (!isValidUUID(normalized)) {
    throw new Error(`${name} must be a valid uuid`);
  }
  return normalized;
}

function projectSiteMigrationRepoProfileDir(migration_id: string): string {
  if (!secrets) {
    throw new Error("SECRETS path is not configured");
  }
  return join(secrets, "rustic", "project-site-migrations", migration_id);
}

async function writeProjectSiteMigrationRepoProfile({
  migration_id,
  rustic_repo_toml,
}: {
  migration_id: string;
  rustic_repo_toml: string;
}): Promise<{ profilePath: string; profileDir: string }> {
  const profileDir = projectSiteMigrationRepoProfileDir(migration_id);
  const profilePath = join(profileDir, "repo.toml");
  const toml = `${rustic_repo_toml ?? ""}`;
  if (!toml.trim()) {
    throw new Error("rustic_repo_toml is required");
  }
  await mkdir(profileDir, { recursive: true });
  await writeFile(profilePath, toml, "utf8");
  await chmod(profilePath, 0o600);
  return { profilePath, profileDir };
}

function projectSiteMigrationStagingRoot({
  mount,
  project_id,
  migration_id,
}: {
  mount: string;
  project_id: string;
  migration_id: string;
}): string {
  return join(
    mount,
    PROJECT_SITE_MIGRATION_STAGING_DIR,
    project_id,
    migration_id,
  );
}

function projectRusticSnapshotHost(project_id: string): string {
  return `project-${project_id}`;
}

async function deleteProjectSiteMigrationSnapshot(path: string): Promise<void> {
  await btrfs({
    args: ["subvolume", "delete", path],
    err_on_exit: false,
    verbose: false,
  });
}

async function backupProjectToExternalRepository({
  project_id,
  destination_project_id,
  migration_id,
  rustic_repo_toml,
  tags,
  lro,
  managed_egress_override,
}: {
  project_id: string;
  destination_project_id: string;
  migration_id: string;
  rustic_repo_toml: string;
  backup_index_store?: ProjectBackupIndexStoreConfig | null;
  tags?: string[];
  lro?: LroRef;
  managed_egress_override?: ManagedBackupEgressOverride;
}): Promise<ExternalProjectBackupResult> {
  project_id = requireProjectSiteMigrationUuid(project_id, "project_id");
  destination_project_id = requireProjectSiteMigrationUuid(
    destination_project_id,
    "destination_project_id",
  );
  migration_id = requireProjectSiteMigrationUuid(migration_id, "migration_id");

  const progress = createLroRusticReporter(lro, "backup-to-destination-repo");
  const managedBackupPolicy = await checkManagedBackupAllowedBestEffort({
    project_id,
    managed_egress_override,
  });
  if (!managedBackupPolicy.allowed) {
    throw new Error(managedBackupPolicy.message);
  }

  const { profilePath, profileDir } =
    await writeProjectSiteMigrationRepoProfile({
      migration_id,
      rustic_repo_toml,
    });
  let backupResult: ExternalProjectBackupResult | undefined;
  try {
    const vol = await getVolume(project_id);
    backupResult = await withBackupParallelLimit({
      project_id,
      op: "backupProjectToExternalRepository",
      run: async () => {
        const stagingRoot = projectSiteMigrationStagingRoot({
          mount: vol.filesystem.opts.mount,
          project_id,
          migration_id,
        });
        const snapshotPath = join(stagingRoot, "home");
        await withBtrfsMutationLock({
          mount: vol.filesystem.opts.mount,
          operation: "project-site-migration-snapshot-create",
          run: async () => {
            await deleteProjectSiteMigrationSnapshot(snapshotPath).catch(
              () => {},
            );
            await rm(stagingRoot, { recursive: true, force: true }).catch(
              () => {},
            );
            await sudo({ command: "mkdir", args: ["-p", stagingRoot] });
            await btrfs({
              args: ["subvolume", "snapshot", vol.path, snapshotPath],
            });
          },
        });
        try {
          await sudo({
            command: "rm",
            args: [
              "-rf",
              join(snapshotPath, PROJECT_SITE_MIGRATION_ROOTFS_STATE_PATH),
            ],
          });
          const backup = await projectRusticBackup({
            src: snapshotPath,
            repoProfile: profilePath,
            host: projectRusticSnapshotHost(destination_project_id),
            timeoutMs: PROJECT_RUSTIC_TIMEOUT_MS,
            tags,
            progress,
          });
          return {
            time: backup.time,
            id: backup.id,
            summary: backup.summary,
          };
        } finally {
          try {
            await withBtrfsMutationLock({
              mount: vol.filesystem.opts.mount,
              operation: "project-site-migration-snapshot-delete",
              run: async () => {
                await deleteProjectSiteMigrationSnapshot(snapshotPath);
              },
            });
          } finally {
            await rm(stagingRoot, { recursive: true, force: true }).catch(
              () => {},
            );
          }
        }
      },
    });
    await recordManagedBackupEgressBestEffort({
      project_id,
      backup_id: backupResult.id,
      tags,
      summary: backupResult.summary,
      managed_egress_override,
    });
    return backupResult;
  } finally {
    await rm(profileDir, { recursive: true, force: true }).catch((err) => {
      logger.debug("project site migration repo profile cleanup failed", {
        project_id,
        migration_id,
        err: `${err}`,
      });
    });
  }
}

function archiveBackupSourceReleasedError(err: unknown): ConatError {
  return new ConatError(err instanceof Error ? err.message : `${err}`, {
    code: ARCHIVE_BACKUP_SOURCE_RELEASED_ERROR_CODE,
  });
}

async function createBackup({
  project_id,
  limit,
  tags,
  lro,
  managed_egress_override,
  replace_oldest_at_limit,
  freeze_source,
}: {
  project_id: string;
  limit?: number;
  tags?: string[];
  lro?: LroRef;
  managed_egress_override?: ManagedBackupEgressOverride;
  replace_oldest_at_limit?: boolean;
  freeze_source?: boolean;
}): Promise<{ time: Date; id: string; generation: number | null }> {
  const progress = createLroRusticReporter(lro, "backup");
  // The hub may reopen only when the host explicitly proves this stayed false
  // or returned to false after restoring the source and staged snapshots.
  let archiveFreezeMayExist = false;
  const managedBackupPolicy = await checkManagedBackupAllowedBestEffort({
    project_id,
    managed_egress_override,
  }).catch((err) => {
    if (freeze_source) throw archiveBackupSourceReleasedError(err);
    throw err;
  });
  if (!managedBackupPolicy.allowed) {
    const err = new Error(managedBackupPolicy.message);
    if (freeze_source) throw archiveBackupSourceReleasedError(err);
    throw err;
  }
  const result = await withBackupParallelLimit({
    project_id,
    op: "createBackup",
    run: async () =>
      await withBackupConfigRefreshOnMissingBucket({
        project_id,
        op: "createBackup",
        run: async () => {
          const existingBackups =
            limit == null
              ? []
              : await getBackups({
                  project_id,
                  indexed_only: true,
                });
          const retention = planBackupRetention({
            backups: existingBackups,
            limit,
            replaceOldestAtLimit: replace_oldest_at_limit,
          });
          if (!retention.allowed) {
            throw new ConatError(`there is a limit of ${limit} backups`, {
              code: 507,
            });
          }
          const vol = await getVolume(project_id);
          vol.fs.rusticRepo = await resolveRusticRepo(project_id);
          const parent = await getLatestKnownBackupId(project_id);
          let archiveFreeze:
            | Awaited<ReturnType<typeof freezeVolumeForArchiveBackup>>
            | undefined;
          let backupResult: Awaited<ReturnType<(typeof vol.rustic)["backup"]>>;
          try {
            archiveFreezeMayExist = freeze_source === true;
            archiveFreeze = freeze_source
              ? await freezeVolumeForArchiveBackup(vol)
              : undefined;
            try {
              backupResult = await vol.rustic.backup({
                tags,
                parent,
                progress,
                runner: async ({ src, host, timeout, tags, progress }) =>
                  await projectRusticBackup({
                    src,
                    repoProfile: vol.fs.rusticRepo,
                    host,
                    timeoutMs: timeout,
                    tags,
                    parent,
                    progress,
                  }),
              });
            } catch (err) {
              if (!(err instanceof ProjectRusticUnsupportedError)) {
                throw err;
              }
              logger.warn(
                "project rustic wrapper unavailable; falling back to unprivileged backup path",
                {
                  project_id,
                  err: `${err}`,
                },
              );
              backupResult = await vol.rustic.backup({
                tags,
                parent,
                progress,
              });
            }
            const generation = archiveFreeze
              ? await getFrozenVolumeGeneration(vol)
              : await getGeneration(projectMountpoint(project_id)).catch(
                  () => null,
                );
            if (archiveFreeze) {
              logger.debug("archive backup source generation established", {
                project_id,
                backup_id: backupResult.id,
                source_generation: generation,
                snapshot_generation: backupResult.snapshotGeneration,
              });
            }
            // The replacement is intentionally pruned only after the new
            // snapshot exists. A pruning failure may temporarily exceed the
            // entitlement, but must never invalidate the recovery barrier.
            for (const backup of retention.replace) {
              try {
                await deleteBackupForRetention({
                  project_id,
                  id: backup.id,
                  archiveFreezeOwned: freeze_source === true,
                });
              } catch (err) {
                logger.warn("unable to prune replaced backup", {
                  project_id,
                  backup_id: backup.id,
                  replacement_backup_id: backupResult.id,
                  err: `${err}`,
                });
              }
            }
            return {
              time: backupResult.time,
              id: backupResult.id,
              summary: backupResult.summary,
              generation,
            };
          } catch (err) {
            if (freeze_source) {
              try {
                const releaseStatus = await releaseArchiveVolumeFreeze(vol);
                archiveFreezeMayExist = releaseStatus === "absent";
              } catch (releaseErr) {
                logger.error("unable to release failed archive backup freeze", {
                  project_id,
                  err: `${releaseErr}`,
                });
              }
            }
            throw err;
          }
        },
      }),
  }).catch((err) => {
    if (freeze_source && !archiveFreezeMayExist) {
      throw archiveBackupSourceReleasedError(err);
    }
    throw err;
  });
  try {
    await rusticBackupBrowser.markStale(await resolveRusticRepo(project_id));
  } catch (err) {
    // Cache invalidation is not part of backup durability. In particular, an
    // archive backup may intentionally leave the source read-only while the
    // caller persists its generation and performs checked deletion.
    logger.warn("unable to mark backup browser cache stale", {
      project_id,
      backup_id: result.id,
      err: `${err}`,
    });
  }
  await recordManagedBackupEgressBestEffort({
    project_id,
    backup_id: result.id,
    tags,
    summary: result.summary,
    managed_egress_override,
  });
  if (managed_egress_override === LEGACY_MIGRATION_INITIAL_BACKUP_OVERRIDE) {
    legacyProjectInitialBackupEgressExempt.delete(project_id);
  }
  const generation = result.generation;
  try {
    await reportBackupSuccess(project_id, result.time, generation);
  } catch (err) {
    logger.warn("backup success report failed", { project_id, err });
  }
  return { ...result, generation };
}

async function restoreBackup({
  project_id,
  id,
  path: backupPath,
  dest,
  lro,
}: {
  project_id: string;
  id: string;
  path?: string;
  dest?: string;
  lro?: LroRef;
}): Promise<void> {
  const vol = await getVolumeForBackup(project_id);
  const home = projectMountpoint(project_id);
  const scratch = getScratchMountpoint(project_id);
  const stagingRoot = join(dirname(home), RESTORE_STAGING_ROOT);
  const stagingHome = join(stagingRoot, volName(project_id));
  const restorePath = backupPath ?? "";
  const destPath = dest ?? restorePath;

  const assertSubvolumeRoot = async (root: string, label: string) => {
    if (!(await exists(root))) {
      throw new Error(`${label} does not exist: ${root}`);
    }
    const isSubvolume = await isBtrfsSubvolume(root);
    if (!isSubvolume) {
      throw new Error(`${label} is not a btrfs subvolume: ${root}`);
    }
  };

  let root = home;
  let relDest = destPath ?? "";

  if (destPath && path.isAbsolute(destPath)) {
    const containerDest = path.posix.normalize(destPath);
    const runtimeRelative = projectRuntimeHomeRelativePath(containerDest);
    if (runtimeRelative != null) {
      root = home;
      relDest = runtimeRelative;
    } else if (containerDest === "/tmp" || containerDest.startsWith("/tmp/")) {
      root = scratch;
      relDest = path.posix.relative("/tmp", containerDest);
    } else if (
      containerDest === "/scratch" ||
      containerDest.startsWith("/scratch/")
    ) {
      throw new Error(
        "restore destination '/scratch' is no longer supported; use '/tmp' instead",
      );
    } else if (isSubPath(home, destPath)) {
      root = home;
      relDest = path.relative(home, destPath);
    } else if (isSubPath(scratch, destPath)) {
      root = scratch;
      relDest = path.relative(scratch, destPath);
    } else if (isSubPath(stagingHome, destPath)) {
      root = stagingHome;
      relDest = path.relative(stagingHome, destPath);
    } else {
      throw new Error(
        `restore destination must be within project home, /tmp, or restore staging: ${destPath}`,
      );
    }
  } else {
    const resolved = path.resolve(home, destPath || "");
    if (!isSubPath(home, resolved)) {
      throw new Error(`restore destination escapes project home: ${destPath}`);
    }
    root = home;
    relDest = path.relative(home, resolved);
  }

  await assertSubvolumeRoot(
    root,
    root === home
      ? "project home"
      : root === scratch
        ? "project temporary storage"
        : "restore staging",
  );

  const restoreFs =
    root === home
      ? vol.fs
      : new SandboxedFilesystem(root, {
          rusticRepo: vol.fs.rusticRepo,
          host: vol.name,
        });

  const progress = createLroRusticReporter(lro, "restore");
  const absoluteDest = relDest ? path.join(root, relDest) : root;
  const requiresPrivilegedRestore = needsPrivilegedProjectRestore({
    root,
    scratch,
    restorePath,
    relDest,
  });
  if (requiresPrivilegedRestore) {
    await assertBackupSnapshotExists({ project_id, id });
    try {
      await vol.rustic.restore({
        id,
        path: restorePath,
        dest: absoluteDest,
        timeout: PROJECT_RUSTIC_TIMEOUT_MS,
        progress,
        runner: async ({ snapshot, dest, timeout, progress }) =>
          await projectRusticRestore({
            repoProfile: vol.fs.rusticRepo,
            snapshot,
            dest,
            timeoutMs: timeout,
            progress,
          }),
      });
    } catch (err) {
      if (err instanceof ProjectRusticUnsupportedError) {
        throw new Error(
          "host runtime storage wrapper is too old for xattr-preserving restore; reconcile or upgrade the host first",
        );
      }
      throw err;
    }
  } else {
    await restoreFs.rustic(
      ["restore", `${id}${restorePath ? ":" + restorePath : ""}`, relDest],
      {
        timeout: PROJECT_RUSTIC_TIMEOUT_MS,
        env: lro ? { RUSTIC_PROGRESS_INTERVAL: "1s" } : undefined,
        onStderrLine: progress
          ? createRusticProgressHandler({ onProgress: progress })
          : undefined,
      },
    );
  }
  invalidateProjectFsServer(project_id);
  void touchProjectLastEdited(project_id, "restore-backup");
}

async function beginRestoreStaging({
  project_id,
  home,
  restore,
}: {
  project_id: string;
  home?: string;
  restore?: RestoreMode;
}): Promise<RestoreStagingHandle | null> {
  const resolvedHome = home ?? projectMountpoint(project_id);
  return await beginRestoreStagingBtrfs({
    project_id,
    home: resolvedHome,
    restore,
  });
}

async function ensureRestoreStaging({
  handle,
}: {
  handle: RestoreStagingHandle;
}): Promise<void> {
  await ensureRestoreStagingBtrfs(handle);
}

async function finalizeRestoreStaging({
  handle,
}: {
  handle: RestoreStagingHandle;
}): Promise<void> {
  await finalizeRestoreStagingBtrfs(handle);
  invalidateProjectFsServer(handle.project_id);
  void touchProjectLastEdited(handle.project_id, "restore-staging");
}

async function releaseRestoreStaging({
  handle,
  cleanupStaging,
}: {
  handle: RestoreStagingHandle;
  cleanupStaging?: boolean;
}): Promise<void> {
  await releaseRestoreStagingBtrfs(handle, { cleanupStaging });
}

async function cleanupRestoreStaging(opts?: { root?: string }): Promise<void> {
  const root = opts?.root ?? getMountPoint();
  await cleanupRestoreStagingBtrfs({ root });
}

async function forgetBackup({
  project_id,
  id,
}: {
  project_id: string;
  id: string;
}): Promise<void> {
  const vol = await getVolumeForBackup(project_id);
  await vol.rustic.forget({ id });
  await rusticBackupBrowser.markStale(vol.fs.rusticRepo);
  const directIndexStore = await getBackupIndexStoreConfig(project_id).catch(
    () => null,
  );
  if (directIndexStore) {
    try {
      await deleteRemoteProjectBackupIndex({
        project_id,
        backup_id: id,
      });
    } catch (err) {
      logger.warn("backup index delete failed", { project_id, id, err });
    }
  } else {
    try {
      await rustic(
        ["forget", "--filter-label", `${BACKUP_INDEX_LABEL_PREFIX}${id}`],
        {
          repo: vol.fs.rusticRepo,
          host: backupIndexHost(project_id),
          timeout: 30 * 60 * 1000,
        },
      );
    } catch (err) {
      logger.warn("backup index delete failed", { project_id, id, err });
    }
  }
  await removeBackupIndexLocal(project_id, id).catch((err) => {
    logger.warn("backup index cache cleanup failed", { project_id, id, err });
  });
}

async function deleteBackup({
  project_id,
  id,
}: {
  project_id: string;
  id: string;
}): Promise<void> {
  await withProjectVolumeLifecycleLock(project_id, async () => {
    const vol = await getVolumeForBackup(project_id);
    if (!(await exists(vol.path))) {
      throw new Error(
        "cannot delete backups while project data is archived or unavailable",
      );
    }
    if (await isSubvolumeReadonly(vol.path)) {
      throw new Error(
        "cannot delete backups while project archival is in progress",
      );
    }
    await forgetBackup({ project_id, id });
  });
}

async function deleteBackupForRetention({
  project_id,
  id,
  archiveFreezeOwned,
}: {
  project_id: string;
  id: string;
  archiveFreezeOwned: boolean;
}): Promise<void> {
  await withProjectVolumeLifecycleLock(project_id, async () => {
    const vol = await getVolumeForBackup(project_id);
    if (!archiveFreezeOwned && (await isSubvolumeReadonly(vol.path))) {
      throw new Error(
        "cannot apply backup retention while project archival is in progress",
      );
    }
    await forgetBackup({ project_id, id });
  });
}

async function updateBackupsUnlocked({
  project_id,
  counts,
  limit,
}: {
  project_id: string;
  counts?: Partial<SnapshotCounts>;
  limit?: number;
}): Promise<void> {
  if (legacyProjectArchiveRestoreActive.has(project_id)) {
    logger.info("skipping scheduled backup during legacy project restore", {
      project_id,
    });
    return;
  }
  const legacyInitialBackupOverride =
    legacyProjectInitialBackupEgressExempt.has(project_id)
      ? LEGACY_MIGRATION_INITIAL_BACKUP_OVERRIDE
      : undefined;
  const createdBackupIds = new Set<string>();
  let newestCreatedBackupTime: Date | undefined;
  const vol = await withBackupConfigRefreshOnMissingBucket({
    project_id,
    op: "updateBackups",
    run: async () => {
      const refreshed = await getVolumeForBackup(project_id);
      await refreshed.rustic.update(counts, {
        limit,
        tags:
          legacyInitialBackupOverride == null
            ? undefined
            : LEGACY_MIGRATION_INITIAL_BACKUP_TAGS,
        beforeCreate: async () => {
          const managedBackupPolicy = await checkManagedBackupAllowedBestEffort(
            {
              project_id,
              managed_egress_override: legacyInitialBackupOverride,
            },
          );
          if (!managedBackupPolicy.allowed) {
            throw new Error(managedBackupPolicy.message);
          }
        },
        afterCreate: async (created) => {
          const backup = parseCreatedBackupSnapshot(created);
          if (!backup?.id) return;
          createdBackupIds.add(backup.id);
          if (
            backup.time &&
            (!newestCreatedBackupTime || backup.time > newestCreatedBackupTime)
          ) {
            newestCreatedBackupTime = backup.time;
          }
          if (backup.summary) {
            await recordManagedBackupEgressBestEffort({
              project_id,
              backup_id: backup.id,
              tags:
                legacyInitialBackupOverride == null
                  ? undefined
                  : LEGACY_MIGRATION_INITIAL_BACKUP_TAGS,
              summary: backup.summary,
              managed_egress_override: legacyInitialBackupOverride,
            });
          }
        },
      });
      await rusticBackupBrowser.markStale(refreshed.fs.rusticRepo);
      return refreshed;
    },
  });
  let reportTime = newestCreatedBackupTime;
  try {
    const backups = await vol.rustic.snapshots();
    reportTime = newestBackupTimeForIds({
      backups,
      backupIds: createdBackupIds,
      fallback: reportTime,
    });
  } catch (err) {
    logger.warn("backup snapshot refresh failed", { project_id, err });
  }
  if (createdBackupIds.size > 0 && legacyInitialBackupOverride != null) {
    legacyProjectInitialBackupEgressExempt.delete(project_id);
  }
  if (createdBackupIds.size > 0 && reportTime) {
    try {
      const generation = await getGeneration(
        projectMountpoint(project_id),
      ).catch(() => null);
      await reportBackupSuccess(project_id, reportTime, generation);
    } catch (err) {
      logger.warn("scheduled backup success report failed", {
        project_id,
        err,
      });
    }
  }
}

async function updateBackupsIfVolumeCurrent({
  project_id,
  counts,
  limit,
  expectedLifecycleGeneration,
}: {
  project_id: string;
  counts?: Partial<SnapshotCounts>;
  limit?: number;
  expectedLifecycleGeneration: number;
}): Promise<void> {
  const result = await withCurrentProjectVolumeLifecycleLock(
    project_id,
    expectedLifecycleGeneration,
    async () => {
      const volume = await getVolumeUnchecked(project_id);
      if (!(await exists(volume.path))) {
        logger.info(
          "skipping backup maintenance because project data is unavailable",
          { project_id },
        );
        return true;
      }
      if (await isSubvolumeReadonly(volume.path)) {
        logger.info(
          "skipping backup maintenance because project archival is in progress",
          { project_id },
        );
        return true;
      }
      await updateBackupsUnlocked({
        project_id,
        counts,
        limit,
      });
      return true;
    },
  );
  if (result === undefined) {
    logger.info(
      "skipping stale backup maintenance after project volume lifecycle changed",
      {
        project_id,
        expected_lifecycle_generation: expectedLifecycleGeneration,
        current_lifecycle_generation:
          currentProjectVolumeLifecycleGeneration(project_id),
      },
    );
  }
}

async function updateBackups({
  project_id,
  counts,
  limit,
}: {
  project_id: string;
  counts?: Partial<SnapshotCounts>;
  limit?: number;
}): Promise<void> {
  const expectedLifecycleGeneration =
    currentProjectVolumeLifecycleGeneration(project_id);
  await withBackupParallelLimit({
    project_id,
    op: "updateBackups",
    run: async () =>
      await updateBackupsIfVolumeCurrent({
        project_id,
        counts,
        limit,
        expectedLifecycleGeneration,
      }),
  });
}

export async function runScheduledBackupMaintenance({
  project_id,
  counts,
  limit = 30,
}: {
  project_id: string;
  counts: Partial<SnapshotCounts>;
  limit?: number;
}): Promise<void> {
  const expectedLifecycleGeneration =
    currentProjectVolumeLifecycleGeneration(project_id);
  await withBackupParallelLimit({
    project_id,
    op: "runScheduledBackupMaintenance",
    queue_if_busy: false,
    run: async () =>
      await updateBackupsIfVolumeCurrent({
        project_id,
        counts,
        limit,
        expectedLifecycleGeneration,
      }),
  });
}

export async function getBackups({
  project_id,
  indexed_only,
}: {
  project_id: string;
  indexed_only?: boolean;
}): Promise<
  {
    id: string;
    time: Date;
    summary: { [key: string]: string | number };
  }[]
> {
  void indexed_only;
  const profilePath = await resolveRusticRepo(project_id);
  try {
    return await rusticBackupBrowser.listBackups({
      profilePath,
      projectId: project_id,
    });
  } catch (err) {
    if (isMissingRusticRepositoryError(err)) {
      return [];
    }
    throw err;
  }
}

async function getBackupFiles({
  project_id,
  id,
  path,
}: {
  project_id: string;
  id: string;
  path?: string;
}): Promise<{ name: string; isDir: boolean; mtime: number; size: number }[]> {
  return await rusticBackupBrowser.listDirectory({
    profilePath: await resolveRusticRepo(project_id),
    projectId: project_id,
    id,
    path,
  });
}

async function findBackupFiles({
  project_id,
  glob,
  iglob,
  path,
  ids,
  preview,
  recursive,
}: {
  project_id: string;
  glob?: string[];
  iglob?: string[];
  path?: string;
  ids?: string[];
  preview?: boolean;
  recursive?: boolean;
}): Promise<BackupBrowserSearchResult[] | BackupBrowserSearchResponse> {
  const response = await rusticBackupBrowser.find({
    profilePath: await resolveRusticRepo(project_id),
    projectId: project_id,
    glob,
    iglob,
    path,
    ids,
    preview,
    recursive,
  });
  return preview ? response : response.results;
}

async function getBackupFileText({
  project_id,
  id,
  path: previewPath,
  max_bytes,
}: {
  project_id: string;
  id: string;
  path: string;
  max_bytes?: number;
}): Promise<{
  content: string;
  truncated: boolean;
  size: number;
  mtime: number;
}> {
  const cleanedPath = normalizePreviewPath(previewPath);
  const entry = await rusticBackupBrowser.getEntry({
    profilePath: await resolveRusticRepo(project_id),
    projectId: project_id,
    id,
    path: cleanedPath,
  });
  if (!entry) {
    throw new Error("backup file does not exist");
  }
  if (entry.isDir) {
    throw new Error("path is a directory");
  }
  const maxBytes = max_bytes ?? MAX_TEXT_PREVIEW_BYTES;
  await mkdir(backupIndexDir(project_id), { recursive: true });
  const tmpDir = await mkdtemp(join(backupIndexDir(project_id), "preview-"));
  try {
    const vol = await getVolumeForBackup(project_id);
    const previewFs = new SandboxedFilesystem(backupIndexDir(project_id), {
      host: vol.name,
      rusticRepo: vol.fs.rusticRepo,
    });
    const dest = path.relative(backupIndexDir(project_id), tmpDir);
    await previewFs.rustic(["restore", `${id}:${cleanedPath}`, dest], {
      timeout: 5 * 60 * 1000,
    });
    const restoredPath = join(tmpDir, cleanedPath);
    if (!isSubPath(tmpDir, restoredPath)) {
      throw new Error("invalid restore path");
    }
    // Rustic restore of a single file writes it directly into the destination
    // directory (basename only), not the original path hierarchy.
    const previewPath = join(tmpDir, path.posix.basename(cleanedPath));
    if (!(await exists(previewPath))) {
      throw new Error("restored file not found");
    }
    return await readTextPreview({
      filePath: previewPath,
      size: entry.size,
      mtime: entry.mtime,
      maxBytes,
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function getSnapshotFileText({
  project_id,
  snapshot,
  path: previewPath,
  max_bytes,
}: {
  project_id: string;
  snapshot: string;
  path: string;
  max_bytes?: number;
}): Promise<{
  content: string;
  truncated: boolean;
  size: number;
  mtime: number;
}> {
  // Snapshot previews are read directly from the filesystem path; keeping this
  // API ensures consistent size limits and binary detection.
  const cleanedPath = normalizePreviewPath(previewPath);
  const vol = await getVolume(project_id);
  const snapshotPath = vol.snapshots.path(snapshot, cleanedPath);
  const absPath = await vol.fs.safeAbsPath(snapshotPath);
  const maxBytes = max_bytes ?? MAX_TEXT_PREVIEW_BYTES;
  return await readTextPreview({ filePath: absPath, maxBytes });
}

export async function initFsServer({
  client,
  service = DEFAULT_FILE_SERVICE,
}: {
  client: ConatClient;
  service?: string;
}) {
  logger.debug("initFsServer");
  return await fsServer({
    service,
    client,
    fs: async (subject?: string) => {
      if (!subject) {
        throw Error("fsServer requires subject");
      }
      const project_id = projectIdFromSubject(subject);
      const { path } = await getOrEnsureVolume(project_id);
      return createProjectSandboxFilesystem({
        project_id,
        home: path,
        rootfs: getRootfsMountpoint(project_id),
        scratch: getScratchMountpoint(project_id),
        sharedScratch: getSharedScratchMountpoint(),
        deleteSnapshot: async (name: string) =>
          await deleteSnapshot({ project_id, name }),
      });
    },
    onMutation: ({ subject, op }) => {
      const project_id = projectIdFromSubject(subject);
      void touchProjectLastEdited(project_id, `fs:${op}`);
    },
    jupyter: {
      importIpynb: async ({ subject, ipynb }) =>
        await importJupyterIpynb({
          project_id: projectIdFromSubject(subject),
          ipynb,
        }),
      saveIpynb: async ({ subject, path, ipynb, fs }) =>
        await saveJupyterIpynb({
          project_id: projectIdFromSubject(subject),
          path,
          ipynb,
          fs,
        }),
    },
  });
}

const fileDownloadReadServers = new Map<string, Promise<void>>();

function viewerFileDownloadReadServiceName({
  account_id,
}: {
  account_id: string;
}) {
  return `${PROJECT_HOST_FILE_DOWNLOAD_READ_SERVICE}-viewer-account-${account_id}`;
}

function shareFileDownloadReadServiceName({
  share_id,
  account_id,
}: {
  share_id: string;
  account_id: string;
}) {
  return `${PROJECT_HOST_FILE_DOWNLOAD_READ_SERVICE}-share-${share_id}-account-${account_id}`;
}

async function createProjectFilesystem(project_id: string) {
  const { path: home } = await getOrEnsureVolume(project_id);
  return createProjectSandboxFilesystem({
    project_id,
    home,
    rootfs: getRootfsMountpoint(project_id),
    scratch: getScratchMountpoint(project_id),
    sharedScratch: getSharedScratchMountpoint(),
    deleteSnapshot: async (name: string) =>
      await deleteSnapshot({ project_id, name }),
  });
}

export async function ensureFileDownloadReadServer({
  client,
  project_id,
}: {
  client: ConatClient;
  project_id: string;
}) {
  let server = fileDownloadReadServers.get(project_id);
  if (server == null) {
    server = createReadServer({
      client,
      project_id,
      name: PROJECT_HOST_FILE_DOWNLOAD_READ_SERVICE,
      createReadStream: async (containerPath: string, opts?: any) => {
        const fs = await createProjectFilesystem(project_id);
        return await fs.createReadStream(containerPath, opts);
      },
    })
      .then(() => undefined)
      .catch((err) => {
        fileDownloadReadServers.delete(project_id);
        throw err;
      });
    fileDownloadReadServers.set(project_id, server);
  }
  await server;
}

export async function ensureViewerFileDownloadReadServer({
  client,
  project_id,
  account_id,
}: {
  client: ConatClient;
  project_id: string;
  account_id: string;
}): Promise<{ readServiceName: string; statSubject: string }> {
  const readServiceName = viewerFileDownloadReadServiceName({ account_id });
  const statSubject = viewerFsSubject({ project_id, account_id });
  const key = `${project_id}:viewer:${account_id}`;
  let server = fileDownloadReadServers.get(key);
  if (server == null) {
    server = createReadServer({
      client,
      project_id,
      name: readServiceName,
      createReadStream: async (containerPath: string, opts?: any) => {
        const projectFs = await createProjectFilesystem(project_id);
        const readPolicy = await getViewerReadPolicy({
          project_id,
          account_id,
        });
        return await projectFs.createAuthorizedReadStream(
          containerPath,
          opts,
          async (canonicalIdentity) => {
            assertViewerCanonicalPathAllowed({
              canonicalIdentity,
              readPolicy,
              path: containerPath,
            });
          },
        );
      },
    })
      .then(() => undefined)
      .catch((err) => {
        fileDownloadReadServers.delete(key);
        throw err;
      });
    fileDownloadReadServers.set(key, server);
  }
  await server;
  return { readServiceName, statSubject };
}

export async function ensureShareFileDownloadReadServer({
  client,
  project_id,
  share_id,
  account_id,
}: {
  client: ConatClient;
  project_id: string;
  share_id: string;
  account_id: string;
}): Promise<{ readServiceName: string; statSubject: string }> {
  const readServiceName = shareFileDownloadReadServiceName({
    share_id,
    account_id,
  });
  const statSubject = shareFsSubject({ project_id, share_id, account_id });
  const key = `${project_id}:share:${share_id}:${account_id}`;
  let server = fileDownloadReadServers.get(key);
  if (server == null) {
    server = createReadServer({
      client,
      project_id,
      name: readServiceName,
      createReadStream: async (containerPath: string, opts?: any) => {
        const projectFs = await createProjectFilesystem(project_id);
        const readPolicy = await getShareReadPolicy({
          project_id,
          share_id,
          account_id,
        });
        return await projectFs.createAuthorizedReadStream(
          containerPath,
          opts,
          async (canonicalIdentity) => {
            assertViewerCanonicalPathAllowed({
              canonicalIdentity,
              readPolicy,
              path: containerPath,
            });
          },
        );
      },
    })
      .then(() => undefined)
      .catch((err) => {
        fileDownloadReadServers.delete(key);
        throw err;
      });
    fileDownloadReadServers.set(key, server);
  }
  await server;
  return { readServiceName, statSubject };
}

export const PROJECT_HOST_FILE_UPLOAD_WRITE_SERVICE = ":project-host";

const fileUploadWriteServers = new Map<string, Promise<void> | undefined>();

export async function ensureFileUploadWriteServer({
  client,
  project_id,
}: {
  client: ConatClient;
  project_id: string;
}) {
  let server = fileUploadWriteServers.get(project_id);
  if (server == null) {
    server = createWriteServer({
      client,
      project_id,
      name: PROJECT_HOST_FILE_UPLOAD_WRITE_SERVICE,
      createWriteStream: async (containerPath: string) => {
        const { path: home } = await getOrEnsureVolume(project_id);
        const fs = createProjectSandboxFilesystem({
          project_id,
          home,
          rootfs: getRootfsMountpoint(project_id),
          scratch: getScratchMountpoint(project_id),
          sharedScratch: getSharedScratchMountpoint(),
          deleteSnapshot: async (name: string) =>
            await deleteSnapshot({ project_id, name }),
        });
        await fs.mkdir(dirname(containerPath), { recursive: true });
        return await fs.createWriteStream(containerPath);
      },
    })
      .then(() => undefined)
      .catch((err) => {
        fileUploadWriteServers.delete(project_id);
        throw err;
      });
    fileUploadWriteServers.set(project_id, server);
  }
  await server;
}

export async function initViewerFsServer({
  client,
  service = VIEWER_FILE_SERVICE,
}: {
  client: ConatClient;
  service?: string;
}) {
  logger.debug("initViewerFsServer");
  return await fsReadOnlyServer({
    service,
    client,
    fs: async (subject?: string) => {
      if (!subject) {
        throw Error("fsReadOnlyServer requires subject");
      }
      const { project_id, account_id } = viewerSubjectFromSubject(subject);
      const { path } = await getOrEnsureVolume(project_id);
      const projectFs = createProjectSandboxFilesystem({
        project_id,
        home: path,
        rootfs: getRootfsMountpoint(project_id),
        scratch: getScratchMountpoint(project_id),
        sharedScratch: getSharedScratchMountpoint(),
        deleteSnapshot: async (name: string) =>
          await deleteSnapshot({ project_id, name }),
      });
      return createViewerReadOnlyFilesystem({
        fs: projectFs,
        readPolicy: await getViewerReadPolicy({ project_id, account_id }),
      });
    },
  });
}

export async function initShareFsServer({
  client,
  service = SHARE_FILE_SERVICE,
}: {
  client: ConatClient;
  service?: string;
}) {
  logger.debug("initShareFsServer");
  return await fsReadOnlyServer({
    service,
    client,
    fs: async (subject?: string) => {
      if (!subject) {
        throw Error("fsReadOnlyServer requires subject");
      }
      const { project_id, share_id, account_id } =
        shareSubjectFromSubject(subject);
      const { path } = await getOrEnsureVolume(project_id);
      const projectFs = createProjectSandboxFilesystem({
        project_id,
        home: path,
        rootfs: getRootfsMountpoint(project_id),
        scratch: getScratchMountpoint(project_id),
        sharedScratch: getSharedScratchMountpoint(),
        deleteSnapshot: async (name: string) =>
          await deleteSnapshot({ project_id, name }),
      });
      return createViewerReadOnlyFilesystem({
        fs: projectFs,
        readPolicy: await getShareReadPolicy({
          project_id,
          share_id,
          account_id,
        }),
      });
    },
  });
}

function invalidateProjectFsServer(project_id: string): void {
  servers?.file?.invalidateSubject?.(fsSubject({ project_id }));
  servers?.viewerFile?.invalidateAll?.();
  servers?.shareFile?.invalidateAll?.();
}

let servers: null | { ssh: any; file: any; viewerFile: any; shareFile: any } =
  null;

export async function initFileServer({
  client,
  enableSsh = process.env.COCALC_SSH_SERVER_COUNT !== "0",
}: {
  client: ConatClient;
  enableSsh?: boolean;
}) {
  logger.debug("initFileServer", { enableSsh });
  if (servers != null) {
    logger.debug("initFileServer: already initialized");

    return servers;
  }

  if (fs == null) {
    if (fileServerMountpoint) {
      const resolvedRusticRepo = await resolveRusticRepo();
      logger.debug("initFileServer: initializing fs mountpoint", {
        fileServerMountpoint,
        resolvedRusticRepo,
      });
      fs = await filesystem({
        mount: fileServerMountpoint,
        rustic: resolvedRusticRepo,
        withTemporaryQuotaOverride: withManagedTemporaryQuotaOverride,
      });
    } else {
      const imageDir = join(data, "btrfs", "image");
      const mountPoint = join(data, "btrfs", "mnt");
      const resolvedRusticRepo = await resolveRusticRepo();
      logger.debug("initFileServer: initializing fs mountpoint", {
        mountPoint,
        resolvedRusticRepo,
      });
      if (!(await exists(imageDir))) {
        await mkdir(imageDir, { recursive: true });
      }
      if (!(await exists(mountPoint))) {
        await mkdir(mountPoint, { recursive: true });
      }
      fs = await filesystem({
        image: join(imageDir, "btrfs.img"),
        size: "25G",
        mount: mountPoint,
        rustic: resolvedRusticRepo,
        withTemporaryQuotaOverride: withManagedTemporaryQuotaOverride,
      });
    }
  }

  const quotaRuntime = fs.getQuotaRuntime();
  const filesystemQuotaState = reconcileProjectFilesystemQuotaState({
    mountpoint: fs.opts.mount,
    filesystem_uuid: quotaRuntime.filesystem_uuid,
    quota_mode: quotaRuntime.status.mode,
    quota_mode_reconciled: quotaRuntime.reconciled,
  });
  logger.info("initialized durable project filesystem quota state", {
    mountpoint: filesystemQuotaState.mountpoint,
    filesystem_uuid: filesystemQuotaState.filesystem_uuid,
    quota_mode: filesystemQuotaState.quota_mode,
    quota_epoch: filesystemQuotaState.quota_epoch,
    quota_mode_reconciled: quotaRuntime.reconciled,
  });
  const overrideRecovery =
    await projectVolumeQuotaManager.recoverUnreleasedOverrides({
      reason: "restart",
      limit: 4096,
    });
  if (
    overrideRecovery.released > 0 ||
    overrideRecovery.errors > 0 ||
    overrideRecovery.remaining > 0
  ) {
    logger.warn("recovered temporary project volume quota overrides", {
      ...overrideRecovery,
    });
  }
  startProjectQuotaOverrideScavenger();

  logger.debug("initFileServer: create conat server");

  try {
    await cleanupRestoreStaging();
  } catch (err) {
    logger.warn("restore staging cleanup failed", { err: `${err}` });
  }

  const file = await createFileServer({
    client,
    mount: reuseInFlight(mount),
    ensureVolume: reuseInFlight(async ({ project_id, scratch }) => {
      await ensureVolume(project_id, scratch);
    }),
    resetScratchVolume: reuseInFlight(async ({ project_id }) => {
      await resetScratchVolume(project_id);
    }),
    clone,
    getUsage: reuseInFlight(getUsage),
    getQuota: reuseInFlight(getQuota),
    setQuota,
    cp,
    getCopyCapabilities: async () => ({ exact_replace: true }),
    flushJupyterNotebooksToDisk: reuseInFlight((opts) =>
      flushJupyterNotebooksToDisk({ client, ...opts }),
    ),
    createPathCopyArchive: reuseInFlight(createPathCopyArchive),
    applyPathCopyArchive: reuseInFlight(applyPathCopyArchive),
    // backups
    createBackup: reuseInFlight(createBackup),
    backupProjectToExternalRepository: reuseInFlight(
      backupProjectToExternalRepository,
    ),
    restoreBackup: reuseInFlight(restoreBackup),
    restoreProjectArchive: reuseInFlight(
      legacyProjectArchiveHandlers.restoreProjectArchive,
    ),
    prepareLegacyProjectArchiveRemediation: reuseInFlight(
      legacyProjectArchiveHandlers.prepareLegacyProjectArchiveRemediation,
    ),
    applyLegacyProjectArchiveRemediation: reuseInFlight(
      legacyProjectArchiveHandlers.applyLegacyProjectArchiveRemediation,
    ),
    beginRestoreStaging,
    ensureRestoreStaging,
    finalizeRestoreStaging,
    releaseRestoreStaging,
    cleanupRestoreStaging,
    deleteBackup: reuseInFlight(deleteBackup),
    updateBackups: reuseInFlight(updateBackups),
    getBackups: reuseInFlight(getBackups),
    getBackupFiles: reuseInFlight(getBackupFiles),
    findBackupFiles: reuseInFlight(findBackupFiles),
    getBackupFileText: reuseInFlight(getBackupFileText),
    getDirectorySummary: reuseInFlight(getDirectorySummary),
    // snapshots
    createSnapshot,
    deleteSnapshot,
    pruneSnapshotPath,
    updateSnapshots,
    allSnapshotUsage,
    getSnapshotFileText: reuseInFlight(getSnapshotFileText),
    restoreSnapshot: reuseInFlight(restoreSnapshot),
    publishRootfsImage: reuseInFlight(publishRootfsImage),
    uploadRootfsReleaseArtifact: reuseInFlight(uploadRootfsReleaseArtifact),
  });
  const viewerFile = await initViewerFsServer({ client });
  const shareFile = await initShareFsServer({ client });
  logger.debug("initFileServer: fs successfully initialized");
  startProjectQuotaRepairMonitor();

  // Expose fast in-host file I/O for ACP/container executor when running
  // inside project-host. The detached ACP worker also calls this directly so
  // file reads/writes keep working while the main project-host process is
  // restarting.
  configureProjectHostAcpContainerFileIO();

  let ssh: any = { close: () => {}, projectProxyHandlers: [] };
  if (enableSsh) {
    logger.debug("initFileServer: configure ssh proxy");

    logger.debug("initFileServer: get host id...");
    const hostId = requireHostId();
    logger.debug("initFileServer: hostId", hostId);
    // sshpiperd must use the stable per-host keypair persisted in sqlite.
    const sshpiperdKey = ensureSshpiperdKey(hostId);
    logger.debug("initFileServer: got key");
    const hostKeyPath = join(secrets, "sshpiperd", "host_key");
    logger.debug("initFileServer: create", dirname(hostKeyPath));
    await mkdir(dirname(hostKeyPath), { recursive: true });
    logger.debug("initFileServer: create", hostKeyPath);
    await writeFile(hostKeyPath, sshpiperdKey.privateKey, { mode: 0o600 });
    await chmod(hostKeyPath, 0o600);
    logger.debug("initFileServer: ssh configured");
    const getSshdPort = async (
      target: SshTarget,
      { account_id, allowWake }: { account_id?: string; allowWake: boolean },
    ): Promise<number | null> => {
      const existingPort = normalizePositivePort(
        getProject(target.project_id)?.ssh_port,
      );
      if (existingPort != null) {
        return existingPort;
      }
      // Project-local authorized_keys have no account identity, so they must
      // not wake stopped projects and bypass ban/runtime-slot admission.
      if (!allowWake || !account_id) {
        return null;
      }
      return await ensureProjectSshWake({
        account_id,
        project_id: target.project_id,
      });
    };

    const getSshUser = async (): Promise<string> =>
      `${process.env.COCALC_LAUNCHPAD_SSHD_USER ?? process.env.COCALC_RUNTIME_USER ?? DEFAULT_PROJECT_RUNTIME_USER}`.trim() ||
      DEFAULT_PROJECT_RUNTIME_USER;
    const checkManagedSshAllowed = async ({
      project_id,
      account_id,
    }: {
      project_id: string;
      account_id?: string;
    }) => {
      const policy = await hubApi.system.getManagedProjectEgressPolicy({
        account_id,
        project_id,
        category: "ssh",
      });
      if (policy.allowed) {
        return { allowed: true as const };
      }
      return {
        allowed: false as const,
        message: [
          "SSH traffic limit reached for this account.",
          "New SSH traffic is temporarily blocked until the network usage window resets.",
          ...formatManagedEgressPolicyDetails(policy),
        ].join("\n"),
      };
    };
    const recordManagedSshEgress = async ({
      project_id,
      account_id,
      remote_addr,
      bytes,
      partial,
    }: {
      project_id: string;
      account_id?: string;
      remote_addr: string;
      bytes: number;
      partial: boolean;
    }) => {
      if (!(bytes > 0)) return;
      await hubApi.system.recordManagedProjectEgress({
        account_id,
        project_id,
        category: "ssh",
        bytes,
        metadata: {
          remote_addr,
          partial,
        },
      });
    };
    const authorizePublicKey = async ({
      target,
      public_key,
      remote_addr,
    }: {
      target: SshTarget;
      public_key: Uint8Array;
      remote_addr: string;
    }) => {
      const project_id = target.project_id;
      const row = getProject(project_id);
      if (!row) {
        throw new Error(`project ${project_id} is not available`);
      }
      const ssh_user = await getSshUser();
      const fingerprints = sshPublicKeyCandidateFingerprints(public_key);
      const managedKeys = `${row.authorized_keys ?? ""}`.trim();
      const managedFingerprint = managedKeys
        ? matchingAuthorizedKeyFingerprint(managedKeys, fingerprints)
        : undefined;
      if (managedFingerprint) {
        let account_id: string;
        try {
          account_id = await requireManagedSshKeyAccount({
            project_id,
            fingerprint: managedFingerprint,
            resolveAccount: hubApi.system.resolveManagedProjectSshKeyAccount,
          });
        } catch (err) {
          logger.warn("failed to resolve managed ssh key account", {
            project_id,
            remote_addr,
            fingerprints,
            err: `${err}`,
          });
          throw err;
        }
        const allowed = await checkManagedSshAllowed({
          project_id,
          account_id,
        });
        if (!allowed.allowed) {
          throw new Error(allowed.message);
        }
        const port = await getSshdPort(target, {
          account_id,
          allowWake: true,
        });
        if (!port) {
          throw new Error(
            `project ${project_id} is not accepting ssh connections`,
          );
        }
        return {
          project_id,
          account_id,
          ssh_user,
          port,
        };
      }

      let userAuthorizedKeys = "";
      try {
        const { path } = await mount({ project_id });
        userAuthorizedKeys = await readFile(
          join(path, ".ssh", "authorized_keys"),
          "utf8",
        );
      } catch (err) {
        logger.debug("failed to read user ssh authorized_keys", {
          project_id,
          remote_addr,
          err: `${err}`,
        });
      }
      if (
        userAuthorizedKeys &&
        authorizedKeysContainAnyFingerprint(userAuthorizedKeys, fingerprints)
      ) {
        const allowed = await checkManagedSshAllowed({ project_id });
        if (!allowed.allowed) {
          throw new Error(allowed.message);
        }
        const port = await getSshdPort(target, { allowWake: false });
        if (!port) {
          throw new Error(
            "project-local ssh keys are authorized only after the project is already running",
          );
        }
        return {
          project_id,
          ssh_user,
          port,
        };
      }

      logger.warn("ssh public key is not authorized for project", {
        project_id,
        remote_addr,
        fingerprints,
        public_key_bytes: public_key.length,
        managed_keys_bytes: managedKeys.length,
        user_authorized_keys_bytes: userAuthorizedKeys.length,
      });
      throw new Error("ssh public key is not authorized for this project");
    };

    logger.debug("initFileServer: start ssh server");

    ssh = await initSshServer({
      proxyHandlers: true,
      authorizePublicKey,
      checkManagedSshAllowed,
      recordManagedSshEgress,
      noteManagedSshBoundaryBytes: ({ project_id, bytes }) => {
        if (!(bytes > 0)) return;
        managedProjectEgressResidualTracker.noteBoundaryClassifiedBytes({
          project_id,
          category: "ssh",
          bytes,
        });
      },
      hostKeyPath,
    });
  }

  logger.debug("initFileServer: success");

  servers = { file, ssh, viewerFile, shareFile };
  return servers;
}

// Update the managed authorized_keys file for a project. This is used when the
// master pushes refreshed SSH keys; it does not touch the user's ~/.ssh/authorized_keys.
export async function writeManagedAuthorizedKeys(
  project_id: string,
  keys?: string,
): Promise<void> {
  const content = (keys ?? "").trim();
  const formatted = content
    ? content.endsWith("\n")
      ? content
      : `${content}\n`
    : "";
  if (!formatted) return;
  let vol;
  try {
    vol = await getVolume(project_id);
  } catch (err) {
    logger.debug("writeManagedAuthorizedKeys: missing volume", {
      project_id,
      err: `${err}`,
    });
    return;
  }
  const managedPath = join(vol.path, INTERNAL_SSH_CONFIG, "authorized_keys");
  const managedDir = join(vol.path, INTERNAL_SSH_CONFIG);
  await mkdir(managedDir, { recursive: true, mode: 0o700 });
  await chmod(managedDir, 0o700).catch(() => {});
  const tmpPath = join(managedDir, `.tmp-authorized_keys-${randomUUID()}`);
  try {
    await writeFile(tmpPath, formatted, { mode: 0o600 });
    await chmod(tmpPath, 0o600).catch(() => {});
    await rename(tmpPath, managedPath);
    await chmod(managedPath, 0o600).catch(() => {});
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

export function closeFileServer() {
  if (servers == null) {
    return;
  }
  const { file, ssh, viewerFile, shareFile } = servers;
  servers = null;
  file.close();
  viewerFile.close();
  shareFile.close();
  void ssh.close?.();
}

let cachedClient: null | Fileserver = null;
export function fileServerClient(
  client: ConatClient,
  timeout?: number,
): Fileserver {
  if (timeout != null) {
    return createFileClient({ client, timeout });
  }
  cachedClient ??= createFileClient({ client });
  return cachedClient!;
}
