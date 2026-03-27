/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access as fsAccess,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import { executeCode } from "@cocalc/backend/execute-code";
import getLogger from "@cocalc/backend/logger";
import { exists } from "@cocalc/backend/misc/async-utils-node";
import type {
  HostManagedRootfsReleaseLifecycle,
  HostRootfsGcResult,
} from "@cocalc/conat/hub/api/hosts";
import type { HostRootfsCacheEntry } from "@cocalc/conat/project-host/api";
import { hubApi } from "@cocalc/lite/hub/api";
import { isBtrfsSubvolume } from "@cocalc/file-server/btrfs/subvolume";
import { btrfs, sudo } from "@cocalc/file-server/btrfs/util";
import {
  IMAGE_CACHE,
  extractBaseImage,
  imageCachePath,
  inspectFilePath,
} from "@cocalc/project-runner/run/rootfs-base";
import {
  isManagedRootfsImageName,
  normalizeRootfsImageName,
  type RootfsReleaseArtifactAccess,
} from "@cocalc/util/rootfs-images";

import { listProjects } from "./sqlite/projects";
import { ensureRootfsRusticRepoProfile } from "./rootfs-rustic";

const logger = getLogger("project-host:rootfs-cache");
const STORAGE_WRAPPER = "/usr/local/sbin/cocalc-runtime-storage";
const ROOTFS_R2_MULTIPART_DOWNLOAD_PART_BYTES = 64 * 1024 * 1024;
const ROOTFS_R2_MULTIPART_DOWNLOAD_CONCURRENCY = 8;

type RootfsUsage = {
  project_ids: string[];
  running_project_ids: string[];
};

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
    const { stdout } = await executeCode({
      command: "du",
      args: ["-sb", path],
      timeout: 60,
    });
    const size = Number.parseInt(`${stdout}`.trim().split(/\s+/)[0], 10);
    return Number.isFinite(size) ? size : undefined;
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

async function btrfsReceiveFromFile({
  artifactPath,
  destDir,
}: {
  artifactPath: string;
  destDir: string;
}): Promise<void> {
  const child = spawn(
    "sudo",
    ["-n", STORAGE_WRAPPER, "btrfs", "receive", destDir],
    {
      stdio: ["pipe", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const pipePromise = pipeline(
    createReadStream(artifactPath),
    child.stdin as any,
  );
  const exitPromise = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `btrfs receive exited with code ${code}: ${stderr.trim() || "unknown error"}`,
        ),
      );
    });
  });
  await Promise.all([pipePromise, exitPromise]);
}

async function receivedUuid(path: string): Promise<string | undefined> {
  if (!(await exists(path)) || !(await isBtrfsSubvolume(path))) {
    return undefined;
  }
  const { stdout } = await btrfs({
    args: ["subvolume", "show", path],
    err_on_exit: true,
    verbose: false,
  });
  const match = `${stdout}`.match(/^\s*Received UUID:\s*(.+)$/m);
  const value = match?.[1]?.trim();
  return value && value !== "-" ? value : undefined;
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
}: {
  access: Extract<RootfsReleaseArtifactAccess, { artifact_format: "rustic" }>;
  destPath: string;
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
  });
}

