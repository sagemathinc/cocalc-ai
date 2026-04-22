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

export async function updateRollingSnapshots({
  snapshots,
  counts,
  opts,
}: {
  snapshots: SubvolumeSnapshots | SubvolumeRustic;
  counts?: Partial<SnapshotCounts>;
  // options to create
  opts?;
}) {
  if (btrfsRollingSnapshotsDisabled()) {
    if (!loggedRollingSnapshotsDisabled) {
      loggedRollingSnapshotsDisabled = true;
      logger.warn("rolling btrfs snapshots disabled by configuration");
    }
    return;
  }
  counts = { ...DEFAULT_SNAPSHOT_COUNTS, ...counts };

  const changed = await snapshots.hasUnsavedChanges();
  logger.debug("updateRollingSnapshots", {
    name: snapshots.subvolume.name,
    counts,
    changed,
  });

  const allSnapshotNames = await snapshots.readdir();
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
      if (counts[key] && timeSinceLastSnapshot > SNAPSHOT_INTERVALS_MS[key]) {
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
  if (changed && needNewSnapshot) {
    // make a new snapshot -- but only bother
    // definitely no data written since most recent snapshot, so nothing to do
    const name = new Date().toISOString();
    logger.debug(
      "updateRollingSnapshots: creating snapshot of",
      snapshots.subvolume.name,
    );
    try {
      await snapshots.create(name, opts);
      snapshotNames.push(name);
    } catch (err) {
      createError = err;
    }
  }

  // delete extra snapshots
  const toDelete = [
    ...snapshotsToDelete({ counts, snapshots: snapshotNames }),
    ...tempRusticSnapshotsToDelete(allSnapshotNames),
  ];
  let deleteError: any = undefined;
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

  if (createError) {
    throw createError;
  }
  if (deleteError) {
    throw deleteError;
  }
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
