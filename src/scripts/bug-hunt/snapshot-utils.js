#!/usr/bin/env node
"use strict";

const cp = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_SNAPSHOT_ROOT = path.join(os.homedir(), ".snapshots");

function parseSnapshotName(name) {
  const match = /^snap-(\d{8})-(\d{6})$/.exec(`${name ?? ""}`.trim());
  if (!match) return undefined;
  const [, day, time] = match;
  const iso = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}.000Z`;
  return {
    name: match[0],
    timestamp: iso,
    timestamp_ms: Date.parse(iso),
  };
}

function mapRepoIntoSnapshot(currentRepo, snapshotDir, homeDir = os.homedir()) {
  const resolvedRepo = path.resolve(currentRepo);
  const resolvedHome = path.resolve(homeDir);
  if (
    !resolvedRepo.startsWith(`${resolvedHome}${path.sep}`) &&
    resolvedRepo !== resolvedHome
  ) {
    throw new Error(`repo ${resolvedRepo} is not inside ${resolvedHome}`);
  }
  return path.join(snapshotDir, path.relative(resolvedHome, resolvedRepo));
}

function listSnapshots(
  snapshotRoot = DEFAULT_SNAPSHOT_ROOT,
  currentRepo,
  homeDir = os.homedir(),
) {
  if (!fs.existsSync(snapshotRoot)) return [];
  const rows = [];
  for (const entry of fs.readdirSync(snapshotRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const parsed = parseSnapshotName(entry.name);
    if (!parsed) continue;
    const snapshotDir = path.join(snapshotRoot, entry.name);
    const repoPath = currentRepo
      ? mapRepoIntoSnapshot(currentRepo, snapshotDir, homeDir)
      : snapshotDir;
    if (currentRepo && !fs.existsSync(repoPath)) continue;
    rows.push({
      ...parsed,
      dir: snapshotDir,
      repo_path: repoPath,
    });
  }
  return rows.sort((left, right) => left.timestamp_ms - right.timestamp_ms);
}

function resolveSnapshot(
  snapshotValue,
  currentRepo,
  snapshotRoot = DEFAULT_SNAPSHOT_ROOT,
  homeDir = os.homedir(),
) {
  const raw = `${snapshotValue ?? ""}`.trim();
  if (!raw) {
    throw new Error("snapshot is required");
  }
  if (path.isAbsolute(raw)) {
    const dir = path.resolve(raw);
    const parsed = parseSnapshotName(path.basename(dir));
    const repoPath = currentRepo
      ? mapRepoIntoSnapshot(currentRepo, dir, homeDir)
      : dir;
    return {
      ...(parsed ?? {
        name: path.basename(dir),
        timestamp: "",
        timestamp_ms: NaN,
      }),
      dir,
      repo_path: repoPath,
    };
  }
  const snapshots = listSnapshots(snapshotRoot, currentRepo, homeDir);
  const found = snapshots.find((snapshot) => snapshot.name === raw);
  if (!found) {
    throw new Error(`snapshot not found: ${raw}`);
  }
  return found;
}

function selectSnapshotBefore(snapshots, timestampMs) {
  let best;
  for (const snapshot of snapshots) {
    if (snapshot.timestamp_ms <= timestampMs) {
      best = snapshot;
    } else {
      break;
    }
  }
  return best;
}

function selectSnapshotAfter(snapshots, timestampMs) {
  return snapshots.find((snapshot) => snapshot.timestamp_ms > timestampMs);
}

function runGit(repo, args, options = {}) {
  const result = cp.spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${repo}: ${`${result.stderr ?? ""}`.trim() || `${result.stdout ?? ""}`.trim()}`,
    );
  }
  return options.trim === false
    ? `${result.stdout ?? ""}`
    : `${result.stdout ?? ""}`.trim();
}

function parseNullSeparated(text) {
  return `${text ?? ""}`
    .split("\0")
    .map((value) => value.trim())
    .filter(Boolean);
}

function listRelevantFiles(repo) {
  return parseNullSeparated(
    runGit(repo, ["ls-files", "-co", "--exclude-standard", "-z"], {
      trim: false,
    }),
  );
}

function hashFile(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function compareRepoContents(baseRepo, targetRepo) {
  const baseFiles = new Set(listRelevantFiles(baseRepo));
  const targetFiles = new Set(listRelevantFiles(targetRepo));
  const all = Array.from(new Set([...baseFiles, ...targetFiles])).sort();
  const changes = [];
  for (const rel of all) {
    const basePath = path.join(baseRepo, rel);
    const targetPath = path.join(targetRepo, rel);
    const inBase = fs.existsSync(basePath);
    const inTarget = fs.existsSync(targetPath);
    if (inBase && !inTarget) {
      changes.push({ path: rel, status: "deleted" });
      continue;
    }
    if (!inBase && inTarget) {
      changes.push({ path: rel, status: "added" });
      continue;
    }
    if (!inBase || !inTarget) continue;
    if (hashFile(basePath) !== hashFile(targetPath)) {
      changes.push({ path: rel, status: "modified" });
    }
  }
  return changes;
}

function summarizeChanges(changes) {
  const summary = {
    total: changes.length,
    added: 0,
    deleted: 0,
    modified: 0,
  };
  for (const change of changes) {
    summary[change.status] += 1;
  }
  return summary;
}

module.exports = {
  DEFAULT_SNAPSHOT_ROOT,
  compareRepoContents,
  listRelevantFiles,
  listSnapshots,
  mapRepoIntoSnapshot,
  parseSnapshotName,
  resolveSnapshot,
  selectSnapshotAfter,
  selectSnapshotBefore,
  summarizeChanges,
};
