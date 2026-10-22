/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Adds data to a snapshot of a subvolume while it is still writable, before it
is made read-only: the project-host puts a copy of a project's edit history
(its persist volume) in every snapshot and backup of the project's home, so
restoring them restores the history with the files
(project-host/persist-volume.ts).

The data is captured BEFORE the subvolume is snapshotted: when the history is
older than the files, a restore reconciles the newer files into it, while
history newer than the files would bring back later edits.
*/

export interface CapturedSnapshotData {
  // adds the captured data to a writable snapshot
  addTo: (snapshotPath: string) => Promise<void>;
  // deletes what was captured
  release: () => Promise<void>;
}

export interface SnapshotPreparer {
  appliesTo: (subvolume: string) => boolean;
  // undefined if there is nothing to add
  capture: (opts: {
    subvolume: string;
    // a free path for the capture, if the caller cleans up leftovers there
    stagingPath?: string;
  }) => Promise<CapturedSnapshotData | undefined>;
}

let snapshotPreparer: SnapshotPreparer | undefined;

export function setSnapshotPreparer(
  preparer: SnapshotPreparer | undefined,
): void {
  snapshotPreparer = preparer;
}

// What to add to a snapshot of `subvolume`, captured now, before it is taken.
export async function captureSnapshotData(opts: {
  subvolume: string;
  stagingPath?: string;
}): Promise<CapturedSnapshotData | undefined> {
  if (!snapshotPreparer?.appliesTo(opts.subvolume)) return;
  return await snapshotPreparer.capture(opts);
}
