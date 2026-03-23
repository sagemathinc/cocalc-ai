/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import { executeCode } from "@cocalc/backend/execute-code";
import getLogger from "@cocalc/backend/logger";
import { exists } from "@cocalc/backend/misc/async-utils-node";
import type { HostRootfsCacheEntry } from "@cocalc/conat/project-host/api";
import { hubApi } from "@cocalc/lite/hub/api";
import { isBtrfsSubvolume } from "@cocalc/file-server/btrfs/subvolume";
import { btrfs } from "@cocalc/file-server/btrfs/util";
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
    parent_image: access.parent_image,
  });
  const finalPath = imageCachePath(image);
  const finalInspectPath = inspectFilePath(image);
  if (await exists(finalPath)) {
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
  if (access.parent_image?.trim()) {
    const parentImage = access.parent_image.trim();
    if (!(await exists(imageCachePath(parentImage)))) {
      await downloadManagedRootfsArtifact({ image: parentImage });
    }
  }

  await mkdir(IMAGE_CACHE, { recursive: true });
  const tempDir = await mkdtemp(join(IMAGE_CACHE, ".managed-rootfs-receive-"));
  const artifactPath = join(tempDir, "release.btrfs");
  const receiveRoot = join(tempDir, "receive");
  await mkdir(receiveRoot, { recursive: true });

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
    await btrfsReceiveFromFile({
      artifactPath,
      destDir: receiveRoot,
    });
    logger.info("received managed RootFS artifact", {
      image,
      release_id: access.release_id,
      content_key: access.content_key,
      elapsed_ms: Date.now() - receiveStarted,
    });

    const receivedPath = join(receiveRoot, encodeURIComponent(image));
    if (!(await exists(receivedPath))) {
      throw new Error(`received RootFS image '${image}' was not created`);
    }
    const snapshotStarted = Date.now();
    await rename(receivedPath, finalPath);
    if (access.inspect_data) {
      await writeFile(finalInspectPath, JSON.stringify(access.inspect_data));
    }
    logger.info("cached managed RootFS artifact", {
      image,
      release_id: access.release_id,
      content_key: access.content_key,
      snapshot_elapsed_ms: Date.now() - snapshotStarted,
      total_elapsed_ms: Date.now() - started,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 }).catch(
      () => {},
    );
  }
}

async function downloadRootfsArtifactSingle({
  access,
  artifactPath,
}: {
  access: RootfsReleaseArtifactAccess;
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
  access: RootfsReleaseArtifactAccess;
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
