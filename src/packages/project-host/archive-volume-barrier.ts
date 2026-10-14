/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { exists } from "@cocalc/backend/misc/async-utils-node";
import {
  getSubvolumeField,
  type Subvolume,
} from "@cocalc/file-server/btrfs/subvolume";
import {
  getGeneration,
  withSubvolumeQuotaRelief,
} from "@cocalc/file-server/btrfs/subvolume-snapshots";
import { btrfs, sudo } from "@cocalc/file-server/btrfs/util";
import { withBtrfsMutationLock } from "@cocalc/file-server/btrfs/operation-cache";
import { SNAPSHOTS } from "@cocalc/util/consts/snapshots";
import { assertValidSnapshotName } from "@cocalc/util/snapshot-name";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const ARCHIVE_SNAPSHOT_STAGING_DIR = ".archive-snapshot-staging";

function snapshotStagingRoot(volume: Subvolume): string {
  return join(
    volume.filesystem.opts.mount,
    ARCHIVE_SNAPSHOT_STAGING_DIR,
    volume.name,
  );
}

export async function listStagedArchiveVolumeNames(
  mount: string,
): Promise<string[]> {
  try {
    return (await readdir(join(mount, ARCHIVE_SNAPSHOT_STAGING_DIR))).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
}

async function stagedSnapshotNames(volume: Subvolume): Promise<string[]> {
  try {
    return (await readdir(snapshotStagingRoot(volume)))
      .map((name) => assertValidSnapshotName(name))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
}

async function removeSnapshotStagingRoot(
  volume: Subvolume,
  knownToExist: boolean,
): Promise<void> {
  const root = snapshotStagingRoot(volume);
  // The privileged storage wrapper resolves paths strictly before invoking
  // rm, so `rm -rf` is not itself idempotent for a missing staging root.
  if (!knownToExist && !(await exists(root))) return;
  await sudo({
    command: "rm",
    args: ["-rf", root],
  });
}

export async function isSubvolumeReadonly(path: string): Promise<boolean> {
  const { stdout } = await btrfs({
    args: ["property", "get", "-ts", path, "ro"],
    err_on_exit: true,
    verbose: false,
  });
  const match = `${stdout}`.match(/\bro\s*=\s*(true|false)\b/i);
  if (!match) {
    throw new Error(
      `unable to determine whether subvolume is read-only: ${path}`,
    );
  }
  return match[1].toLowerCase() === "true";
}

async function setSubvolumeReadonlyUnlocked(
  path: string,
  readOnly: boolean,
): Promise<void> {
  await btrfs({
    args: ["property", "set", "-ts", path, "ro", readOnly ? "true" : "false"],
    err_on_exit: true,
    verbose: false,
  });
}

export async function setSubvolumeReadonly(
  path: string,
  readOnly: boolean,
  mount: string,
): Promise<void> {
  await withBtrfsMutationLock({
    mount,
    operation: readOnly ? "archive-volume-freeze" : "archive-volume-unfreeze",
    run: async () => await setSubvolumeReadonlyUnlocked(path, readOnly),
  });
}

function normalizedUuid(value: string): string | undefined {
  const uuid = `${value}`.trim().toLowerCase();
  if (!uuid || uuid === "-" || uuid === "none") return;
  return uuid;
}

async function isReadonlySnapshotOf(
  child: string,
  parent: string,
): Promise<boolean> {
  if (!(await isSubvolumeReadonly(child))) return false;
  const [childParentUuid, parentUuid] = await Promise.all([
    getSubvolumeField(child, "Parent UUID", { cache: false }),
    getSubvolumeField(parent, "UUID", { cache: false }),
  ]);
  const expected = normalizedUuid(parentUuid);
  return expected != null && normalizedUuid(childParentUuid) === expected;
}

async function cloneReadonlySnapshot(
  source: string,
  destination: string,
): Promise<void> {
  await btrfs({
    args: ["subvolume", "snapshot", "-r", source, destination],
    err_on_exit: true,
    verbose: false,
  });
}

async function deleteSnapshot(path: string): Promise<void> {
  await btrfs({
    args: ["subvolume", "delete", path],
    err_on_exit: true,
    verbose: false,
  });
}

// Moving snapshots out of, or back into, the project's .snapshots directory
// changes the project subvolume's own tree, which Btrfs charges to the
// project's qgroup. An idle project due for archiving is often at or over its
// quota, and Btrfs then refuses with EDQUOT ("Disk quota exceeded"), so the
// project's limit is raised for the duration, as for any snapshot cleanup.
async function withProjectQuotaRelief<T>(
  volume: Subvolume,
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!(await exists(volume.path))) return await run();
  return await withSubvolumeQuotaRelief({ subvolume: volume, operation, run });
}

async function finishStagingSnapshot({
  source,
  destination,
  name,
}: {
  source: string;
  destination: string;
  name: string;
}): Promise<void> {
  if (await exists(destination)) {
    if (await isReadonlySnapshotOf(destination, source)) {
      // A prior staging attempt created the clone but did not delete source.
      await deleteSnapshot(source);
      return;
    }
    if (await isReadonlySnapshotOf(source, destination)) {
      // Rollback recreated source but did not delete staging. Complete that
      // rollback before starting a fresh staging operation.
      await deleteSnapshot(destination);
    } else {
      throw new Error(`archive snapshot staging collision: ${name}`);
    }
  }
  await cloneReadonlySnapshot(source, destination);
  await deleteSnapshot(source);
}

async function finishRestoringSnapshot({
  source,
  destination,
  name,
}: {
  source: string;
  destination: string;
  name: string;
}): Promise<void> {
  if (await exists(destination)) {
    if (
      (await isReadonlySnapshotOf(source, destination)) ||
      (await isReadonlySnapshotOf(destination, source))
    ) {
      // Either rollback created destination, or staging created source. In
      // both interrupted states destination is the copy we must retain.
      await deleteSnapshot(source);
      return;
    }
    throw new Error(`archive snapshot restore collision: ${name}`);
  }
  await cloneReadonlySnapshot(source, destination);
  await deleteSnapshot(source);
}

async function stageLocalSnapshotsUnlocked(volume: Subvolume): Promise<void> {
  const names = await volume.snapshots.readdir();
  if (!names.length) return;
  const root = snapshotStagingRoot(volume);
  await sudo({ command: "mkdir", args: ["-p", root] });
  for (const name of names) {
    const safeName = assertValidSnapshotName(name);
    const source = join(volume.path, SNAPSHOTS, safeName);
    const destination = join(root, safeName);
    await finishStagingSnapshot({ source, destination, name: safeName });
  }
}

async function restoreLocalSnapshotsUnlocked(volume: Subvolume): Promise<void> {
  const names = await stagedSnapshotNames(volume);
  if (names.length) {
    const snapshotsRoot = join(volume.path, SNAPSHOTS);
    await sudo({ command: "mkdir", args: ["-p", snapshotsRoot] });
    for (const name of names) {
      await finishRestoringSnapshot({
        source: join(snapshotStagingRoot(volume), name),
        destination: join(snapshotsRoot, name),
        name,
      });
    }
  }
  await removeSnapshotStagingRoot(volume, names.length > 0);
}

async function deleteStagedArchiveSnapshotsUnlocked(
  volume: Subvolume,
): Promise<void> {
  const names = await stagedSnapshotNames(volume);
  for (const name of names) {
    await deleteSnapshot(join(snapshotStagingRoot(volume), name));
  }
  await removeSnapshotStagingRoot(volume, names.length > 0);
}

export async function deleteStagedArchiveSnapshots(
  volume: Subvolume,
): Promise<void> {
  await withBtrfsMutationLock({
    mount: volume.filesystem.opts.mount,
    operation: "archive-staged-snapshot-delete",
    run: async () => await deleteStagedArchiveSnapshotsUnlocked(volume),
  });
}

export async function deleteOrphanedStagedArchiveSnapshots(
  volume: Subvolume,
): Promise<"deleted" | "retained"> {
  return await withBtrfsMutationLock({
    mount: volume.filesystem.opts.mount,
    operation: "archive-orphaned-staged-snapshot-delete",
    run: async () => {
      if (await exists(volume.path)) return "retained" as const;
      await deleteStagedArchiveSnapshotsUnlocked(volume);
      return "deleted" as const;
    },
  });
}

export interface ArchiveVolumeFreeze {
  alreadyReadonly: boolean;
}

/**
 * Clone local recovery snapshots outside the project subvolume, delete their
 * originals, then freeze the live source in the same Btrfs mutation critical
 * section. Btrfs cannot move a read-only subvolume to a different directory
 * level, so clone/delete is the crash-recoverable equivalent. Rustic excludes
 * these snapshots, and every abort path recreates them before making the
 * project usable again.
 */
export async function freezeVolumeForArchiveBackup(
  volume: Subvolume,
): Promise<ArchiveVolumeFreeze> {
  let alreadyReadonly = false;
  await withProjectQuotaRelief(volume, "archive-volume-freeze", async () => {
    await withBtrfsMutationLock({
      mount: volume.filesystem.opts.mount,
      operation: "archive-volume-freeze",
      run: async () => {
        if (await isSubvolumeReadonly(volume.path)) {
          alreadyReadonly = true;
          return;
        }
        await stageLocalSnapshotsUnlocked(volume);
        await setSubvolumeReadonlyUnlocked(volume.path, true);
      },
    });
  });
  return { alreadyReadonly };
}

export async function releaseArchiveVolumeFreeze(
  volume: Subvolume,
): Promise<"absent" | "already-writable" | "released"> {
  return await withProjectQuotaRelief(
    volume,
    "archive-volume-unfreeze",
    async () =>
      await withBtrfsMutationLock({
        mount: volume.filesystem.opts.mount,
        operation: "archive-volume-unfreeze",
        run: async () => {
          if (!(await exists(volume.path))) {
            await deleteStagedArchiveSnapshotsUnlocked(volume);
            return "absent" as const;
          }
          if (await isSubvolumeReadonly(volume.path)) {
            await setSubvolumeReadonlyUnlocked(volume.path, false);
            await restoreLocalSnapshotsUnlocked(volume);
            return "released" as const;
          }
          await restoreLocalSnapshotsUnlocked(volume);
          return "already-writable" as const;
        },
      }),
  );
}

export async function releaseArchiveVolumeFreezeIfGenerationMatches({
  volume,
  expectedGeneration,
}: {
  volume: Subvolume;
  expectedGeneration: number;
}): Promise<"absent" | "already-writable" | "released"> {
  return await withProjectQuotaRelief(
    volume,
    "archive-volume-unfreeze",
    async () =>
      await withBtrfsMutationLock({
        mount: volume.filesystem.opts.mount,
        operation: "archive-volume-unfreeze",
        run: async () => {
          if (!(await exists(volume.path))) {
            await deleteStagedArchiveSnapshotsUnlocked(volume);
            return "absent";
          }
          if (!(await isSubvolumeReadonly(volume.path))) {
            await restoreLocalSnapshotsUnlocked(volume);
            return "already-writable";
          }
          const generation = await getGeneration(volume.path, {
            cache: false,
          });
          if (generation !== expectedGeneration) {
            throw new Error(
              `refusing to release archive freeze at generation ${generation}; expected ${expectedGeneration}`,
            );
          }
          await setSubvolumeReadonlyUnlocked(volume.path, false);
          await restoreLocalSnapshotsUnlocked(volume);
          return "released";
        },
      }),
  );
}

export async function assertFrozenVolumeMatchesBackup({
  volume,
  expectedGeneration,
}: {
  volume: Subvolume;
  expectedGeneration: number;
}): Promise<"present" | "absent"> {
  if (!(await exists(volume.path))) return "absent";
  const generation = await getFrozenVolumeGeneration(volume);
  if (generation !== expectedGeneration) {
    throw new Error(
      `archive backup generation ${expectedGeneration} does not match frozen project volume generation ${generation}`,
    );
  }
  return "present";
}

export async function getFrozenVolumeGeneration(
  volume: Subvolume,
): Promise<number> {
  if (!(await isSubvolumeReadonly(volume.path))) {
    throw new Error("project volume is not frozen for archive deletion");
  }
  const generation = await getGeneration(volume.path, { cache: false });
  const nested = await volume.snapshots.readdir();
  if (nested.length) {
    throw new Error(
      "archive-frozen project volume contains unstaged local snapshots",
    );
  }
  return generation;
}
