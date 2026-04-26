/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  access as fsAccess,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "fs/promises";
import { join } from "node:path";

import { executeCode } from "@cocalc/backend/execute-code";
import getLogger from "@cocalc/backend/logger";
import { exists } from "@cocalc/backend/misc/async-utils-node";
import type {
  HostManagedRootfsReleaseLifecycle,
  HostRootfsGcResult,
} from "@cocalc/conat/hub/api/hosts";
import type { HostRootfsCacheEntry } from "@cocalc/conat/project-host/api";
import { hubApi } from "@cocalc/lite/hub/api";
import {
  createRusticProgressHandler,
  type RusticProgressUpdate,
} from "@cocalc/file-server/btrfs/rustic-progress";
import { isBtrfsSubvolume } from "@cocalc/file-server/btrfs/subvolume";
import { btrfs, sudo } from "@cocalc/file-server/btrfs/util";
import {
  IMAGE_CACHE,
  extractBaseImage,
  imageCachePath,
  inspectFilePath,
  preflightMetadataFilePath,
} from "@cocalc/project-runner/run/rootfs-base";
import {
  loadRootfsPreflightMetadata,
  preflightRootfsInPlace,
  ROOTFS_NORMALIZER_VERSION,
  requireCurrentRootfsPreflightMetadata,
  writeRootfsPreflightMetadata,
} from "@cocalc/project-runner/run/rootfs-normalize";
import {
  isManagedRootfsImageName,
  normalizeRootfsImageName,
  type RootfsArtifactTransferTarget,
  type RootfsReleaseArtifactAccess,
  type RootfsUploadedArtifactResult,
} from "@cocalc/util/rootfs-images";
import type { ExecuteCodeStreamEvent } from "@cocalc/util/types/execute-code";

import { listProjects } from "./sqlite/projects";
import { ensureRootfsRusticRepoProfile } from "./rootfs-rustic";
import {
  estimateManagedRootfsPullReservationBytes,
  withStorageReservation,
} from "./storage-reservations";
import {
  inspectLabelsSatisfyCurrentProjectRuntimeContract,
  readCurrentProjectRuntimeUsernsMapFingerprint,
  rootfsInspectLabels,
} from "./rootfs-runtime-contract";

const logger = getLogger("project-host:rootfs-cache");
const STORAGE_WRAPPER = "/usr/local/sbin/cocalc-runtime-storage";

type RootfsUsage = {
  project_ids: string[];
  running_project_ids: string[];
};

export type RootfsCachePullProgress = {
  message: string;
  progress?: number;
  detail?: any;
};

type PullRootfsCacheOptions = {
  onProgress?: (update: RootfsCachePullProgress) => void;
  awaitRegionalReplication?: boolean;
};

const managedRootfsReplicationInFlight = new Map<string, Promise<void>>();

function reportPullProgress(
  onProgress: ((update: RootfsCachePullProgress) => void) | undefined,
  update: RootfsCachePullProgress,
): void {
  onProgress?.(update);
}

function createRusticStreamHooks({
  onProgress,
  mapUpdate,
}: {
  onProgress?: (update: RootfsCachePullProgress) => void;
  mapUpdate: (update: RusticProgressUpdate) => RootfsCachePullProgress;
}): {
  env?: Record<string, string>;
  streamCB?: (event: ExecuteCodeStreamEvent) => void;
} {
  if (!onProgress) {
    return {};
  }
  const progressHandler = createRusticProgressHandler({
    onProgress: (update) => onProgress(mapUpdate(update)),
  });
  let stderrBuffer = "";
  return {
    env: { RUSTIC_PROGRESS_INTERVAL: "1s" },
    streamCB: (event) => {
      if (event.type === "stderr" && typeof event.data === "string") {
        stderrBuffer += event.data.replace(/\r/g, "\n");
        const parts = stderrBuffer.split("\n");
        stderrBuffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (line) {
            progressHandler(line);
          }
        }
        return;
      }
      if (event.type === "done") {
        const line = stderrBuffer.trim();
        stderrBuffer = "";
        if (line) {
          progressHandler(line);
        }
      }
    },
  };
}