async function findManagedRootfsReceiveTemps(image: string): Promise<string[]> {
  if (!(await exists(IMAGE_CACHE))) {
    return [];
  }
  const encoded = encodeURIComponent(image);
  const candidates: Array<{ tempDir: string; mtimeMs: number }> = [];
  for (const entry of await readdir(IMAGE_CACHE, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !entry.name.startsWith(".managed-rootfs-receive-")
    ) {
      continue;
    }
    const tempDir = join(IMAGE_CACHE, entry.name);
    const receivedPath = join(tempDir, "receive", encoded);
    if (!(await exists(receivedPath))) {
      continue;
    }
    const stats = await stat(receivedPath).catch(() => undefined);
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
  logger.warn("removing cached managed RootFS entry", {
    image,
    reason,
    cache_path: finalPath,
  });
  await deleteCachedRootfsPath(finalPath).catch(() => {});
  await rm(finalInspectPath, { force: true }).catch(() => {});
}

async function ensureIncrementalParentCacheReady(image: string): Promise<void> {
  const path = imageCachePath(image);
  if (!(await exists(path))) {
    await downloadManagedRootfsArtifact({ image });
    return;
  }
  const parentReceivedUuid = await receivedUuid(path).catch(() => undefined);
  if (parentReceivedUuid) {
    return;
  }
  await deleteCachedManagedRootfs({
    image,
    reason:
      "cached parent is missing Btrfs received UUID required for incremental receive",
  });
  await downloadManagedRootfsArtifact({ image });
}

async function downloadManagedRootfsArtifact({
  image,
}: {
  image: string;
}): Promise<void> {
  const started = Date.now();
  const access = await hubApi.hosts.getManagedRootfsReleaseArtifact({
    image,
  });
  logger.info("downloading managed RootFS artifact", {
    image,
    release_id: access.release_id,
    content_key: access.content_key,
    artifact_bytes: access.artifact_bytes,
    artifact_backend: access.artifact_backend,
    parent_image:
      access.artifact_format === "btrfs-send" ? access.parent_image : undefined,
  });
  const finalPath = imageCachePath(image);
  const finalInspectPath = inspectFilePath(image);
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
      logger.info("managed RootFS artifact already cached", {
        image,
        release_id: access.release_id,
        content_key: access.content_key,
      });
      if (access.inspect_data && !(await exists(finalInspectPath))) {
        await writeFile(finalInspectPath, JSON.stringify(access.inspect_data));
      }
      return;
    }
  }
  for (const tempDir of await findManagedRootfsReceiveTemps(image)) {
    logger.warn("removing stale managed RootFS receive temp dir", {
      image,
      release_id: access.release_id,
      content_key: access.content_key,
      temp_dir: tempDir,
    });
    await cleanupManagedRootfsTempDir(tempDir);
  }
  if (access.artifact_format === "rustic") {
    const tempDir = await mkdtemp(
      join(IMAGE_CACHE, ".managed-rootfs-rustic-restore-"),
    );
    const stagedRootfsPath = join(tempDir, "rootfs");
    try {
      await createManagedRootfsRestoreSubvolume(stagedRootfsPath);
      const restoreStarted = Date.now();
      await restoreManagedRootfsRustic({
        access,
        destPath: stagedRootfsPath,
      });
      logger.info("restored managed RootFS rustic snapshot", {
        image,
        release_id: access.release_id,
        content_key: access.content_key,
        artifact_bytes: access.artifact_bytes,
        elapsed_ms: Date.now() - restoreStarted,
      });
      try {
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
      return;
    } finally {
      await deleteCachedRootfsPath(stagedRootfsPath).catch(() => {});
      await rm(tempDir, { recursive: true, force: true, maxRetries: 3 }).catch(
        () => {},
      );
    }
  }
  if (access.parent_image?.trim()) {
    const parentImage = access.parent_image.trim();
    await ensureIncrementalParentCacheReady(parentImage);
  }

  await mkdir(IMAGE_CACHE, { recursive: true });
  const tempDir = await mkdtemp(join(IMAGE_CACHE, ".managed-rootfs-receive-"));
  const artifactPath = join(tempDir, "release.btrfs");

  try {
    const downloadStarted = Date.now();
    if (
      access.artifact_backend === "r2" &&
      access.artifact_bytes > ROOTFS_R2_MULTIPART_DOWNLOAD_PART_BYTES
    ) {
      try {
        await downloadRootfsArtifactMultipart({
          access,
          artifactPath,
        });
      } catch (err) {
        logger.warn(
          "multipart managed RootFS download failed; retrying single stream",
          {
            image,
            release_id: access.release_id,
            content_key: access.content_key,
            err: `${err}`,
          },
        );
        await rm(artifactPath, { force: true }).catch(() => {});
        await downloadRootfsArtifactSingle({
          access,
          artifactPath,
        });
      }
    } else {
      await downloadRootfsArtifactSingle({
        access,
        artifactPath,
      });
    }
    const artifactStats = await stat(artifactPath);
    logger.info("downloaded managed RootFS artifact", {
      image,
      release_id: access.release_id,
      content_key: access.content_key,
      bytes: artifactStats.size,
      elapsed_ms: Date.now() - downloadStarted,
    });
    const receiveStarted = Date.now();
    try {
      await btrfsReceiveFromFile({
        artifactPath,
        destDir: IMAGE_CACHE,
      });
      logger.info("received managed RootFS artifact", {
        image,
        release_id: access.release_id,
        content_key: access.content_key,
        elapsed_ms: Date.now() - receiveStarted,
      });
      if (!(await exists(finalPath))) {
        throw new Error(`received RootFS image '${image}' was not created`);
      }
      if (access.inspect_data) {
        await writeFile(finalInspectPath, JSON.stringify(access.inspect_data));
      }
      logger.info("cached managed RootFS artifact", {
        image,
        release_id: access.release_id,
        content_key: access.content_key,
        total_elapsed_ms: Date.now() - started,
      });
    } catch (err) {
      if (await exists(finalPath)) {
        await deleteCachedManagedRootfs({
          image,
          reason: `failed while receiving managed artifact: ${err}`,
        });
      }
      throw err;
    }
  } finally {
    await cleanupManagedRootfsTempDir(tempDir);
  }
}

