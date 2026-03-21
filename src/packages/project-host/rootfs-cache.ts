/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { readdir, readFile, rm, stat } from "fs/promises";

import { executeCode } from "@cocalc/backend/execute-code";
import getLogger from "@cocalc/backend/logger";
import { exists } from "@cocalc/backend/misc/async-utils-node";
import type { HostRootfsCacheEntry } from "@cocalc/conat/project-host/api";
import {
  IMAGE_CACHE,
  extractBaseImage,
  imageCachePath,
  inspectFilePath,
} from "@cocalc/project-runner/run/rootfs-base";

import { listProjects } from "./sqlite/projects";

const logger = getLogger("project-host:rootfs-cache");

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
    const image = `${row.image ?? ""}`.trim();
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
        usage.get(image) ?? { project_ids: [], running_project_ids: [] },
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
  const trimmed = image.trim();
  if (!trimmed) {
    throw new Error("image must be specified");
  }
  await extractBaseImage(trimmed);
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
  const trimmed = image.trim();
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
    await rm(cache_path, { recursive: true, force: true, maxRetries: 3 });
    removed = true;
  }
  if (await exists(inspect_path)) {
    await rm(inspect_path, { force: true, maxRetries: 3 });
    removed = true;
  }
  return { removed };
}