function decodeInspectFileImage(name: string): string | undefined {
  if (!name.startsWith(".") || !name.endsWith(".json")) {
    return undefined;
  }
  try {
    return decodeURIComponent(name.slice(1, -".json".length));
  } catch (err) {
    logger.debug("unable to decode cached rootfs inspect name", {
      name,
      err: `${err}`,
    });
    return undefined;
  }
}

function rootfsUsageByImage(): Map<string, RootfsUsage> {
  const usage = new Map<string, RootfsUsage>();
  for (const row of listProjects()) {
    const image = normalizeRootfsImageName(row.image);
    if (!image) continue;
    const current = usage.get(image) ?? {
      project_ids: [],
      running_project_ids: [],
    };
    current.project_ids.push(row.project_id);
    if (row.state === "running") {
      current.running_project_ids.push(row.project_id);
    }
    usage.set(image, current);
  }
  return usage;
}

async function directorySizeBytes(path: string): Promise<number | undefined> {
  try {
    const result = await sudo({
      verbose: false,
      err_on_exit: false,
      timeout: 60,
      command: "du-bytes",
      args: [path],
    });
    const size = Number.parseInt(`${result.stdout}`.trim().split(/\s+/)[0], 10);
    if (!Number.isFinite(size)) {
      throw new Error(`du-bytes returned an invalid size for ${path}`);
    }
    if (result.exit_code !== 0) {
      logger.debug("du-bytes exited nonzero but returned a usable size", {
        path,
        exit_code: result.exit_code,
        stderr: result.stderr,
      });
    }
    return size;
  } catch (err) {
    logger.debug("unable to compute cached rootfs size", {
      path,
      err: `${err}`,
    });
    return undefined;
  }
}

async function readDigest(image: string): Promise<string | undefined> {
  const path = inspectFilePath(image);
  if (!(await exists(path))) return undefined;
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    return (
      raw?.Digest ??
      raw?.digest ??
      (Array.isArray(raw?.RepoDigests) ? raw.RepoDigests[0] : undefined)
    );
  } catch (err) {
    logger.debug("unable to read cached rootfs inspect data", {
      image,
      err: `${err}`,
    });
    return undefined;
  }
}

async function statTimestamp(path: string): Promise<string | undefined> {
  try {
    return (await stat(path)).mtime.toISOString();
  } catch {
    return undefined;
  }
}

async function buildEntry(
  image: string,
  usage: RootfsUsage,
): Promise<HostRootfsCacheEntry | undefined> {
  const cache_path = imageCachePath(image);
  if (!(await exists(cache_path))) return undefined;
  const inspect_path = inspectFilePath(image);
  return {
    image,
    cache_path,
    inspect_path: (await exists(inspect_path)) ? inspect_path : undefined,
    digest: await readDigest(image),
    size_bytes: await directorySizeBytes(cache_path),
    cached_at:
      (await statTimestamp(inspect_path)) ?? (await statTimestamp(cache_path)),
    project_count: usage.project_ids.length,
    running_project_count: usage.running_project_ids.length,
    project_ids: usage.project_ids,
    running_project_ids: usage.running_project_ids,
  };
}

function rootfsUsageCounts(usage?: RootfsUsage): {
  project_count: number;
  running: number;
} {
  return {
    project_count: usage?.project_ids.length ?? 0,
    running: usage?.running_project_ids.length ?? 0,
  };
}

async function looksLikeUsableManagedRootfs(path: string): Promise<boolean> {
  for (const candidate of ["usr", "etc", "bin", "lib", "lib64"]) {
    try {
      await fsAccess(join(path, candidate));
      return true;
    } catch {
      // try next marker
    }
  }
  return false;
}

async function cleanupManagedRootfsTempDir(tempDir: string): Promise<void> {
  const receiveRoot = join(tempDir, "receive");
  if (await exists(receiveRoot)) {
    for (const entry of await readdir(receiveRoot, { withFileTypes: true })) {
      await deleteCachedRootfsPath(join(receiveRoot, entry.name)).catch(
        (err) => {
          logger.warn("unable to delete managed RootFS receive entry", {
            temp_dir: tempDir,
            entry: entry.name,
            err: `${err}`,
          });
        },
      );
    }
  }
  await rm(tempDir, { recursive: true, force: true, maxRetries: 3 }).catch(
    (err) => {
      logger.warn("unable to remove managed RootFS temp dir", {
        temp_dir: tempDir,
        err: `${err}`,
      });
    },
  );
}

