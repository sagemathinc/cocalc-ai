import path from "path";
import { projectRuntimeHomeRelativePath } from "../project-runtime";

// subdirectory of HOME where snapshots are stored:

export const SNAPSHOTS = ".snapshots";

function stripLeadingSlash(path: string): string {
  return path.replace(/^\/+/, "");
}

export function isSnapshotsPath(path?: string): boolean {
  if (path == null) return false;
  const normalized = `${path}`.replace(/\/+$/, "");
  const stripped = stripLeadingSlash(normalized);
  return (
    stripped === SNAPSHOTS ||
    stripped.startsWith(`${SNAPSHOTS}/`) ||
    normalized.includes(`/${SNAPSHOTS}/`) ||
    normalized.endsWith(`/${SNAPSHOTS}`)
  );
}

export type SnapshotPathTarget =
  | { kind: "snapshots-root" }
  | { kind: "snapshot"; name: string }
  | { kind: "snapshot-entry"; name: string; relativePath: string };

export function getSnapshotPathTarget(
  rawPath?: string,
  options?: { homePath?: string },
): SnapshotPathTarget | undefined {
  if (rawPath == null) return undefined;
  const normalized = path.posix
    .normalize(`${rawPath}`.replace(/\\/g, "/"))
    .replace(/\/+$/, "");
  if (!normalized || normalized === "." || normalized === "/") {
    return undefined;
  }
  const candidates = new Set<string>();
  const stripped = stripLeadingSlash(normalized);
  if (stripped) {
    candidates.add(stripped);
  }
  const runtimeRelative = projectRuntimeHomeRelativePath(normalized);
  if (runtimeRelative != null) {
    candidates.add(stripLeadingSlash(runtimeRelative.replace(/\/+$/, "")));
  }
  if (options?.homePath) {
    const normalizedHome = path.posix
      .normalize(`${options.homePath}`.replace(/\\/g, "/"))
      .replace(/\/+$/, "");
    if (normalized === normalizedHome) {
      candidates.add("");
    } else if (normalized.startsWith(`${normalizedHome}/`)) {
      candidates.add(path.posix.relative(normalizedHome, normalized));
    }
  }
  for (const candidate of candidates) {
    const relative = stripLeadingSlash(candidate.replace(/\/+$/, ""));
    if (relative === SNAPSHOTS) {
      return { kind: "snapshots-root" };
    }
    if (!relative.startsWith(`${SNAPSHOTS}/`)) {
      continue;
    }
    const parts = relative.split("/");
    const name = parts[1];
    if (!name) {
      continue;
    }
    if (parts.length === 2) {
      return { kind: "snapshot", name };
    }
    return {
      kind: "snapshot-entry",
      name,
      relativePath: parts.slice(2).join("/"),
    };
  }
  return undefined;
}

// Lengths of time in minutes to keep snapshots
// (code below assumes these are listed in ORDER from shortest to longest)
export const SNAPSHOT_INTERVALS_MS = {
  frequent: 15 * 1000 * 60,
  daily: 60 * 24 * 1000 * 60,
  weekly: 60 * 24 * 7 * 1000 * 60,
  monthly: 60 * 24 * 7 * 4 * 1000 * 60,
};

// How many of each type of snapshot to retain
export const DEFAULT_SNAPSHOT_COUNTS = {
  frequent: 4,
  daily: 7,
  weekly: 4,
  monthly: 2,
} as SnapshotCounts;

export const DEFAULT_BACKUP_COUNTS = {
  frequent: 0,
  daily: 1,
  weekly: 3,
  monthly: 4,
} as SnapshotCounts;

// We have at least one snapshot for each interval, assuming
// there are actual changes since the last snapshot, and at
// most the listed number.
export interface SnapshotCounts {
  frequent: number;
  daily: number;
  weekly: number;
  monthly: number;
}

export interface SnapshotSchedule extends SnapshotCounts {
  disabled?: boolean;
}
