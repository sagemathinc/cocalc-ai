/*
File server - manages where projects are stored.

This is a conat service that runs directly on the btrfs file server.
Only admin processes (hubs) can talk directly to it, not normal users.
It handles:

Core Functionality:

  - creating volume where a project's files are stored
     - from scratch, and as a zero-cost clone of an existing project
  - copy files between distinct volumes (with btrfs this is done via
    highly efficient dedup'd cloning).

Additional functionality:
  - set a quota on project volume
  - delete volume
  - create snapshot
  - update snapshots
  - create backup

The subject is file-server.{project_id} and there are many file-servers, one
for each project-host.

Note: file writes are handled by the conat fs service. `writeFileDelta` is
preferred by sync-doc because it can apply patches and perform atomic
write+rename on the backend; plain `writeFile` may still be a truncate+write
path, which can corrupt large chat logs if interrupted mid-write.
*/

import { ConatError, type Client } from "@cocalc/conat/core/client";
import { type SnapshotCounts } from "@cocalc/util/consts/snapshots";
import type { ProjectBackupIndexStoreConfig } from "@cocalc/conat/hub/api/hosts";
import type {
  PublishProjectRootfsArtifact,
  RootfsArtifactTransferTarget,
  RootfsUploadedArtifactResult,
} from "@cocalc/util/rootfs-images";
import { type CopyOptions } from "./fs";
export { type CopyOptions };
import { type LroScopeType } from "@cocalc/conat/hub/api/lro";
import { isValidUUID } from "@cocalc/util/misc";

const SUBJECT = "file-server";

export type RestoreMode = "none" | "auto" | "recover" | "required";
export type SnapshotRestoreMode = "home" | "rootfs" | "both";

export interface BackupFindResult {
  id: string;
  time: Date;
  path: string;
  isDir: boolean;
  mtime: number;
  size: number;
}

export interface BackupFindPreview {
  results: BackupFindResult[];
  truncated: boolean;
  truncationReason?: "results" | "time" | "limits";
}

export interface RestoreStagingHandle {
  project_id: string;
  home: string;
  restore: RestoreMode;
  homeExists: boolean;
  stagingRoot: string;
  stagingPath: string;
  markerPath: string;
}

export interface LroRef {
  op_id: string;
  scope_type: LroScopeType;
  scope_id: string;
}

export type ManagedProjectEgressOverride =
  | "admin-host-drain"
  | "legacy-migration-initial-backup"
  | "admin-site-migration";
export type ManagedBackupEgressOverride = ManagedProjectEgressOverride;

export interface SignedProjectArchiveDownload {
  url: string;
  headers?: Record<string, string>;
  bucket?: string | null;
  key?: string | null;
  sha256?: string | null;
  bytes?: number | null;
}

export interface ProjectArchiveRestoreResult {
  bytes: number;
  sha256: string;
  file_count: number;
  uncompressed_bytes?: number;
  quota_used_bytes?: number;
  quota_size_bytes?: number;
  skipped_file_count?: number;
  skipped_bytes?: number;
  skipped_files?: ProjectArchiveEntry[];
  unsafe_path_count?: number;
  unsafe_paths?: string[];
  missing_archive_file_count?: number;
  missing_archive_files?: string[];
  duration_ms: number;
}

export interface ProjectArchiveEntry {
  path: string;
  size: number;
  type: "file" | "directory" | "symlink" | "other";
  mtime?: string;
}

export type LegacyProjectArchiveRemediationDiffKind =
  | "add"
  | "update"
  | "delete"
  | "other";

export interface LegacyProjectArchiveRemediationDiffEntry {
  path: string;
  kind: LegacyProjectArchiveRemediationDiffKind;
  itemized?: string;
}

export interface LegacyProjectArchiveRemediationResult {
  snapshot_name: string;
  snapshot_path: string;
  diff_counts: Record<LegacyProjectArchiveRemediationDiffKind, number>;
  diff_files: LegacyProjectArchiveRemediationDiffEntry[];
  diff_file_count: number;
  truncated: boolean;
  file_count?: number;
  uncompressed_bytes?: number;
  skipped_file_count?: number;
  skipped_bytes?: number;
  unsafe_path_count?: number;
  unsafe_paths?: string[];
  missing_archive_file_count?: number;
  missing_archive_files?: string[];
  bytes?: number;
  sha256?: string;
  duration_ms: number;
}

export interface LegacyProjectArchiveRemediationApplyResult {
  snapshot_name: string;
  safety_snapshot_name: string;
  applied_counts: Record<LegacyProjectArchiveRemediationDiffKind, number>;
  applied_files: LegacyProjectArchiveRemediationDiffEntry[];
  applied_file_count: number;
  truncated: boolean;
  duration_ms: number;
}