async function chownManagedRootfsPath(path: string): Promise<void> {
  await sudo({
    command: "chown",
    args: [`${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`, path],
    verbose: false,
  });
}

async function createManagedRootfsRestoreSubvolume(
  path: string,
): Promise<void> {
  await btrfs({
    args: ["subvolume", "create", path],
    err_on_exit: true,
    verbose: false,
  });
  await chownManagedRootfsPath(path);
}

async function snapshotManagedRootfsReadonly({
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

async function restoreManagedRootfsRustic({
  access,
  destPath,
  onProgress,
}: {
  access: Extract<RootfsReleaseArtifactAccess, { artifact_format: "rustic" }>;
  destPath: string;
  onProgress?: (update: RootfsCachePullProgress) => void;
}): Promise<void> {
  const repoProfile = await ensureRootfsRusticRepoProfile({
    repo_selector: access.repo_selector,
    repo_toml: access.repo_toml,
  });
  const profileArg = repoProfile.endsWith(".toml")
    ? repoProfile.slice(0, -5)
    : repoProfile;
  await executeCode({
    verbose: false,
    err_on_exit: true,
    timeout: 30 * 60 * 1000,
    command: "sudo",
    args: [
      "-n",
      STORAGE_WRAPPER,
      "rootfs-rustic-restore",
      profileArg,
      access.snapshot_id,
      destPath,
      "--delete",
    ],
    ...createRusticStreamHooks({
      onProgress,
      mapUpdate: (update) => ({
        message: update.message,
        progress:
          update.progress == null
            ? undefined
            : 12 + (update.progress * 70) / 100,
        detail: update.detail,
      }),
    }),
  });
}

async function backupManagedRootfsToRustic({
  sourcePath,
  image,
  upload,
  onProgress,
}: {
  sourcePath: string;
  image: string;
  upload: Extract<RootfsArtifactTransferTarget, { backend: "rustic" }>;
  onProgress?: (update: RootfsCachePullProgress) => void;
}): Promise<Extract<RootfsUploadedArtifactResult, { backend: "rustic" }>> {
  const repoProfile = await ensureRootfsRusticRepoProfile({
    repo_selector: upload.repo_selector,
    repo_toml: upload.repo_toml,
  });
  const profileArg = repoProfile.endsWith(".toml")
    ? repoProfile.slice(0, -5)
    : repoProfile;
  const { stdout } = await executeCode({
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
      image,
      "--tag",
      "rootfs-release",
      "--tag",
      "rootfs-replica",
    ],
    ...createRusticStreamHooks({
      onProgress,
      mapUpdate: (update) => ({
        message: update.message,
        progress:
          update.progress == null
            ? undefined
            : 90 + (update.progress * 8) / 100,
        detail: update.detail,
      }),
    }),
  });
  const parsed = JSON.parse(`${stdout ?? "{}"}`);
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
    region: upload.region,
    bucket_id: upload.bucket_id,
    bucket_name: upload.bucket_name,
    bucket_purpose: upload.bucket_purpose,
  };
}

async function maybeReplicateManagedRootfsRustic({
  access,
  sourcePath,
  onProgress,
}: {
  access: Extract<RootfsReleaseArtifactAccess, { artifact_format: "rustic" }>;
  sourcePath: string;
  onProgress?: (update: RootfsCachePullProgress) => void;
}): Promise<void> {
  const target = access.regional_replication_target;
  if (!target) {
    return;
  }
  reportPullProgress(onProgress, {
    message: `replicating RootFS to ${target.region}`,
    progress: 90,
    detail: {
      source_region: access.region,
      target_region: target.region,
    },
  });
  logger.info("replicating managed RootFS rustic snapshot to local region", {
    image: access.image,
    release_id: access.release_id,
    content_key: access.content_key,
    source_region: access.region,
    target_region: target.region,
  });
  try {
    const upload = await backupManagedRootfsToRustic({
      sourcePath,
      image: access.image,
      upload: target,
      onProgress,
    });
    await hubApi.hosts.recordManagedRootfsReleaseReplica({
      image: access.image,
      upload,
    });
    logger.info("replicated managed RootFS rustic snapshot to local region", {
      image: access.image,
      release_id: access.release_id,
      content_key: access.content_key,
      source_region: access.region,
      target_region: target.region,
      snapshot_id: upload.snapshot_id,
    });
  } catch (err) {
    logger.warn("failed replicating managed RootFS rustic snapshot", {
      image: access.image,
      release_id: access.release_id,
      content_key: access.content_key,
      source_region: access.region,
      target_region: target.region,
      err: `${err}`,
    });
  }
}

