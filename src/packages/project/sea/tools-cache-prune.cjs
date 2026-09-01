#!/usr/bin/env node

/*
 * Bound the immutable project-tools build cache without touching unrelated
 * files. Cache directory mtime is updated on restore and serves as the LRU
 * timestamp.
 */

const { lstat, readdir, rm } = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_RETENTION_COUNT = 2;
const DEFAULT_MAX_BYTES = 3 * 1024 * 1024 * 1024;
const DEFAULT_MIN_AGE_MS = 60 * 60 * 1000;
const CACHE_NAME_PATTERN = /^(tools(?:-minimal)?-.+)-([a-f0-9]{64})$/;

function parseNonnegativeInteger(value, fallback, name) {
  if (value == null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a nonnegative integer`);
  }
  return parsed;
}

async function directorySize(directory) {
  let bytes = 0;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      bytes += await directorySize(entryPath);
    } else {
      // Do not follow symlinks out of the cache directory.
      bytes += (await lstat(entryPath)).size;
    }
  }
  return bytes;
}

async function readCacheEntries(cacheRoot) {
  let children;
  try {
    children = await readdir(cacheRoot, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const entries = [];
  for (const child of children) {
    if (!child.isDirectory()) {
      continue;
    }
    const match = child.name.match(CACHE_NAME_PATTERN);
    if (match == null) {
      continue;
    }
    const entryPath = path.join(cacheRoot, child.name);
    const stat = await lstat(entryPath);
    entries.push({
      name: child.name,
      path: entryPath,
      family: match[1],
      mtimeMs: stat.mtimeMs,
      bytes: await directorySize(entryPath),
    });
  }
  return entries;
}

function protectedCacheNames(cacheRoot, protectedPaths) {
  const names = new Set();
  for (const protectedPath of protectedPaths) {
    const resolved = path.resolve(protectedPath);
    if (path.dirname(resolved) !== cacheRoot) {
      throw new Error(
        `protected cache path is outside cache root: ${resolved}`,
      );
    }
    names.add(path.basename(resolved));
  }
  return names;
}

async function pruneCache({
  cacheRoot,
  protectedPaths = [],
  retentionCount = DEFAULT_RETENTION_COUNT,
  maxBytes = DEFAULT_MAX_BYTES,
  minAgeMs = DEFAULT_MIN_AGE_MS,
  now = Date.now(),
}) {
  const resolvedRoot = path.resolve(cacheRoot);
  const protectedNames = protectedCacheNames(resolvedRoot, protectedPaths);
  const entries = await readCacheEntries(resolvedRoot);
  let totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const recentNames = new Set(
    entries
      .filter((entry) => now - entry.mtimeMs < minAgeMs)
      .map((entry) => entry.name),
  );
  const removed = [];
  const remaining = new Map(entries.map((entry) => [entry.name, entry]));

  const removeEntry = async (entry, reason) => {
    if (!remaining.has(entry.name)) {
      return;
    }
    // The strict name match and direct-parent check keep recursive removal
    // constrained to cache entries created by these build scripts.
    if (
      !CACHE_NAME_PATTERN.test(entry.name) ||
      path.dirname(entry.path) !== resolvedRoot
    ) {
      throw new Error(`refusing to remove unsafe cache path: ${entry.path}`);
    }
    try {
      const currentStat = await lstat(entry.path);
      if (now - currentStat.mtimeMs < minAgeMs) {
        recentNames.add(entry.name);
        return;
      }
    } catch (err) {
      if (err?.code === "ENOENT") {
        remaining.delete(entry.name);
        totalBytes -= entry.bytes;
        return;
      }
      throw err;
    }
    await rm(entry.path, { recursive: true, force: true });
    remaining.delete(entry.name);
    totalBytes -= entry.bytes;
    removed.push({ ...entry, reason });
  };

  const families = new Map();
  for (const entry of entries) {
    const family = families.get(entry.family) ?? [];
    family.push(entry);
    families.set(entry.family, family);
  }
  for (const family of families.values()) {
    family.sort(
      (a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name),
    );
    for (const entry of family.slice(retentionCount)) {
      if (!protectedNames.has(entry.name) && !recentNames.has(entry.name)) {
        await removeEntry(entry, "retention");
      }
    }
  }

  if (totalBytes > maxBytes) {
    const oldestFirst = [...remaining.values()].sort(
      (a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name),
    );
    for (const entry of oldestFirst) {
      if (totalBytes <= maxBytes) {
        break;
      }
      if (protectedNames.has(entry.name) || recentNames.has(entry.name)) {
        continue;
      }
      await removeEntry(entry, "size");
    }
  }

  return {
    removed,
    totalBytes,
    entryCount: remaining.size,
    overLimit: totalBytes > maxBytes,
  };
}

function formatMiB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

async function main() {
  const [cacheRoot, ...protectedPaths] = process.argv.slice(2);
  if (!cacheRoot) {
    throw new Error(
      "usage: tools-cache-prune.cjs CACHE_ROOT [PROTECTED_CACHE_PATH ...]",
    );
  }
  const result = await pruneCache({
    cacheRoot,
    protectedPaths,
    retentionCount: parseNonnegativeInteger(
      process.env.COCALC_PROJECT_TOOLS_CACHE_RETENTION_COUNT,
      DEFAULT_RETENTION_COUNT,
      "COCALC_PROJECT_TOOLS_CACHE_RETENTION_COUNT",
    ),
    maxBytes: parseNonnegativeInteger(
      process.env.COCALC_PROJECT_TOOLS_CACHE_MAX_BYTES,
      DEFAULT_MAX_BYTES,
      "COCALC_PROJECT_TOOLS_CACHE_MAX_BYTES",
    ),
    minAgeMs: parseNonnegativeInteger(
      process.env.COCALC_PROJECT_TOOLS_CACHE_MIN_AGE_MS,
      DEFAULT_MIN_AGE_MS,
      "COCALC_PROJECT_TOOLS_CACHE_MIN_AGE_MS",
    ),
  });
  if (result.removed.length > 0) {
    const removedBytes = result.removed.reduce(
      (sum, entry) => sum + entry.bytes,
      0,
    );
    console.log(
      `Pruned ${result.removed.length} project tools cache entr${
        result.removed.length === 1 ? "y" : "ies"
      } (${formatMiB(removedBytes)} MiB); ${result.entryCount} entries remain (${formatMiB(result.totalBytes)} MiB).`,
    );
  }
  if (result.overLimit) {
    console.warn(
      `Project tools cache remains over its size limit because current or recent entries are protected (${formatMiB(result.totalBytes)} MiB).`,
    );
  }
}

module.exports = {
  CACHE_NAME_PATTERN,
  directorySize,
  parseNonnegativeInteger,
  pruneCache,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
