/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
A parent that is not in the stream (see missing-parent.test.ts) stops
snapshots of a document for good: snapshots wait while patchflow needs more
history, and that parent never arrives, so every open loads all the patches
since the last snapshot. patchesMissingFromStream finds such parents and the
patch each can only have been made on, for the repair.
*/

import { encodePatchId } from "patchflow";
import { patchesMissingFromStream } from "../sync-doc";

const id = (ms: number, client: string) => encodePatchId(ms, client);

describe("patchesMissingFromStream", () => {
  it("finds a parent whose author has an older loaded patch, and the author's patch before it", () => {
    const a1 = id(1000, "clientA");
    const a2 = id(1001, "clientA");
    const lost = id(1005, "clientA");
    const b1 = id(1006, "clientB");
    const b2 = id(1007, "clientB");
    const patches = [
      { time: a1, parents: [], user_id: 3 },
      { time: a2, parents: [a1], user_id: 3 },
      { time: b1, parents: [lost], user_id: 4 },
      { time: b2, parents: [b1, lost], user_id: 4 },
    ];
    expect(patchesMissingFromStream(patches)).toEqual([
      { missing: lost, child: b1, before: a2, beforeUserId: 3 },
    ]);
  });

  it("does not claim a parent whose author has no older loaded patch (older history may hold it)", () => {
    const lost = id(1005, "clientA");
    const a9 = id(1009, "clientA");
    const b1 = id(1006, "clientB");
    expect(
      patchesMissingFromStream([
        { time: b1, parents: [lost] },
        { time: a9, parents: [b1] },
      ]),
    ).toEqual([]);
  });

  it("ignores loaded parents, snapshot records without a patch, and legacy ids", () => {
    const a1 = id(1000, "clientA");
    const b1 = id(1006, "clientB");
    expect(
      patchesMissingFromStream([
        { time: a1, parents: [] },
        { time: b1, parents: [a1] },
      ]),
    ).toEqual([]);
    // a snapshot record of clientA does not count as its older patch
    const lost = id(1005, "clientA");
    expect(
      patchesMissingFromStream([
        { time: id(1000, "clientA"), is_snapshot: true },
        { time: b1, parents: [lost] },
      ]),
    ).toEqual([]);
  });

  it("names the oldest child once per missing parent", () => {
    const a1 = id(1000, "clientA");
    const lost = id(1005, "clientA");
    const c2 = id(1008, "clientC");
    const b1 = id(1006, "clientB");
    const got = patchesMissingFromStream([
      { time: a1, parents: [] },
      { time: c2, parents: [lost] },
      { time: b1, parents: [lost] },
    ]);
    expect(got).toHaveLength(1);
    expect(got[0].child).toBe(b1);
    expect(got[0].before).toBe(a1);
  });
});