function replicationKey(
  access: Extract<RootfsReleaseArtifactAccess, { artifact_format: "rustic" }>,
): string | undefined {
  const target = access.regional_replication_target;
  if (!target) return undefined;
  return `${access.content_key}:${target.region}`;
}

function scheduleManagedRootfsReplication({
  access,
  sourcePath,
}: {
  access: Extract<RootfsReleaseArtifactAccess, { artifact_format: "rustic" }>;
  sourcePath: string;
}): void {
  const key = replicationKey(access);
  if (!key) return;
  if (managedRootfsReplicationInFlight.has(key)) {
    logger.debug("managed RootFS regional replication already in flight", {
      image: access.image,
      release_id: access.release_id,
      content_key: access.content_key,
      target_region: access.regional_replication_target?.region,
    });
    return;
  }
  const task = (async () => {
    await maybeReplicateManagedRootfsRustic({
      access,
      sourcePath,
    });
  })().finally(() => {
    managedRootfsReplicationInFlight.delete(key);
  });
  managedRootfsReplicationInFlight.set(key, task);
}

async function findManagedRootfsRestoreTemps(): Promise<string[]> {
  if (!(await exists(IMAGE_CACHE))) {
    return [];
  }
  const candidates: Array<{ tempDir: string; mtimeMs: number }> = [];
  for (const entry of await readdir(IMAGE_CACHE, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !entry.name.startsWith(".managed-rootfs-rustic-restore-")
    ) {
      continue;
    }
    const tempDir = join(IMAGE_CACHE, entry.name);
    const restorePath = join(tempDir, "rootfs");
    if (!(await exists(restorePath))) {
      continue;
    }
    const stats = await stat(restorePath).catch(() => undefined);
    candidates.push({
      tempDir,
      mtimeMs: stats?.mtimeMs ?? 0,
    });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates.map(({ tempDir }) => tempDir);
}

async function deleteCachedManagedRootfs({
  image,
  reason,
}: {
  image: string;
  reason: string;
}): Promise<void> {
  const finalPath = imageCachePath(image);
  const finalInspectPath = inspectFilePath(image);
  const finalPreflightPath = preflightMetadataFilePath(image);
  logger.warn("removing cached managed RootFS entry", {
    image,
    reason,
    cache_path: finalPath,
  });
  await deleteCachedRootfsPath(finalPath).catch(() => {});
  await rm(finalInspectPath, { force: true }).catch(() => {});
  await rm(finalPreflightPath, { force: true }).catch(() => {});
}

async function downloadManagedRootfsArtifact({
  image,
  onProgress,
  awaitRegionalReplication = true,
}: {
  image: string;
  onProgress?: (update: RootfsCachePullProgress) => void;
  awaitRegionalReplication?: boolean;
}): Promise<void> {
  const started = Date.now();
  reportPullProgress(onProgress, {
    message: "resolving RootFS release",
    progress: 2,
  });
  const access = await hubApi.hosts.getManagedRootfsReleaseArtifact({
    image,
  });
  logger.info("downloading managed RootFS artifact", {
    image,
    release_id: access.release_id,
    content_key: access.content_key,
    artifact_bytes: access.artifact_bytes,
    artifact_backend: access.artifact_backend,
  });
  const finalPath = imageCachePath(image);
  const finalInspectPath = inspectFilePath(image);
  const finalPreflightPath = preflightMetadataFilePath(image);
  const usage = rootfsUsageByImage().get(image);
  if (await exists(finalPath)) {
    const usable = await looksLikeUsableManagedRootfs(finalPath).catch(
      () => false,
    );
    if (!usable) {
      await deleteCachedManagedRootfs({
        image,
        reason: "cached image is missing expected rootfs directories",
      });
    } else {
      const preflight = await loadRootfsPreflightMetadata(finalPreflightPath);
      if (
        preflight == null ||
        preflight.version !== ROOTFS_NORMALIZER_VERSION
      ) {
        const counts = rootfsUsageCounts(usage);
        if (counts.project_count > 0 || counts.running > 0) {
          throw new Error(
            `cached managed RootFS '${image}' does not satisfy RootFS preflight v${ROOTFS_NORMALIZER_VERSION} and is currently in use by ${counts.project_count} project(s); reprovision the host or flush the RootFS cache before using this image`,
          );
        }
        await deleteCachedManagedRootfs({
          image,
          reason:
            "cached image is missing or outdated RootFS preflight metadata; refreshing cache entry",
        });
      } else {
        requireCurrentRootfsPreflightMetadata({
          image,
          metadataPath: finalPreflightPath,
          metadata: preflight,
        });
      }
    }
  }
  if (await exists(finalPath)) {
    reportPullProgress(onProgress, {
      message: "RootFS already cached on this host",
      progress: access.regional_replication_target ? 88 : 100,
      detail: {
        image,
        release_id: access.release_id,
      },
    });
    logger.info("managed RootFS artifact already cached", {
      image,
      release_id: access.release_id,
      content_key: access.content_key,
    });
    if (access.inspect_data && !(await exists(finalInspectPath))) {
      await writeFile(finalInspectPath, JSON.stringify(access.inspect_data));
    }
    if (awaitRegionalReplication) {
      await maybeReplicateManagedRootfsRustic({
        access,
        sourcePath: finalPath,
        onProgress,
      });
    } else {
      scheduleManagedRootfsReplication({
        access,
        sourcePath: finalPath,
      });
    }
    reportPullProgress(onProgress, {
      message: "RootFS ready on host",
      progress: 100,
      detail: {
        image,
        release_id: access.release_id,
      },
    });
    return;
  }
  for (const tempDir of await findManagedRootfsRestoreTemps()) {
    logger.warn("removing stale managed RootFS restore temp dir", {
      image,
      release_id: access.release_id,
      content_key: access.content_key,
      temp_dir: tempDir,
    });
    await cleanupManagedRootfsTempDir(tempDir);
  }
  const estimated_bytes = estimateManagedRootfsPullReservationBytes(access);
  reportPullProgress(onProgress, {
    message: "reserving host storage for RootFS pull",
    progress: 4,
    detail: {
      image,
      release_id: access.release_id,
      estimated_bytes,
    },
  });
  await withStorageReservation(
    {
      kind: "rootfs-pull",
      resource_id: image,
      estimated_bytes,
    },
    async () => {
      await mkdir(IMAGE_CACHE, { recursive: true });
      const tempDir = await mkdtemp(
        join(IMAGE_CACHE, ".managed-rootfs-rustic-restore-"),
      );
      const stagedRootfsPath = join(tempDir, "rootfs");
      try {
        reportPullProgress(onProgress, {
          message: "preparing RootFS cache",
          progress: 8,
          detail: {
            image,
            release_id: access.release_id,
          },
        });
        await createManagedRootfsRestoreSubvolume(stagedRootfsPath);
        const restoreStarted = Date.now();
        reportPullProgress(onProgress, {
          message: "restoring RootFS image from rustic",
          progress: 12,
          detail: {
            image,
            release_id: access.release_id,
          },
        });
        await restoreManagedRootfsRustic({
          access,
          destPath: stagedRootfsPath,
          onProgress,
        });
        logger.info("restored managed RootFS rustic snapshot", {
          image,
          release_id: access.release_id,
          content_key: access.content_key,
          artifact_bytes: access.artifact_bytes,
          size_bytes: access.size_bytes,
          elapsed_ms: Date.now() - restoreStarted,
        });
        reportPullProgress(onProgress, {
          message: "checking RootFS preflight prerequisites",
          progress: 84,
          detail: {
            image,
            release_id: access.release_id,
          },
        });
        let skipOwnershipBridge = false;
        const inspectLabels = rootfsInspectLabels(access.inspect_data);
        if (inspectLabels) {
          try {
            const usernsMapFingerprint =
              await readCurrentProjectRuntimeUsernsMapFingerprint();
            skipOwnershipBridge =
              inspectLabelsSatisfyCurrentProjectRuntimeContract({
                labels: inspectLabels,
                usernsMapFingerprint,
              });
          } catch (err) {
            logger.warn(
              "unable to evaluate RootFS runtime-contract fast path",
              {
                image,
                release_id: access.release_id,
                err: `${err}`,
              },
            );
          }
        }
        if (skipOwnershipBridge) {
          reportPullProgress(onProgress, {
            message: "reusing matching RootFS ownership mapping",
            progress: 86,
            detail: {
              image,
              release_id: access.release_id,
              fast_path: "matching-runtime-contract",
            },
          });
        }
        const preflight = await preflightRootfsInPlace({
          image,
          rootfsPath: stagedRootfsPath,
          skipOwnershipBridge,
          onProgress: ({ message, detail }) => {
            reportPullProgress(onProgress, {
              message,
              progress: 88,
              detail,
            });
          },
        });
        try {
          reportPullProgress(onProgress, {
            message: "finalizing RootFS cache entry",
            progress: 90,
            detail: {
              image,
              release_id: access.release_id,
            },
          });
          await snapshotManagedRootfsReadonly({
            source: stagedRootfsPath,
            dest: finalPath,
          });
          if (access.inspect_data) {
            await writeFile(
              finalInspectPath,
              JSON.stringify(access.inspect_data),
            );
          }
          await writeRootfsPreflightMetadata({
            metadataPath: finalPreflightPath,
            metadata: {
              ...preflight,
              rootfs_path: finalPath,
            },
          });
        } catch (err) {
          if (await exists(finalPath)) {
            await deleteCachedManagedRootfs({
              image,
              reason: `failed while finalizing restored rustic snapshot: ${err}`,
            });
          }
          throw err;
        }
        logger.info("cached managed RootFS from rustic snapshot", {
          image,
          release_id: access.release_id,
          content_key: access.content_key,
          total_elapsed_ms: Date.now() - started,
        });
        if (awaitRegionalReplication) {
          await maybeReplicateManagedRootfsRustic({
            access,
            sourcePath: finalPath,
            onProgress,
          });
        } else {
          scheduleManagedRootfsReplication({
            access,
            sourcePath: finalPath,
          });
        }
        reportPullProgress(onProgress, {
          message: "RootFS ready on host",
          progress: 100,
          detail: {
            image,
            release_id: access.release_id,
          },
        });
      } finally {
        await deleteCachedRootfsPath(stagedRootfsPath).catch(() => {});
        await rm(tempDir, {
          recursive: true,
          force: true,
          maxRetries: 3,
        }).catch(() => {});
      }
    },
  );
}

async function deleteCachedRootfsPath(path: string): Promise<void> {
  if (!(await exists(path))) {
    return;
  }
  if (await isBtrfsSubvolume(path)) {
    await btrfs({
      args: ["subvolume", "delete", path],
      err_on_exit: true,
      verbose: false,
    });
    return;
  }
  await rm(path, { recursive: true, force: true, maxRetries: 3 });
}

export async function listRootfsCacheEntries(): Promise<
  HostRootfsCacheEntry[]
> {
  const images = new Set<string>();
  if (await exists(IMAGE_CACHE)) {
    for (const entry of await readdir(IMAGE_CACHE, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        try {
          images.add(decodeURIComponent(entry.name));
        } catch (err) {
          logger.debug("unable to decode cached rootfs directory name", {
            name: entry.name,
            err: `${err}`,
          });
        }
        continue;
      }
      if (entry.isFile()) {
        const image = decodeInspectFileImage(entry.name);
        if (image) {
          images.add(image);
        }
      }
    }
  }

  const usage = rootfsUsageByImage();
  const rows = await Promise.all(
    Array.from(images).map((image) =>
      buildEntry(
        image,
        usage.get(normalizeRootfsImageName(image)) ?? {
          project_ids: [],
          running_project_ids: [],
        },
      ),
    ),
  );

  return rows
    .filter((row): row is HostRootfsCacheEntry => !!row)
    .sort((a, b) => {
      if (a.running_project_count !== b.running_project_count) {
        return b.running_project_count - a.running_project_count;
      }
      if (a.project_count !== b.project_count) {
        return b.project_count - a.project_count;
      }
      const aTime = a.cached_at ? Date.parse(a.cached_at) : 0;
      const bTime = b.cached_at ? Date.parse(b.cached_at) : 0;
      if (aTime !== bTime) {
        return bTime - aTime;
      }
      return a.image.localeCompare(b.image);
    });
}

export async function pullRootfsCacheEntry(
  image: string,
  opts: PullRootfsCacheOptions = {},
): Promise<HostRootfsCacheEntry> {
  const trimmed = normalizeRootfsImageName(image);
  if (!trimmed) {
    throw new Error("image must be specified");
  }
  if (isManagedRootfsImageName(trimmed)) {
    await downloadManagedRootfsArtifact({
      image: trimmed,
      onProgress: opts.onProgress,
      awaitRegionalReplication: opts.awaitRegionalReplication ?? true,
    });
  } else {
    await extractBaseImage(trimmed);
  }
  const usage = rootfsUsageByImage().get(trimmed) ?? {
    project_ids: [],
    running_project_ids: [],
  };
  const row = await buildEntry(trimmed, usage);
  if (!row) {
    throw new Error(`failed to cache rootfs image '${trimmed}'`);
  }
  return row;
}

export async function deleteRootfsCacheEntry(image: string): Promise<{
  removed: boolean;
}> {
  const trimmed = normalizeRootfsImageName(image);
  if (!trimmed) {
    throw new Error("image must be specified");
  }
  const usage = rootfsUsageByImage().get(trimmed);
  if ((usage?.running_project_ids.length ?? 0) > 0) {
    throw new Error(
      `cannot delete cached image while ${usage!.running_project_ids.length} running project(s) are using it`,
    );
  }
  const cache_path = imageCachePath(trimmed);
  const inspect_path = inspectFilePath(trimmed);
  const preflight_path = preflightMetadataFilePath(trimmed);
  let removed = false;
  if (await exists(cache_path)) {
    await deleteCachedRootfsPath(cache_path);
    removed = true;
  }
  if (await exists(inspect_path)) {
    await rm(inspect_path, { force: true, maxRetries: 3 });
    removed = true;
  }
  if (await exists(preflight_path)) {
    await rm(preflight_path, { force: true, maxRetries: 3 });
    removed = true;
  }
  return { removed };
}

export async function gcDeletedManagedRootfsCacheEntries(): Promise<HostRootfsGcResult> {
  const entries = await listRootfsCacheEntries();
  const candidates = entries.filter(
    (entry) =>
      isManagedRootfsImageName(entry.image) &&
      (entry.project_count ?? 0) === 0 &&
      (entry.running_project_count ?? 0) === 0,
  );
  if (candidates.length === 0) {
    return {
      scanned: 0,
      removed: 0,
      skipped: 0,
      failed: 0,
      items: [],
    };
  }
  const lifecycleRows = await hubApi.hosts.listManagedRootfsReleaseLifecycle?.({
    images: candidates.map((entry) => entry.image),
  });
  const lifecycleByImage = new Map<string, HostManagedRootfsReleaseLifecycle>(
    (lifecycleRows ?? []).map((row) => [row.image, row]),
  );
  const result: HostRootfsGcResult = {
    scanned: candidates.length,
    removed: 0,
    skipped: 0,
    failed: 0,
    items: [],
  };
  for (const entry of candidates) {
    const lifecycle = lifecycleByImage.get(entry.image);
    if (lifecycle?.gc_status !== "deleted") {
      result.skipped += 1;
      result.items.push({
        image: entry.image,
        status: "skipped",
        reason: lifecycle?.gc_status
          ? `central release is ${lifecycle.gc_status}`
          : "central release is not deleted",
      });
      continue;
    }
    try {
      const deletion = await deleteRootfsCacheEntry(entry.image);
      if (deletion.removed) {
        result.removed += 1;
        result.items.push({
          image: entry.image,
          status: "removed",
        });
      } else {
        result.skipped += 1;
        result.items.push({
          image: entry.image,
          status: "skipped",
          reason: "cache entry already absent",
        });
      }
    } catch (err) {
      result.failed += 1;
      result.items.push({
        image: entry.image,
        status: "failed",
        reason: `${err}`,
      });
    }
  }
  return result;
}