export interface PathCopyArchiveRoot {
  archive_path: string;
  source_path: string;
}

export interface PathCopyArchive {
  format: "cocalc-path-copy-tar-gzip-v1";
  archive: Buffer;
  sha256: string;
  bytes: number;
  uncompressed_bytes: number;
  file_count: number;
  roots: PathCopyArchiveRoot[];
}

export interface PathCopyArchiveDestination {
  project_id: string;
  roots: {
    archive_path: string;
    dest_path: string;
  }[];
}

export interface ExternalProjectBackupIndexResult {
  object_key: string;
  compression: "gzip";
  sqlite_bytes: number;
  object_bytes: number;
  sha256: string;
}

export interface ExternalProjectBackupResult {
  time: Date;
  id: string;
  summary: { [key: string]: string | number };
  index?: ExternalProjectBackupIndexResult;
}

export interface FileTextPreview {
  content: string;
  truncated: boolean;
  size: number;
  mtime: number;
}

export interface DirectorySummaryEntry {
  path: string;
  type: "directory" | "file" | "symlink" | "other";
  size: number | null;
  mtime: string | null;
}

export interface DirectorySummary {
  project_id: string;
  root: string;
  max_depth: number;
  limit: number;
  truncated: boolean;
  entries: DirectorySummaryEntry[];
}

export interface Fileserver {
  mount: (opts: {
    project_id: string;
    // if true, resolve the non-backed-up scratch volume path
    scratch?: boolean;
  }) => Promise<{ path: string }>;
  // ensure a project volume exists (idempotent)
  ensureVolume: (opts: {
    project_id: string;
    // if true, ensure the non-backed-up scratch volume
    scratch?: boolean;
  }) => Promise<void>;
  // Recreate the non-backed-up scratch volume, which project runtimes mount at
  // /tmp. This must only be called when no project container is using it.
  resetScratchVolume: (opts: { project_id: string }) => Promise<void>;

  // create project_id as an exact lightweight clone of src_project_id
  clone: (opts: {
    project_id: string;
    src_project_id: string;
  }) => Promise<void>;

  getUsage: (opts: { project_id: string }) => Promise<{
    size: number;
    used: number;
    free: number;
  }>;

  getQuota: (opts: {
    project_id: string;
    // if true, operate on scratch volume quota
    scratch?: boolean;
  }) => Promise<{
    size: number;
    used: number;
    qgroupid?: string;
    scope?: "subvolume";
    warning?: string;
  }>;

  setQuota: (opts: {
    project_id: string;
    size: number | string;
    // if true, operate on scratch volume quota
    scratch?: boolean;
  }) => Promise<void>;

  cp: (opts: {
    src: { project_id: string; path: string | string[] };
    dest: { project_id: string; path: string };
    options?: CopyOptions;
  }) => Promise<void>;

  // Bounded cross-host copy fast path. The source host creates a compressed
  // archive from a read-only snapshot, the hub forwards it, and the destination
  // host extracts it into one or more projects on the same host. Large copies
  // should use the durable backup/restore path instead.
  createPathCopyArchive: (opts: {
    project_id: string;
    roots: PathCopyArchiveRoot[];
    options?: Pick<CopyOptions, "dereference">;
    max_archive_bytes: number;
    max_uncompressed_bytes: number;
    max_files: number;
  }) => Promise<PathCopyArchive>;
  applyPathCopyArchive: (opts: {
    archive: PathCopyArchive;
    dests: PathCopyArchiveDestination[];
    options?: CopyOptions;
  }) => Promise<{ applied: number }>;
  /////////////
  // BACKUPS
  /////////////

