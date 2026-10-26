import { type SubvolumeSnapshots } from "./subvolume-snapshots";
import { type SubvolumeRustic } from "./subvolume-rustic";
import {
  SNAPSHOT_INTERVALS_MS,
  DEFAULT_SNAPSHOT_COUNTS,
  type SnapshotCounts,
} from "@cocalc/util/consts/snapshots";
import getLogger from "@cocalc/backend/logger";
import { isISODate } from "@cocalc/util/misc";
import { btrfsRollingSnapshotsDisabled } from "./config";

export { type SnapshotCounts };

const logger = getLogger("file-server:btrfs:snapshots");
let loggedRollingSnapshotsDisabled = false;
export const TEMP_RUSTIC_SNAPSHOT_PREFIX = "temp-rustic-snapshot";
const STALE_TEMP_RUSTIC_SNAPSHOT_MS = 24 * 60 * 60 * 1000;

// Thrown from create when the caller can no longer vouch for the volume (for
// example it was deleted or frozen for archival while a backup uploaded).
// Retention is skipped: deleting old recovery points needs the same authority.
export class RollingSnapshotRetentionSkipped extends Error {
  constructor(public readonly reason: string) {
    super(`rolling snapshot retention skipped: ${reason}`);
    this.name = "RollingSnapshotRetentionSkipped";
  }
}

export interface RollingSnapshotUpdateResult {
  changed: boolean | null;
  createdName: string | null;
  disabled: boolean;
  /** Expired snapshots kept because beforePrune declined; a later update
   * deletes them. */
  pruneDeferred?: number;
}

export type RollingSnapshotStage =
  | "inventory"
  | "change_detection"
  | "create"
  | "prune";

export type RollingSnapshotStageObserver = (
  stage: RollingSnapshotStage,
  durationMs: number,
) => void;

export async function updateRollingSnapshots({
  snapshots,
  counts,
  opts,
}: {
  snapshots: SubvolumeSnapshots | SubvolumeRustic;
  counts?: Partial<SnapshotCounts>;
  // options to create
  opts?: {
    beforeCreate?: () => Promise<void>;
    afterCreate?: (created: unknown) => Promise<void>;
    onStage?: RollingSnapshotStageObserver;
    /** Asked before expired snapshots are deleted. Deleting is only space
     * reclamation, so a caller may decline (return false) when it would
     * compete with more urgent I/O; the snapshots stay until a later update
     * is allowed to delete them. */
    beforePrune?: (names: string[]) => boolean | Promise<boolean>;
    [key: string]: unknown;
  };
}): Promise<RollingSnapshotUpdateResult> {
  const timed = async <T>(
    stage: RollingSnapshotStage,
    run: () => Promise<T>,
  ): Promise<T> => {
    const started = Date.now();
    try {
      return await run();
    } finally {
      try {
        opts?.onStage?.(stage, Math.max(0, Date.now() - started));
      } catch (err) {
        logger.warn("rolling snapshot stage observer failed", { stage, err });
      }
    }
  };
  if (btrfsRollingSnapshotsDisabled()) {
    if (!loggedRollingSnapshotsDisabled) {
      loggedRollingSnapshotsDisabled = true;
      logger.warn("rolling btrfs snapshots disabled by configuration");
    }
    return { changed: null, createdName: null, disabled: true };
  }
  counts = { ...DEFAULT_SNAPSHOT_COUNTS, ...counts };

  // Snapshot discovery can require one targeted Btrfs metadata command per
  // retained snapshot. Reuse one inventory throughout the rolling update
  // instead of listing again for change detection and the create limit.
  const allSnapshotNames = await timed("inventory", () => snapshots.readdir());
  const changed = await timed("change_detection", () =>
    snapshots.hasUnsavedChanges(allSnapshotNames),
  );
  logger.debug("updateRollingSnapshots", {
    name: snapshots.subvolume.name,
    counts,
    changed,
  });

  // get exactly the iso timestamp snapshot names:
  const snapshotNames = allSnapshotNames.filter(isISODate);
  snapshotNames.sort();
  let needNewSnapshot = false;
  if (changed) {
    const timeSinceLastSnapshot =
      snapshotNames.length == 0
        ? 1e12 // infinitely old
        : Date.now() - new Date(snapshotNames.slice(-1)[0]).valueOf();
    for (const key in SNAPSHOT_INTERVALS_MS) {
      if (counts[key] && timeSinceLastSnapshot >= SNAPSHOT_INTERVALS_MS[key]) {
        // there is NOT a sufficiently recent snapshot to satisfy the constraint
        // of having at least one snapshot for the given interval.
        needNewSnapshot = true;
        break;
      }
    }
  }

  // Regarding error reporting we try to do everything below and throw the
  // create error or last delete error...

  let createError: any = undefined;
  let createdName: string | null = null;
  if (changed && needNewSnapshot) {
    // make a new snapshot -- but only bother
    // definitely no data written since most recent snapshot, so nothing to do
    const name = new Date().toISOString();
    logger.debug(
      "updateRollingSnapshots: creating snapshot of",
      snapshots.subvolume.name,
    );
    try {
      await timed("create", async () => {
        const {
          beforeCreate,
          afterCreate,
          onStage: _onStage,
          beforePrune: _beforePrune,
          ...createOpts
        } = opts ?? {};
        await beforeCreate?.();
        const created = await snapshots.create(name, {
          ...createOpts,
          existingSnapshotNames: allSnapshotNames,
        });
        await afterCreate?.(created);
      });
      snapshotNames.push(name);
      createdName = name;
    } catch (err) {
      if (err instanceof RollingSnapshotRetentionSkipped) throw err;
      createError = err;
    }
  }

  // delete extra snapshots
  const toDelete = expiredSnapshotNames({
    counts,
    allSnapshotNames,
    snapshotNames,
  });
  let deleteError: any = undefined;
  // After a failed create, prune as before: the error is thrown below, so a
  // deferral could not be reported and would be lost.
  if (toDelete.length > 0 && opts?.beforePrune && !createError) {
    let allowed = true;
    try {
      allowed = await opts.beforePrune(toDelete);
    } catch (err) {
      // A failing gate must not stop retention for good.
      logger.warn("rolling snapshot prune gate failed; pruning", { err });
    }
    if (!allowed) {
      return {
        changed,
        createdName,
        disabled: false,
        pruneDeferred: toDelete.length,
      };
    }
  }
  await timed("prune", async () => {
    for (const name of toDelete) {
      try {
        logger.debug(
          "updateRollingSnapshots: deleting snapshot of",
          snapshots.subvolume.name,
          name,
        );
        await snapshots.delete(name);
      } catch (err) {
        // ONLY report this if create doesn't error, to give both delete and create a chance to run.
        deleteError = err;
      }
    }
  });

  if (createError) {
    throw createError;
  }
  if (deleteError) {
    throw deleteError;
  }
  return { changed, createdName, disabled: false };
}

