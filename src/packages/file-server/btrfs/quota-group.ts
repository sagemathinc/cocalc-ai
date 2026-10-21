/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Quota groups (btrfs qgroups of level 1) over several subvolumes, e.g., a
project's home and its persist volume (project-host project-quota-group.ts).
With simple quotas a group's usage is its members' usage, a write is refused
when it would take any group it is in over its limit, and a subvolume that
already holds data counts in a group as soon as it is added (no rescan).  A
subvolume created inside a member (e.g., a snapshot in ~/.snapshots) joins
the group by itself; any other is added here.
*/

import { exists } from "@cocalc/backend/misc/async-utils-node";
import { btrfs } from "./util";

// btrfs answers "File exists" when the group, or the membership, already is.
function alreadyExists(err: unknown): boolean {
  const e = err as { message?: string; stderr?: string };
  return /file exists/i.test(`${e?.message ?? err} ${e?.stderr ?? ""}`);
}

async function createGroup(mount: string, group: string): Promise<void> {
  try {
    await btrfs({ args: ["qgroup", "create", group, mount], verbose: false });
  } catch (err) {
    if (!alreadyExists(err)) throw err;
  }
}

async function assign(mount: string, group: string, path: string) {
  try {
    await btrfs({
      args: ["qgroup", "assign", "--no-rescan", path, group, mount],
      verbose: false,
    });
  } catch (err) {
    if (!alreadyExists(err)) throw err;
  }
}

// Adds the subvolume at `path` to `group` (creating the group if needed).
export async function addToQuotaGroup({
  mount,
  group,
  path,
}: {
  mount: string;
  group: string;
  path: string;
}): Promise<void> {
  await createGroup(mount, group);
  await assign(mount, group, path);
}

// The group with those of `members` that exist in it, and with `size` as its
// limit.
export async function syncQuotaGroupNow({
  mount,
  group,
  members,
  size,
}: {
  mount: string;
  group: string;
  members: string[];
  size: string;
}): Promise<void> {
  await createGroup(mount, group);
  for (const path of members) {
    if (await exists(path)) {
      await assign(mount, group, path);
    }
  }
  await btrfs({
    args: ["qgroup", "limit", size, group, mount],
    verbose: false,
  });
}

// Destroys `group`, which its members (deleted subvolumes leave it) must have
// left.
export async function destroyQuotaGroup({
  mount,
  group,
}: {
  mount: string;
  group: string;
}): Promise<void> {
  await btrfs({ args: ["qgroup", "destroy", group, mount], verbose: false });
}

export interface QgroupRelationRow {
  qgroupid: string;
  referenced: number;
  max_referenced: number | "none";
  parents: string[];
  children: string[];
}

// The rows of `btrfs qgroup show -prc --raw` (with -f or -F): Qgroupid,
// Referenced, Exclusive, Max referenced, Parent, Child, Path.
export function parseQgroupRelations(stdout: string): QgroupRelationRow[] {
  const list = (value: string) =>
    value === "-" ? [] : value.split(",").filter(Boolean);
  const rows: QgroupRelationRow[] = [];
  for (const line of stdout.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 6 || !/^\d+\/\d+$/.test(fields[0])) continue;
    const [qgroupid, referenced, , maxReferenced, parents, children] = fields;
    const max = Number.parseInt(maxReferenced, 10);
    rows.push({
      qgroupid,
      referenced: Number.parseInt(referenced, 10),
      max_referenced: Number.isFinite(max) ? max : "none",
      parents: list(parents),
      children: list(children),
    });
  }
  return rows;
}