  // create new complete backup of the project; this first snapshots the
  // project, makes a backup of the snapshot, then deletes the snapshot, so the
  // backup is guranteed to be consistent.
  createBackup: (opts: {
    project_id: string;
    limit?: number;
    tags?: string[];
    lro?: LroRef;
    managed_egress_override?: ManagedBackupEgressOverride;
  }) => Promise<{ time: Date; id: string }>;
  // Back up the source project HOME into an externally supplied rustic
  // repository. This is used for admin site-to-site migration; rootfs state
  // must be pruned before the backup is written.
  backupProjectToExternalRepository: (opts: {
    project_id: string;
    destination_project_id: string;
    migration_id: string;
    rustic_repo_toml: string;
    backup_index_store?: ProjectBackupIndexStoreConfig | null;
    tags?: string[];
    lro?: LroRef;
    managed_egress_override?: ManagedBackupEgressOverride;
  }) => Promise<ExternalProjectBackupResult>;
  // restore the given path in the backup to the given dest.  The default
  // path is '' (the whole project) and the default destination is the
  // same as the path.
  restoreBackup: (opts: {
    project_id: string;
    id: string;
    path?: string;
    dest?: string;
    lro?: LroRef;
  }) => Promise<void>;
  // Download a signed project archive directly on the project host and extract
  // it into the project home. This keeps large legacy migrations off the hub.
  restoreProjectArchive: (opts: {
    project_id: string;
    download: SignedProjectArchiveDownload;
    max_uncompressed_bytes?: number;
    temporary_quota_grace?: boolean;
    lro?: LroRef;
  }) => Promise<ProjectArchiveRestoreResult>;
  prepareLegacyProjectArchiveRemediation: (opts: {
    project_id: string;
    download: SignedProjectArchiveDownload;
    snapshot_name?: string;
    max_uncompressed_bytes?: number;
    lro?: LroRef;
  }) => Promise<LegacyProjectArchiveRemediationResult>;
  applyLegacyProjectArchiveRemediation: (opts: {
    project_id: string;
    snapshot_name?: string;
    safety_snapshot_name?: string;
    lro?: LroRef;
  }) => Promise<LegacyProjectArchiveRemediationApplyResult>;
  // staged restore helpers (filesystem-specific implementation)
  beginRestoreStaging: (opts: {
    project_id: string;
    home?: string;
    restore?: RestoreMode;
  }) => Promise<RestoreStagingHandle | null>;
  ensureRestoreStaging: (opts: {
    handle: RestoreStagingHandle;
  }) => Promise<void>;
  finalizeRestoreStaging: (opts: {
    handle: RestoreStagingHandle;
  }) => Promise<void>;
  releaseRestoreStaging: (opts: {
    handle: RestoreStagingHandle;
    cleanupStaging?: boolean;
  }) => Promise<void>;
  cleanupRestoreStaging: (opts?: { root?: string }) => Promise<void>;
  // delete the given backup
  deleteBackup: (opts: { project_id: string; id: string }) => Promise<void>;
  // Return list of id's and timestamps of all backups of this project.
  updateBackups: (opts: {
    project_id: string;
    counts?: Partial<SnapshotCounts>;
    // global limit, same as with createBackup above; can prevent new backups from being
    // made if counts are too large!
    limit?: number;
  }) => Promise<void>;
  getBackups: (opts: { project_id: string; indexed_only?: boolean }) => Promise<
    {
      id: string;
      time: Date;
      summary: { [key: string]: string | number };
    }[]
  >;

  // Return list of files in the given backup for the given directory path
  // (non-recursive). Entries include basic metadata.
  getBackupFiles: (opts: {
    project_id: string;
    id: string;
    path?: string;
  }) => Promise<
    { name: string; isDir: boolean; mtime: number; size: number }[]
  >;
  findBackupFiles: (opts: {
    project_id: string;
    glob?: string[];
    iglob?: string[];
    path?: string;
    ids?: string[];
    preview?: boolean;
    recursive?: boolean;
  }) => Promise<BackupFindResult[] | BackupFindPreview>;
  getBackupFileText: (opts: {
    project_id: string;
    id: string;
    path: string;
    max_bytes?: number;
  }) => Promise<FileTextPreview>;

  // Admin-only project-host-side directory summary for abuse triage.
  getDirectorySummary: (opts: {
    project_id: string;
    path?: string;
    max_depth?: number;
    limit?: number;
  }) => Promise<DirectorySummary>;

  /////////////
  // SNAPSHOTS
  /////////////
  createSnapshot: (opts: {
    project_id: string;
    name?: string;
    // if given, throw error if there are already limit snapshots, i.e., this is a hard limit on
    // the total number of snapshots (to avoid abuse/bugs).
    limit?: number;
    // defaults to true
    readOnly?: boolean;
  }) => Promise<void>;
  deleteSnapshot: (opts: { project_id: string; name: string }) => Promise<void>;
  pruneSnapshotPath: (opts: {
    project_id: string;
    path: string;
    snapshots?: string[];
  }) => Promise<{ path: string; snapshots: string[] }>;
  updateSnapshots: (opts: {
    project_id: string;
    counts?: Partial<SnapshotCounts>;
    // global limit, same as with createSnapshot above; can prevent new snapshots from being
    // made if counts are too large!
    limit?: number;
  }) => Promise<void>;
  allSnapshotUsage: (opts: { project_id: string }) => Promise<SnapshotUsage[]>;
  getSnapshotFileText: (opts: {
    project_id: string;
    snapshot: string;
    path: string;
    max_bytes?: number;
  }) => Promise<FileTextPreview>;
  restoreSnapshot: (opts: {
    project_id: string;
    snapshot: string;
    mode?: SnapshotRestoreMode;
    safety_snapshot_name?: string;
    lro?: LroRef;
  }) => Promise<void>;
  publishRootfsImage: (opts: {
    project_id: string;
    snapshot?: string;
    upload?: RootfsArtifactTransferTarget;
    lro?: LroRef;
  }) => Promise<PublishProjectRootfsArtifact>;
  uploadRootfsReleaseArtifact: (opts: {
    project_id: string;
    image: string;
    upload: RootfsArtifactTransferTarget;
    lro?: LroRef;
  }) => Promise<RootfsUploadedArtifactResult>;
}

