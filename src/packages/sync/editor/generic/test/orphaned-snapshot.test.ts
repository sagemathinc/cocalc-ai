/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
A document loads from its latest snapshot's seq onward, which also includes
the previous snapshot's record (written about one interval after its patch).
Without its parents or children that record looked like a second head, and
the document loaded a whole extra snapshot interval of history (on prod, after
a long gap between snapshots, ~29,500 patches instead of ~550).
*/

import { legacyPatchId } from "patchflow";
import { withoutOrphanedOlderSnapshots } from "../sync-doc";

const t = (i: number) => legacyPatchId(1000 + i);

describe("withoutOrphanedOlderSnapshots", () => {
  it("drops an older snapshot that nothing loaded builds on", () => {
    const patches = [
      { time: t(0), parents: [], isSnapshot: true, snapshot: "old" },
      { time: t(10), parents: [t(9)], isSnapshot: true, snapshot: "new" },
      { time: t(11), parents: [t(10)] },
      { time: t(12), parents: [t(11)] },
    ];
    expect(withoutOrphanedOlderSnapshots(patches).map((p) => p.time)).toEqual([
      t(10),
      t(11),
      t(12),
    ]);
  });

  it("keeps an older snapshot that a loaded patch builds on (full history)", () => {
    const patches = [
      { time: t(0), parents: [], isSnapshot: true, snapshot: "s0" },
      { time: t(1), parents: [t(0)] },
      { time: t(2), parents: [t(1)], isSnapshot: true, snapshot: "s2" },
      { time: t(3), parents: [t(2)] },
    ];
    expect(withoutOrphanedOlderSnapshots(patches)).toEqual(patches);
  });

  it("keeps ordinary patches older than the newest snapshot", () => {
    // e.g., a patch concurrent with the snapshotted one, appended later
    const patches = [
      { time: t(5), parents: [t(4)] },
      { time: t(10), parents: [t(9)], isSnapshot: true, snapshot: "new" },
      { time: t(11), parents: [t(10), t(5)] },
    ];
    expect(withoutOrphanedOlderSnapshots(patches)).toEqual(patches);
  });

  it("leaves a load without snapshots alone", () => {
    const patches = [
      { time: t(1), parents: [] },
      { time: t(2), parents: [t(1)] },
    ];
    expect(withoutOrphanedOlderSnapshots(patches)).toBe(patches);
  });
});
