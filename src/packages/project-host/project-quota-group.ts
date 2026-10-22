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
  getQgroupScan,
  invalidateQgroupScan,
  lookupQgroup,
  noteQgroupGroup,
} from "@cocalc/file-server/btrfs/qgroup-scan";
import { cachedBtrfsSubvolumeShow } from "@cocalc/file-server/btrfs/operation-cache";
import {
  addToQuotaGroup,
  destroyQuotaGroup,
} from "@cocalc/file-server/btrfs/quota-group";
import { queueSyncQuotaGroup } from "@cocalc/file-server/btrfs/quota-queue";
import type { BtrfsMutationPriority } from "@cocalc/file-server/btrfs/mutation-context";
import { btrfsQuotasDisabled } from "@cocalc/file-server/btrfs/config";
import { refusedByStorageWrapper } from "@cocalc/file-server/btrfs/util";
import { exists } from "@cocalc/backend/misc/async-utils-node";
import getLogger from "@cocalc/backend/logger";
import { isValidUUID } from "@cocalc/util/misc";
import { randomInt } from "node:crypto";
import { dirname } from "node:path";

const logger = getLogger("project-host:project-quota-group");

const MiB = 1024 * 1024;

// A host whose root helper predates quota groups refuses them (its policy is
// installed by the host's bootstrap, server/cloud/bootstrap/bootstrap.py
// check_qgroup_args, updated by a reconcile of the host).  Then each project
// keeps the separate limits of its home and persist volume, and quota groups
// are tried again after a while.
const REFUSED_RETRY_MS = 60 * 60_000;
let refusedUntil = 0;

function refused(): boolean {
  return Date.now() < refusedUntil;
}

async function unlessRefused<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (refusedByStorageWrapper(err)) {
      if (!refused()) {
        logger.warn(
          "this host's root helper refuses project quota groups: files and edit history keep separate limits until the host's bootstrap is updated",
          { retry_in_ms: REFUSED_RETRY_MS, err: `${err}` },
        );
      }
      refusedUntil = Date.now() + REFUSED_RETRY_MS;
    }
    throw err;
  }
}

// Whether this host's root helper allows quota groups: asks to destroy a group
// that doesn't exist, which btrfs refuses harmlessly (an older helper refuses
// it by its policy).
export async function projectQuotaGroupsPermitted(
  mount: string,
): Promise<boolean> {
  if (btrfsQuotasDisabled()) return false;
  try {
    await unlessRefused(
      async () =>
        await destroyQuotaGroup({ mount, group: `1/${randomInt(1, 2 ** 47)}` }),
    );
  } catch {
    return !refused();
  }
  return true;
}

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
  if (btrfsQuotasDisabled() || refused()) return;
  if (
    !force &&
    (await projectQuotaGroupInSync({ project_id, home, history, quota, env }))
  ) {
    return;
  }
  const group = projectQuotaGroup(project_id);
  const size = projectQuotaGroupLimit(quota, env);
  await unlessRefused(async () => {
    await queueSyncQuotaGroup({
      mount,
      group,
      members: history ? [home, history] : [home],
      size,
      wait: true,
      project_id,
      operation_id,
      operation_class,
      priority,
    });
  });
  // what's read of the filesystem's quotas says so too, rather than being
  // read again (one project after another, e.g., when they all join)
  const members = [home];
  if (history != null && (await exists(history))) members.push(history);
  noteQgroupGroup({ mount, group, members, size });
}

// Puts a home or persist volume the project gets (e.g., by a restore) in its
// group, at once (its limit is set by the project's next quota change).
//
// With `required` (a volume that writes data the project keeps, which btrfs
// charges to it for good), it is put there whenever quotas are on: tried even
// while this host's root helper is thought to refuse groups, and a refusal is
// thrown, never skipped.
export async function joinProjectQuotaGroup({
  project_id,
  mount,
  path,
  required = false,
}: {
  project_id: string;
  mount: string;
  path: string;
  required?: boolean;
}): Promise<void> {
  if (btrfsQuotasDisabled() || (refused() && !required)) return;
  const group = projectQuotaGroup(project_id);
  await unlessRefused(
    async () => await addToQuotaGroup({ mount, group, path }),
  );
  noteQgroupGroup({ mount, group, members: [path] });
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
  if (btrfsQuotasDisabled() || refused()) return [];
  const destroyed: string[] = [];
  for (const row of (await getQgroupScan(mount)).rows.values()) {
    if (destroyed.length >= limit) break;
    if (!row.qgroupid.startsWith("1/") || row.children.length > 0) continue;
    if (row.referenced !== 0) continue;
    try {
      await unlessRefused(
        async () => await destroyQuotaGroup({ mount, group: row.qgroupid }),
      );
      destroyed.push(row.qgroupid);
    } catch (err) {
      if (refused()) break;
      logger.warn("unable to destroy an empty project quota group", {
        group: row.qgroupid,
        err: `${err}`,
      });
    }
  }
  if (destroyed.length > 0) {
    invalidateQgroupScan(mount);
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
  // (one read of the filesystem's quotas, shared: qgroup-scan.ts)
  const found = await lookupQgroup({
    mount: dirname(path),
    path,
    getSubvolumeId: async () => {
      const { stdout } = await cachedBtrfsSubvolumeShow(path);
      const id = Number(stdout.match(/^\s*Subvolume ID:\s*(\d+)/m)?.[1]);
      if (!Number.isSafeInteger(id)) {
        throw new Error(`no subvolume id for ${path}`);
      }
      return id;
    },
  });
  const row = found?.parents.find((r) => r.qgroupid === group);
  if (found == null || row == null) return;
  return {
    total: row.referenced,
    limit: row.max_referenced === "none" ? undefined : row.max_referenced,
    member: true,
    own: found.row.referenced,
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
  // (nothing to repair while the host refuses quota groups)
  if (btrfsQuotasDisabled() || refused()) return true;
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
  env = process.env,
}: {
  project_id: string;
  home: string;
  history?: string;
  quota: T;
  env?: NodeJS.ProcessEnv;
}): Promise<T & ProjectQuotaBreakdown> {
  if (btrfsQuotasDisabled() || !(quota.size > 0)) return quota;
  const group = await readProjectQuotaGroup({ project_id, path: home });
  if (!group?.member || group.limit == null) return quota;
  let history_used = 0;
  if (history != null && (await exists(history))) {
    const own = await readProjectQuotaGroup({ project_id, path: history });
    if (own?.member) history_used = own.own;
  }
  // R: what the group's limit leaves beyond the quota, but never more than
  // the configured reserve (the group's limit may not have followed a lower
  // quota yet, e.g., its update deferred): never less usage than it is
  const reserve = Math.max(
    0,
    Math.min(group.limit - quota.size, historyReserve(quota.size, env)),
  );
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
