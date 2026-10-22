/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
One read of a filesystem's quota tree, shared by every quota lookup on it.

`btrfs qgroup show` searches the whole quota tree, whatever path it is given
(with -f or -F it only filters afterwards).  On a host with tens of thousands
of subvolumes (snapshots) that is about half a second per call, so reading it
per subvolume, as quota checks, audits and storage views did, costs a full
scan each time.  Instead the filesystem is read once and the result reused
for a while (COCALC_BTRFS_QGROUP_SCAN_CACHE_MS, 30 s by default): with simple
quotas the counts only change when btrfs commits (every 30 s by default), so
this is about as fresh as reading again.

What this host changes itself (a limit) is updated in the cached scan, rather
than dropping it; other changes (snapshots made or deleted, restores) drop it
(invalidateQgroupScan), and a subvolume not in the scan (e.g., just made)
reads it again (once).
*/

import { relative } from "node:path";
import { btrfs } from "./util";

export interface QgroupScanRow {
  qgroupid: string;
  referenced: number;
  exclusive: number;
  max_referenced: number | "none";
  parents: string[];
  children: string[];
  // relative to the filesystem's top level (level 0 qgroups of existing
  // subvolumes)
  path?: string;
}

export interface QgroupScan {
  rows: Map<string, QgroupScanRow>;
  byPath: Map<string, QgroupScanRow>;
  // e.g., btrfs saying its quota accounting is inconsistent
  warning?: string;
  scanned_at: number;
}

const DEFAULT_SCAN_CACHE_MS = 30_000;

function scanCacheMs(): number {
  const value = Number.parseInt(
    `${process.env.COCALC_BTRFS_QGROUP_SCAN_CACHE_MS ?? ""}`,
    10,
  );
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SCAN_CACHE_MS;
}

function parseSize(value: string): number | "none" {
  if (value.trim().toLowerCase() === "none") return "none";
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : "none";
}

// The output of `btrfs qgroup show -prc --raw <mount>`: Qgroupid, Referenced,
// Exclusive, Max referenced, Parent, Child, Path.
export function parseQgroupScan(
  stdout: string,
  stderr?: string,
  scanned_at = Date.now(),
): QgroupScan {
  const list = (value: string) =>
    value === "-" ? [] : value.split(",").filter(Boolean);
  const rows = new Map<string, QgroupScanRow>();
  const byPath = new Map<string, QgroupScanRow>();
  for (const line of stdout.split("\n")) {
    const match = line
      .trim()
      .match(
        /^(\d+\/\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/,
      );
    if (!match) continue;
    const [, qgroupid, referenced, exclusive, max, parents, children, path] =
      match;
    const row: QgroupScanRow = {
      qgroupid,
      referenced: Number.parseInt(referenced, 10),
      exclusive: Number.parseInt(exclusive, 10),
      max_referenced: parseSize(max),
      parents: list(parents),
      children: list(children),
    };
    const p = path?.trim();
    // (not "<toplevel>", "<stale>", "<under deletion>" or "<N member qgroups>")
    if (p && !p.startsWith("<")) {
      row.path = p;
      byPath.set(p, row);
    }
    rows.set(qgroupid, row);
  }
  const text = `${stderr ?? ""}`.trim();
  return {
    rows,
    byPath,
    scanned_at,
    warning: !text
      ? undefined
      : text.toLowerCase().includes("qgroup data inconsistent")
        ? "Btrfs quota accounting is currently inconsistent on this host, so counted quota usage may be inaccurate until it is repaired."
        : text,
  };
}

const scans = new Map<string, QgroupScan>();
const inflight = new Map<string, Promise<QgroupScan>>();
// bumped when a mount's scan is dropped: a read that started before is not
// kept
const generations = new Map<string, number>();

async function scan(mount: string): Promise<QgroupScan> {
  const pending = inflight.get(mount);
  if (pending) return await pending;
  const generation = generations.get(mount) ?? 0;
  const promise = (async () => {
    // (as of when it started: what changed meanwhile may not be in it)
    const started = Date.now();
    const { stdout, stderr } = await btrfs({
      verbose: false,
      args: ["qgroup", "show", "-prc", "--raw", mount],
    });
    const result = parseQgroupScan(stdout, stderr, started);
    if ((generations.get(mount) ?? 0) === generation) {
      scans.set(mount, result);
    }
    return result;
  })();
  inflight.set(mount, promise);
  try {
    return await promise;
  } finally {
    if (inflight.get(mount) === promise) inflight.delete(mount);
  }
}

// The quota tree of the filesystem mounted at `mount`, read at most
// COCALC_BTRFS_QGROUP_SCAN_CACHE_MS ago.
export async function getQgroupScan(mount: string): Promise<QgroupScan> {
  const cached = scans.get(mount);
  if (cached != null && Date.now() - cached.scanned_at < scanCacheMs()) {
    return cached;
  }
  return await scan(mount);
}

// The qgroup of the subvolume at `path` (level 0), with the groups it is in.
export async function lookupQgroup({
  mount,
  path,
  getSubvolumeId,
}: {
  mount: string;
  path: string;
  // used if the path is not in the scan (e.g., `mount` isn't the top level)
  getSubvolumeId: () => Promise<number>;
}): Promise<
  { row: QgroupScanRow; parents: QgroupScanRow[]; warning?: string } | undefined
> {
  const started = Date.now();
  const rel = relative(mount, path);
  let id: string | undefined;
  const find = async (s: QgroupScan) => {
    let row = rel && !rel.startsWith("..") ? s.byPath.get(rel) : undefined;
    if (row == null) {
      id ??= `0/${await getSubvolumeId()}`;
      row = s.rows.get(id);
    }
    return row;
  };
  let s = await getQgroupScan(mount);
  let row = await find(s);
  // not there: read again, unless what was read is from after this began
  if (row == null && s.scanned_at < started) {
    s = await scan(mount);
    row = await find(s);
  }
  if (row == null) return;
  return {
    row,
    parents: row.parents
      .map((p) => s.rows.get(p))
      .filter((r): r is QgroupScanRow => r != null),
    warning: s.warning,
  };
}

// The scan of `mount` (or the one containing the path) is dropped: the next
// lookup reads the filesystem again.
export function invalidateQgroupScan(pathOrMount: string): void {
  for (const mount of new Set([...scans.keys(), ...inflight.keys()])) {
    if (
      mount === pathOrMount ||
      pathOrMount.startsWith(`${mount}/`) ||
      mount.startsWith(`${pathOrMount}/`)
    ) {
      scans.delete(mount);
      generations.set(mount, (generations.get(mount) ?? 0) + 1);
    }
  }
}

// This host set the limit of the subvolume at `path` to `size` bytes: the
// cached scan says so too (or is dropped, if it can't tell which row).
export function noteQgroupLimit({
  mount,
  path,
  size,
}: {
  mount: string;
  path: string;
  size: number | string;
}): void {
  if (inflight.has(mount)) {
    // (a read already under way may be from before the change)
    invalidateQgroupScan(mount);
    return;
  }
  const s = scans.get(mount);
  if (s == null) return;
  const bytes = Number(size);
  const row = s.byPath.get(relative(mount, path));
  if (row == null || !Number.isSafeInteger(bytes) || bytes <= 0) {
    invalidateQgroupScan(mount);
    return;
  }
  row.max_referenced = bytes;
}

export function resetQgroupScansForTest(): void {
  scans.clear();
  inflight.clear();
  generations.clear();
}
