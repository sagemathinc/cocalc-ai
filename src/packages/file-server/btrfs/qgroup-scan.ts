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

Subvolumes are found by their id, not their path (a restore puts another
subvolume at a home's path).  What this host changes itself (a limit) is
updated in the cached scan, rather than dropping it; other changes (snapshots
made or deleted, restores and other swaps) drop it (invalidateQgroupScan, or
forgetSubvolumePaths in operation-cache.ts), and a subvolume not in the scan
(e.g., just made) reads it again (once).
*/

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
  // which read this is (they are numbered as they begin): what began after a
  // lookup began has a higher number than any it could have joined
  seq?: number;
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
// reads begun so far, on any filesystem
let readsBegun = 0;
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
    const seq = ++readsBegun;
    const { stdout, stderr } = await btrfs({
      verbose: false,
      args: ["qgroup", "show", "-prc", "--raw", mount],
    });
    const result = { ...parseQgroupScan(stdout, stderr, started), seq };
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

// The id of the subvolume at `path`, as it is now (not cached: e.g., a
// restore may have put another subvolume there).
export async function currentSubvolumeId(path: string): Promise<number> {
  const { stdout } = await btrfs({
    verbose: false,
    args: ["subvolume", "show", path],
  });
  const id = Number(stdout.match(/^\s*Subvolume ID:\s*(\d+)/m)?.[1]);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`no subvolume id for ${path}`);
  }
  return id;
}

// The qgroup of the subvolume at `path` (level 0), with the groups it is in.
// It is found by the subvolume's id, never by its path: a path can be given
// to another subvolume (e.g., a restore swaps homes), and its old row would
// still be in what was read.
export async function lookupQgroup({
  mount,
  getSubvolumeId,
}: {
  mount: string;
  path?: string;
  getSubvolumeId: () => Promise<number>;
}): Promise<
  { row: QgroupScanRow; parents: QgroupScanRow[]; warning?: string } | undefined
> {
  // the reads begun before this lookup: one of them may not have it
  const begun = readsBegun;
  const id = `0/${await getSubvolumeId()}`;
  let s = await getQgroupScan(mount);
  let row = s.rows.get(id);
  // not there: read again, unless what was read began after this did (a
  // read joined under way may have begun before, e.g., before the subvolume
  // was made: then once more)
  for (let i = 0; row == null && (s.seq ?? 0) <= begun && i < 3; i++) {
    s = await scan(mount);
    row = s.rows.get(id);
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
// lookup reads the filesystem again, also if a read was under way (it is
// never kept, nor given to anyone who asks from now on).
export function invalidateQgroupScan(pathOrMount: string): void {
  for (const mount of new Set([...scans.keys(), ...inflight.keys()])) {
    if (
      mount === pathOrMount ||
      pathOrMount.startsWith(`${mount}/`) ||
      mount.startsWith(`${pathOrMount}/`)
    ) {
      scans.delete(mount);
      inflight.delete(mount);
      generations.set(mount, (generations.get(mount) ?? 0) + 1);
    }
  }
}

// This host set the limit of the subvolume at `path` to `size` bytes: the
// cached scan says so too (or is dropped, if it can't tell which row).
export async function noteQgroupLimit({
  mount,
  path,
  size,
}: {
  mount: string;
  path: string;
  size: number | string;
}): Promise<void> {
  const generation = generations.get(mount) ?? 0;
  if (inflight.has(mount) || !scans.has(mount)) {
    // (a read already under way may be from before the change)
    invalidateQgroupScan(mount);
    return;
  }
  const bytes = Number(size);
  let id: number | undefined;
  try {
    id = await currentSubvolumeId(path);
  } catch {}
  const s = scans.get(mount);
  const row = id == null ? undefined : s?.rows.get(`0/${id}`);
  if (
    row == null ||
    (generations.get(mount) ?? 0) !== generation ||
    !Number.isSafeInteger(bytes) ||
    bytes <= 0
  ) {
    invalidateQgroupScan(mount);
    return;
  }
  row.max_referenced = bytes;
}

// This host put the subvolumes at `members` (all existing) in `group`, with
// `size` as its limit if given: the cached scan says so too (or is dropped,
// if it can't place one).  Members are found by their ids as they are now
// (as for noteQgroupLimit).  With simple quotas a subvolume's usage counts in
// a group as soon as it joins.
export async function noteQgroupGroup({
  mount,
  group,
  members,
  size,
}: {
  mount: string;
  group: string;
  members: string[];
  size?: number;
}): Promise<void> {
  const generation = generations.get(mount) ?? 0;
  if (inflight.has(mount) || !scans.has(mount)) {
    invalidateQgroupScan(mount);
    return;
  }
  let ids: number[];
  try {
    ids = await Promise.all(members.map(currentSubvolumeId));
  } catch {
    invalidateQgroupScan(mount);
    return;
  }
  const s = scans.get(mount);
  const rows = ids.map((id) => s?.rows.get(`0/${id}`));
  if (
    s == null ||
    (generations.get(mount) ?? 0) !== generation ||
    rows.some((row) => row == null)
  ) {
    invalidateQgroupScan(mount);
    return;
  }
  let row = s.rows.get(group);
  if (row == null) {
    row = {
      qgroupid: group,
      referenced: 0,
      exclusive: 0,
      max_referenced: "none",
      parents: [],
      children: [],
    };
    s.rows.set(group, row);
  }
  for (const member of rows as QgroupScanRow[]) {
    if (member.parents.includes(group)) continue;
    member.parents.push(group);
    row.children.push(member.qgroupid);
    row.referenced += member.referenced;
    row.exclusive += member.exclusive;
  }
  if (size != null) row.max_referenced = size;
}

export function resetQgroupScansForTest(): void {
  scans.clear();
  inflight.clear();
  generations.clear();
  readsBegun = 0;
}