async function downloadRootfsArtifactSingle({
  access,
  artifactPath,
}: {
  access: Extract<
    RootfsReleaseArtifactAccess,
    { artifact_format: "btrfs-send" }
  >;
  artifactPath: string;
}): Promise<void> {
  const response = await fetch(access.download_url, {
    headers: access.download_headers,
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  if (!response.ok || !response.body) {
    throw new Error(
      `artifact download failed (${response.status} ${response.statusText})`,
    );
  }
  await pipeline(response.body as any, createWriteStream(artifactPath));
}

async function downloadRootfsArtifactMultipart({
  access,
  artifactPath,
}: {
  access: Extract<
    RootfsReleaseArtifactAccess,
    { artifact_format: "btrfs-send" }
  >;
  artifactPath: string;
}): Promise<void> {
  const partBytes = ROOTFS_R2_MULTIPART_DOWNLOAD_PART_BYTES;
  const totalParts = Math.max(1, Math.ceil(access.artifact_bytes / partBytes));
  const workerCount = Math.min(
    ROOTFS_R2_MULTIPART_DOWNLOAD_CONCURRENCY,
    totalParts,
  );
  const file = await open(artifactPath, "w");
  try {
    await file.truncate(access.artifact_bytes);
  } finally {
    await file.close();
  }
  let nextPart = 0;
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const current = nextPart;
        nextPart += 1;
        if (current >= totalParts) return;
        const start = current * partBytes;
        const end = Math.min(access.artifact_bytes, start + partBytes) - 1;
        const response = await fetch(access.download_url, {
          headers: {
            ...(access.download_headers ?? {}),
            Range: `bytes=${start}-${end}`,
          },
          signal: AbortSignal.timeout(15 * 60 * 1000),
        });
        if (
          !(
            response.status === 206 ||
            (response.status === 200 && totalParts === 1)
          ) ||
          !response.body
        ) {
          throw new Error(
            `artifact ranged download failed (${response.status} ${response.statusText}) for bytes=${start}-${end}`,
          );
        }
        await pipeline(
          response.body as any,
          createWriteStream(artifactPath, {
            flags: "r+",
            start,
          }),
        );
      }
    }),
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
): Promise<HostRootfsCacheEntry> {
  const trimmed = normalizeRootfsImageName(image);
  if (!trimmed) {
    throw new Error("image must be specified");
  }
  if (isManagedRootfsImageName(trimmed)) {
    await downloadManagedRootfsArtifact({ image: trimmed });
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
  let removed = false;
  if (await exists(cache_path)) {
    await deleteCachedRootfsPath(cache_path);
    removed = true;
  }
  if (await exists(inspect_path)) {
    await rm(inspect_path, { force: true, maxRetries: 3 });
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
