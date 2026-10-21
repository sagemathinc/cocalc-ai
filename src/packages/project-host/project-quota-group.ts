/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
One quota for a project's files and its edit history.

The history lives in a volume of its own (persist-volume.ts), so deleting
files would not make room for it.  Instead, a btrfs quota group per project
(file-server quota-group.ts) holds the project's home and its persist volume:

- the home's own limit is the project's disk quota Q: files never take more;
- the group's limit is Q + R, the files and history together: deleting files
  makes room for history, and the history always has R of its own (live edits
  keep working when the files fill Q).

So a project is full when its files reach Q, or its files and history reach
Q + R: its usage against Q is the larger of files and (files + history - R)
(effectiveQuotaUsage).

Snapshots in ~/.snapshots join the group by themselves (they are created
inside the home).  A home or persist volume created anywhere else (a restore,
a copy) is added when it is put in place, and by every quota change and
audit of the project (file-server.ts), which also brings existing projects in.

Btrfs simple quotas charge data to the subvolume that wrote it, for as long as
anything uses it: e.g., a home replaced by a restore stays in the group (as a
deleted subvolume) while the new home shares its data.  So only the group's
total is exact; how it splits into files and history is approximate.
*/

import {
  cachedBtrfsQgroupShowRawForPath,
  invalidateBtrfsQgroupShowRaw,
} from "@cocalc/file-server/btrfs/operation-cache";
import {
  addToQuotaGroup,
  destroyQuotaGroup,
  parseQgroupRelations,
} from "@cocalc/file-server/btrfs/quota-group";
import { queueSyncQuotaGroup } from "@cocalc/file-server/btrfs/quota-queue";
import type { BtrfsMutationPriority } from "@cocalc/file-server/btrfs/mutation-context";
import { btrfsQuotasDisabled } from "@cocalc/file-server/btrfs/config";
import { btrfs } from "@cocalc/file-server/btrfs/util";
import { exists } from "@cocalc/backend/misc/async-utils-node";
import getLogger from "@cocalc/backend/logger";
import { isValidUUID } from "@cocalc/util/misc";

const logger = getLogger("project-host:project-quota-group");

const MiB = 1024 * 1024;

// The project's quota group: level 1, numbered by the first 48 bits of its id.
export function projectQuotaGroup(project_id: string): string {
  if (!isValidUUID(project_id)) {
    throw new Error(`invalid project id: ${project_id}`);
  }
  return `1/${Number.parseInt(project_id.replace(/-/g, "").slice(0, 12), 16)}`;
}

// R, the history's own room beyond the files' Q.
export function historyReserve(
  quota: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const setting = (name: string, fallback: number) => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  const percent = setting("COCALC_PERSIST_HISTORY_RESERVE_PERCENT", 10);
  const min = setting("COCALC_PERSIST_HISTORY_RESERVE_MIN_BYTES", 256 * MiB);
  return Math.max(min, Math.floor((Math.max(0, quota) * percent) / 100));
}

// The limit of the project's files and history together: Q + R.
export function projectQuotaGroupLimit(
  quota: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return quota + historyReserve(quota, env);
}

// The project's usage against its disk quota Q (see above).
export function effectiveQuotaUsage({
  files,
  total,
  reserve,
}: {
  // the home's
  files: number;
  // the group's: files and history
  total: number;
  reserve: number;
}): number {
  return Math.max(files, total - reserve);
}