export interface SnapshotUsage {
  // name of this snapshot
  name: string;
  // amount of space used by this snapshot in bytes
  used: number;
  // amount of space that would be freed by deleting this snapshot
  exclusive: number;
  // total quota in bytes across all snapshot
  quota: number;
}

export interface Options extends Fileserver {
  client: Client;
}

function requireClient(client: Client | undefined): Client {
  if (client == null) {
    throw Error("file-server helper must provide an explicit Conat client");
  }
  return client;
}

function boundProjectIdFromSubject(subject?: string): string | undefined {
  if (subject === `${SUBJECT}.api`) {
    // Host-local trusted services historically use this unbound subject.
    return;
  }
  const parts = `${subject ?? ""}`.split(".");
  if (parts.length !== 2 || parts[0] !== SUBJECT || !isValidUUID(parts[1])) {
    throw new ConatError("invalid file-server management subject", {
      code: 403,
      subject,
    });
  }
  return parts[1];
}

function requestRoutingProjectId(
  method: string,
  args: any[],
): string | undefined {
  const opts = args[0];
  if (method === "clone") {
    return opts?.src_project_id;
  }
  if (method === "cp") {
    return opts?.src?.project_id;
  }
  if (method === "applyPathCopyArchive") {
    return opts?.dests?.[0]?.project_id;
  }
  return opts?.project_id ?? opts?.handle?.project_id;
}

function permitsUnboundProjectRequest(method: string, args: any[]): boolean {
  if (method === "cleanupRestoreStaging") {
    return true;
  }
  // The hub probes this optional method with an empty destination list before
  // constructing the real, project-bound request.
  return method === "applyPathCopyArchive" && args[0]?.dests?.length === 0;
}

function bindImplementationToRequestSubject(impl: Fileserver): Fileserver {
  const guarded: Record<string, (...args: any[]) => Promise<any>> = {};
  for (const [method, fn] of Object.entries(impl)) {
    guarded[method] = async function (this: { subject?: string }, ...args) {
      const boundProjectId = boundProjectIdFromSubject(this?.subject);
      const requestProjectId = requestRoutingProjectId(method, args);
      if (
        boundProjectId != null &&
        requestProjectId == null &&
        !permitsUnboundProjectRequest(method, args)
      ) {
        throw new ConatError("file-server request is missing routed project", {
          code: 403,
          subject: this?.subject,
        });
      }
      if (
        boundProjectId != null &&
        requestProjectId != null &&
        requestProjectId !== boundProjectId
      ) {
        throw new ConatError(
          `file-server request project does not match routed subject`,
          { code: 403, subject: this?.subject },
        );
      }
      return await fn(...args);
    };
  }
  return guarded as unknown as Fileserver;
}

export async function server({ client, ...impl }: Options) {
  client = requireClient(client);
  const sub = await client.service<Fileserver>(
    `${SUBJECT}.*`,
    bindImplementationToRequestSubject(impl as Fileserver),
  );

  return {
    close: () => {
      sub.close();
    },
  };
}

export function client({
  client,
  project_id,
  timeout,
  waitForInterest = true,
}: {
  client: Client;
  // provide project_id so that client is automatically selected to
  // be the one for the project-host that contains the project.
  project_id?: string;
  timeout?: number;
  waitForInterest?: boolean;
}): Fileserver {
  client = requireClient(client);
  // we use this subject so that requests get routed to the
  // project-host with the given project_id via
  // src/packages/server/conat/route-client.ts
  return client.call<Fileserver>(
    `${SUBJECT}.${project_id ? project_id : "api"}`,
    timeout != null || waitForInterest !== true
      ? { timeout, waitForInterest }
      : { waitForInterest },
  );
}