/** The rolling snapshots retention no longer keeps, plus stale temporary
 * rustic snapshots. */
function expiredSnapshotNames({
  counts,
  allSnapshotNames,
  snapshotNames = allSnapshotNames.filter(isISODate).sort(),
}: {
  counts: Partial<SnapshotCounts>;
  allSnapshotNames: string[];
  snapshotNames?: string[];
}): string[] {
  return [
    ...snapshotsToDelete({ counts, snapshots: snapshotNames }),
    ...tempRusticSnapshotsToDelete(allSnapshotNames),
  ];
}

/** Delete only the expired rolling snapshots (no new snapshot), for a prune
 * that was deferred by beforePrune. Returns how many were deleted; throws
 * the last delete error after trying all of them. */
export async function pruneRollingSnapshots({
  snapshots,
  counts,
}: {
  snapshots: Pick<SubvolumeSnapshots, "readdir" | "delete">;
  counts?: Partial<SnapshotCounts>;
}): Promise<number> {
  if (btrfsRollingSnapshotsDisabled()) return 0;
  const toDelete = expiredSnapshotNames({
    counts: { ...DEFAULT_SNAPSHOT_COUNTS, ...counts },
    allSnapshotNames: await snapshots.readdir(),
  });
  let deleted = 0;
  let deleteError: unknown = undefined;
  for (const name of toDelete) {
    try {
      await snapshots.delete(name);
      deleted += 1;
    } catch (err) {
      deleteError = err;
    }
  }
  if (deleteError) throw deleteError;
  return deleted;
}

export function snapshotsToDelete({
  counts,
  snapshots,
  now = Date.now(),
}: {
  counts: Partial<SnapshotCounts>;
  snapshots: string[];
  now?: number;
}): string[] {
  if (snapshots.length == 0) {
    // nothing to do
    return [];
  }

  const entries = snapshots
    .map((name) => ({ name, time: new Date(name).valueOf() }))
    .filter(({ time }) => Number.isFinite(time))
    .sort((a, b) => b.time - a.time);
  const save = new Set<number>();
  const hasPositiveRetentionCount = Object.values(counts).some(
    (count) => Number(count) > 0,
  );
  // Always retain the newest snapshot. Longer retention buckets intentionally
  // choose the oldest snapshot in each age bucket, which lets a daily snapshot
  // survive long enough to become a weekly/monthly snapshot.
  if (hasPositiveRetentionCount && entries[0] != null) {
    save.add(entries[0].time);
  }
  for (const type in counts) {
    const count = counts[type];
    const length_ms = SNAPSHOT_INTERVALS_MS[type];
    if (!count || !length_ms) continue;

    for (let bucket = 0; bucket < count; bucket++) {
      const minAge = bucket * length_ms;
      const maxAge = (bucket + 1) * length_ms;
      let candidate: number | undefined;
      for (const { time } of entries) {
        const age = now - time;
        if (age < minAge || age >= maxAge) continue;
        if (candidate == null || time < candidate) {
          candidate = time;
        }
      }
      if (candidate != null) {
        save.add(candidate);
      }
    }
  }
  return snapshots.filter((x) => !save.has(new Date(x).valueOf()));
}

function tempRusticSnapshotsToDelete(
  snapshots: string[],
  now = Date.now(),
): string[] {
  return snapshots.filter((name) => {
    const created = tempRusticSnapshotCreatedAt(name);
    return created != null && now - created > STALE_TEMP_RUSTIC_SNAPSHOT_MS;
  });
}

function tempRusticSnapshotCreatedAt(name: string): number | undefined {
  if (!name.startsWith(`${TEMP_RUSTIC_SNAPSHOT_PREFIX}-`)) {
    return;
  }
  const rest = name.slice(TEMP_RUSTIC_SNAPSHOT_PREFIX.length + 1);
  const encodedTime = rest.split("-")[0];
  const time = parseInt(encodedTime, 36);
  return Number.isFinite(time) ? time : undefined;
}