// Puts the project's home and persist volume (those that exist) in its group,
// with the limit for its disk quota `quota` (Q, with any overrides); nothing
// to do if they are (unless `force`).
export async function syncProjectQuotaGroup({
  project_id,
  mount,
  home,
  history,
  quota,
  force = false,
  operation_id,
  operation_class,
  priority,
  env = process.env,
}: {
  project_id: string;
  mount: string;
  home: string;
  history?: string;
  quota: number;
  force?: boolean;
  operation_id?: string;
  operation_class?: string;
  priority?: BtrfsMutationPriority;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  if (btrfsQuotasDisabled()) return;
  if (
    !force &&
    (await projectQuotaGroupInSync({ project_id, home, history, quota, env }))
  ) {
    return;
  }
  await queueSyncQuotaGroup({
    mount,
    group: projectQuotaGroup(project_id),
    members: history ? [home, history] : [home],
    size: projectQuotaGroupLimit(quota, env),
    wait: true,
    project_id,
    operation_id,
    operation_class,
    priority,
  });
  invalidateBtrfsQgroupShowRaw(mount);
}

// Puts a home or persist volume the project gets (e.g., by a restore) in its
// group, at once (its limit is set by the project's next quota change).
export async function joinProjectQuotaGroup({
  project_id,
  mount,
  path,
}: {
  project_id: string;
  mount: string;
  path: string;
}): Promise<void> {
  if (btrfsQuotasDisabled()) return;
  await addToQuotaGroup({ mount, group: projectQuotaGroup(project_id), path });
  invalidateBtrfsQgroupShowRaw(mount);
}

// Destroys the quota groups of deleted projects: those with no members (the
// kernel drops a deleted subvolume from its groups once nothing uses its
// data).  Projects have only these level-1 groups; one destroyed while a
// project is just being added to it is made again by its next quota audit.
// The groups destroyed.
export async function deleteEmptyQuotaGroups({
  mount,
  limit = 1000,
}: {
  mount: string;
  limit?: number;
}): Promise<string[]> {
  if (btrfsQuotasDisabled()) return [];
  const { stdout } = await btrfs({
    args: ["qgroup", "show", "-prc", "--raw", mount],
    verbose: false,
  });
  const destroyed: string[] = [];
  for (const row of parseQgroupRelations(stdout)) {
    if (destroyed.length >= limit) break;
    if (!row.qgroupid.startsWith("1/") || row.children.length > 0) continue;
    if (row.referenced !== 0) continue;
    try {
      await destroyQuotaGroup({ mount, group: row.qgroupid });
      destroyed.push(row.qgroupid);
    } catch (err) {
      logger.warn("unable to destroy an empty project quota group", {
        group: row.qgroupid,
        err: `${err}`,
      });
    }
  }
  if (destroyed.length > 0) {
    invalidateBtrfsQgroupShowRaw(mount);
    logger.info("destroyed empty project quota groups", {
      count: destroyed.length,
    });
  }
  return destroyed;
}

export interface ProjectQuotaGroupState {
  // the group's usage (files and history) and limit (Q + R)
  total: number;
  limit?: number;
  // whether the subvolume at the path asked about is in the group, and its
  // own usage
  member: boolean;
  own: number;
}

// The group as seen from the subvolume at `path` (the home or persist volume);
// undefined if there is no group.
export async function readProjectQuotaGroup({
  project_id,
  path,
}: {
  project_id: string;
  path: string;
}): Promise<ProjectQuotaGroupState | undefined> {
  if (btrfsQuotasDisabled()) return;
  const group = projectQuotaGroup(project_id);
  const rows = parseQgroupRelations(
    (await cachedBtrfsQgroupShowRawForPath(path)).stdout,
  );
  const row = rows.find((r) => r.qgroupid === group);
  if (row == null) return;
  // (only the subvolume's own level 0 row, and the groups it is in)
  const own = rows.find((r) => r.qgroupid.startsWith("0/"));
  return {
    total: row.referenced,
    limit: row.max_referenced === "none" ? undefined : row.max_referenced,
    member: own?.parents.includes(group) ?? false,
    own: own?.referenced ?? 0,
  };
}

// Whether the project's group is as syncProjectQuotaGroup leaves it: with the
// home and persist volume (if any) in it, and its limit for `quota`.
export async function projectQuotaGroupInSync({
  project_id,
  home,
  history,
  quota,
  env = process.env,
}: {
  project_id: string;
  home: string;
  history?: string;
  quota: number;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  if (btrfsQuotasDisabled()) return true;
  const fromHome = await readProjectQuotaGroup({ project_id, path: home });
  if (
    !fromHome?.member ||
    fromHome.limit !== projectQuotaGroupLimit(quota, env)
  ) {
    return false;
  }
  if (history != null && (await exists(history))) {
    return !!(await readProjectQuotaGroup({ project_id, path: history }))
      ?.member;
  }
  return true;
}

// The usage of the project's files and history, split as well as btrfs can
// tell (see above).
export interface ProjectQuotaBreakdown {
  files_used?: number;
  history_used?: number;
  // R: what the history may use beyond the quota
  history_reserve?: number;
}

// A home's quota (as SubvolumeQuota.get gives it) as the project's: `used`
// counts its history too (effectiveQuotaUsage).  As it is without a group.
export async function projectQuotaWithHistory<
  T extends { size: number; used: number },
>({
  project_id,
  home,
  history,
  quota,
}: {
  project_id: string;
  home: string;
  history?: string;
  quota: T;
}): Promise<T & ProjectQuotaBreakdown> {
  if (btrfsQuotasDisabled() || !(quota.size > 0)) return quota;
  const group = await readProjectQuotaGroup({ project_id, path: home });
  if (!group?.member || group.limit == null) return quota;
  let history_used = 0;
  if (history != null && (await exists(history))) {
    const own = await readProjectQuotaGroup({ project_id, path: history });
    if (own?.member) history_used = own.own;
  }
  const reserve = Math.max(0, group.limit - quota.size);
  return {
    ...quota,
    used: effectiveQuotaUsage({
      files: quota.used,
      total: group.total,
      reserve,
    }),
    files_used: Math.max(0, group.total - history_used),
    history_used,
    history_reserve: reserve,
  };
}
