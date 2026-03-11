/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { execSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export interface FrontendSourceFingerprint {
  available: boolean;
  fingerprint: string;
  git_revision: string;
  latest_mtime_ms: number | null;
  latest_mtime_iso?: string;
  latest_path?: string;
  watched_roots: string[];
  scanned_file_count: number;
  checked_at: string;
  reason?: string;
}

export interface FrontendSourceFingerprintOptions {
  repoRoot?: string;
  sourceRoots?: string[];
  now?: Date;
}

const IGNORED_DIRS = new Set([
  ".git",
  ".local",
  ".next",
  ".venv",
  "node_modules",
  "dist",
  "dist-ts",
  "coverage",
  "test-results",
  "site",
  "venv",
  "__pycache__",
]);

type ScanState = {
  latestMtimeMs: number | null;
  latestPath?: string;
  scannedFileCount: number;
};

function findRepoRootFromDir(start: string): string | undefined {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, "src", "packages"))) {
      return dir;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

function findRepoRootSync(start = process.cwd()): string | undefined {
  try {
    const root = execSync("git rev-parse --show-toplevel", {
      cwd: start,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (root) {
      return root;
    }
  } catch {
    // Fall through to the filesystem-based fallback.
  }
  for (const candidate of [start, __dirname]) {
    const root = findRepoRootFromDir(candidate);
    if (root != null) {
      return root;
    }
  }
  return undefined;
}

function getGitRevisionSync(repoRoot?: string): string {
  if (!repoRoot) {
    return "N/A";
  }
  try {
    return execSync("git rev-parse HEAD", {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "N/A";
  }
}

function defaultSourceRoots(repoRoot: string): string[] {
  return [repoRoot];
}

function listGitFilesSync(repoRoot: string): string[] | undefined {
  try {
    const stdout = execSync(
      "git ls-files --cached --others --exclude-standard -z",
      {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).toString();
    return stdout
      .split("\0")
      .map((path) => path.trim())
      .filter(Boolean);
  } catch {
    return undefined;
  }
}

function updateStateFromPath(
  repoRoot: string,
  rel: string,
  state: ScanState,
): void {
  const full = join(repoRoot, rel);
  if (!existsSync(full)) {
    return;
  }
  const stat = lstatSync(full);
  if (!stat.isFile()) {
    return;
  }
  const mtimeMs = Number(stat.mtimeMs ?? 0);
  if (!Number.isFinite(mtimeMs)) {
    return;
  }
  state.scannedFileCount += 1;
  if (
    state.latestMtimeMs == null ||
    mtimeMs > state.latestMtimeMs ||
    (mtimeMs === state.latestMtimeMs &&
      rel.localeCompare(state.latestPath ?? "") > 0)
  ) {
    state.latestMtimeMs = mtimeMs;
    state.latestPath = rel;
  }
}

function scanTree(root: string, repoRoot: string, state: ScanState): void {
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) {
      continue;
    }
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      scanTree(full, repoRoot, state);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const rel = relative(repoRoot, full).split("\\").join("/");
    updateStateFromPath(repoRoot, rel, state);
  }
}

function makeUnavailable(
  now: Date,
  git_revision: string,
  watched_roots: string[],
  reason: string,
): FrontendSourceFingerprint {
  return {
    available: false,
    fingerprint: `unavailable:${git_revision}:${reason}`,
    git_revision,
    latest_mtime_ms: null,
    watched_roots,
    scanned_file_count: 0,
    checked_at: now.toISOString(),
    reason,
  };
}

export function getFrontendSourceFingerprintSync(
  opts: FrontendSourceFingerprintOptions = {},
): FrontendSourceFingerprint {
  const now = opts.now ?? new Date();
  const repoRoot = opts.repoRoot ?? findRepoRootSync();
  const git_revision = getGitRevisionSync(repoRoot);
  const sourceRootsInput =
    opts.sourceRoots ?? (repoRoot ? defaultSourceRoots(repoRoot) : undefined);
  const sourceRoots = sourceRootsInput
    ?.map((root) => resolve(root))
    .filter(existsSync);

  if (!repoRoot) {
    return makeUnavailable(now, git_revision, [], "repo root not found");
  }
  if (!sourceRoots || sourceRoots.length === 0) {
    return makeUnavailable(now, git_revision, [], "no repo roots found");
  }

  const state: ScanState = {
    latestMtimeMs: null,
    scannedFileCount: 0,
  };
  const gitFiles =
    sourceRoots.length === 1 ? listGitFilesSync(repoRoot) : undefined;
  if (gitFiles != null) {
    for (const rel of gitFiles) {
      updateStateFromPath(repoRoot, rel, state);
    }
  } else {
    for (const root of sourceRoots) {
      scanTree(root, repoRoot, state);
    }
  }

  const watched_roots = sourceRoots.map(
    (root) => relative(repoRoot, root).split("\\").join("/") || ".",
  );
  if (state.scannedFileCount === 0 || state.latestMtimeMs == null) {
    return makeUnavailable(
      now,
      git_revision,
      watched_roots,
      "no repo files found",
    );
  }

  const latest_mtime_iso = new Date(state.latestMtimeMs).toISOString();
  return {
    available: true,
    fingerprint: `${git_revision}:${state.latestMtimeMs}:${state.latestPath ?? "N/A"}`,
    git_revision,
    latest_mtime_ms: state.latestMtimeMs,
    latest_mtime_iso,
    latest_path: state.latestPath,
    watched_roots,
    scanned_file_count: state.scannedFileCount,
    checked_at: now.toISOString(),
  };
}

let cache:
  | {
      expiresAt: number;
      value: FrontendSourceFingerprint;
    }
  | undefined;
let inFlight: Promise<FrontendSourceFingerprint> | undefined;

export async function getFrontendSourceFingerprint(opts?: {
  maxAgeMs?: number;
}): Promise<FrontendSourceFingerprint> {
  const maxAgeMs = Math.max(0, opts?.maxAgeMs ?? 10_000);
  const now = Date.now();
  if (cache != null && cache.expiresAt > now) {
    return cache.value;
  }
  if (inFlight != null) {
    return inFlight;
  }
  inFlight = Promise.resolve().then(() => {
    const value = getFrontendSourceFingerprintSync();
    cache = { value, expiresAt: Date.now() + maxAgeMs };
    return value;
  });
  try {
    return await inFlight;
  } finally {
    inFlight = undefined;
  }
}
