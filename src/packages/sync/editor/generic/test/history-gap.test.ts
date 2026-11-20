/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
historyGap: what a snapshot made while patches still wait on history leaves
out. Patch ids and parents are chosen by whoever wrote a patch, so it must
terminate and count conservatively whatever they are.
*/

import { encodePatchId } from "patchflow";
import { historyGap } from "../sync-doc";

const id = (ms: number, client = "c") => encodePatchId(ms, client);

describe("historyGap", () => {
  it("finds a missing parent and the patches that build on it", () => {
    const a = id(1),
      b = id(2),
      lost = id(3, "x"),
      c = id(4),
      d = id(5);
    expect(
      historyGap([
        { time: a, parents: [] },
        { time: b, parents: [a] },
        { time: c, parents: [b, lost] },
        { time: d, parents: [c] },
      ]),
    ).toEqual({ missing: [lost], missingCount: 1, extraRoots: 0, affected: 2 });
  });

  it("nothing is left out of a complete history", () => {
    const a = id(1),
      b = id(2);
    expect(
      historyGap([
        { time: a, parents: [] },
        { time: b, parents: [a] },
      ]),
    ).toEqual({ missing: [], missingCount: 0, extraRoots: 0, affected: 0 });
  });

  it("counts a parentless patch other than the oldest, and what builds on it", () => {
    const a = id(1),
      b = id(2),
      r = id(3, "x"),
      c = id(4);
    expect(
      historyGap([
        { time: a, parents: [] },
        { time: b, parents: [a] },
        { time: r, parents: [] },
        { time: c, parents: [b, r] },
      ]),
    ).toEqual({ missing: [], missingCount: 0, extraRoots: 1, affected: 2 });
  });

  it("does not count a snapshot record as a root", () => {
    const a = id(1),
      b = id(2);
    expect(
      historyGap([
        { time: a, parents: [] },
        { time: b, parents: [a] },
        { time: b, is_snapshot: true },
      ]),
    ).toEqual({ missing: [], missingCount: 0, extraRoots: 0, affected: 0 });
  });

  it("terminates on a patch that is its own parent, and counts it", () => {
    const a = id(1),
      s = id(2);
    const gap = historyGap([
      { time: a, parents: [] },
      { time: s, parents: [s] },
    ]);
    expect(gap.affected).toBe(1);
    expect(gap.truncated).toBeUndefined();
  });

  it("terminates on a two-patch cycle with a missing parent elsewhere", () => {
    const a = id(1),
      b = id(2),
      x = id(3),
      y = id(4),
      lost = id(9, "z");
    const gap = historyGap([
      { time: a, parents: [y] },
      { time: b, parents: [a] },
      { time: x, parents: [lost] },
      { time: y, parents: [b] },
    ]);
    expect(gap.missing).toEqual([lost]);
    expect(gap.affected).toBe(4);
  });

  it("terminates quickly on a long cycle", () => {
    const n = 20_000;
    const times = Array.from({ length: n }, (_, i) => id(i + 1));
    const patches = times.map((time, i) => ({
      time,
      parents: [times[(i + 1) % n]],
    }));
    const t0 = Date.now();
    const gap = historyGap(patches);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(gap.affected).toBe(n);
  });

  it("stops at its work limit and then counts everything", () => {
    const times = Array.from({ length: 100 }, (_, i) => id(i + 1));
    const patches = times.map((time, i) => ({
      time,
      parents: i === 0 ? [] : [times[i - 1]],
    }));
    const gap = historyGap(patches, 10);
    expect(gap.truncated).toBe(true);
    expect(gap.affected).toBe(100);
  });

  it("charges every parent reference: one patch with 50,000 parents stops at the limit", () => {
    const a = id(1),
      b = id(2);
    const parents = Array.from({ length: 50_000 }, (_, i) => id(10 + i, "x"));
    const t0 = Date.now();
    const gap = historyGap(
      [
        { time: a, parents: [] },
        { time: b, parents },
      ],
      10,
    );
    expect(Date.now() - t0).toBeLessThan(500);
    expect(gap.truncated).toBe(true);
    expect(gap.affected).toBe(2);
    expect(gap.missing.length).toBeLessThanOrEqual(20);
  });

  it("keeps at most 20 missing ids and counts them all", () => {
    const a = id(1),
      b = id(2);
    const parents = Array.from({ length: 30 }, (_, i) => id(10 + i, "x"));
    const gap = historyGap([
      { time: a, parents: [] },
      { time: b, parents },
    ]);
    expect(gap.truncated).toBeUndefined();
    expect(gap.missing).toHaveLength(20);
    expect(gap.missingCount).toBe(30);
    // the reported ids are distinct and in order
    expect(new Set(gap.missing).size).toBe(20);
    expect(gap.affected).toBe(1);
  });

  it("reads none of a huge parent list past the limit", () => {
    const a = id(1),
      b = id(2);
    const raw = Array.from({ length: 50_000 }, (_, i) => id(10 + i, "x"));
    let reads = 0;
    const parents = new Proxy(raw, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^[0-9]+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    const gap = historyGap(
      [
        { time: a, parents: [] },
        { time: b, parents },
      ],
      10,
    );
    expect(gap.truncated).toBe(true);
    expect(reads).toBe(0);
  });

  it("reports at most 64 characters of each missing id", () => {
    const a = id(1),
      b = id(2);
    const long = "z".repeat(1_000_000);
    const gap = historyGap([
      { time: a, parents: [] },
      { time: b, parents: [long] },
    ]);
    expect(gap.missingCount).toBe(1);
    expect(gap.missing[0].length).toBeLessThan(100);
    expect(gap.missing[0]).toContain("1000000 chars");
  });

  it("counts each reference to a missing parent, and reports the id once", () => {
    const a = id(1),
      b = id(2),
      c = id(3),
      lost = id(9, "x");
    const gap = historyGap([
      { time: a, parents: [] },
      { time: b, parents: [a, lost] },
      { time: c, parents: [b, lost] },
    ]);
    expect(gap.missing).toEqual([lost]);
    expect(gap.missingCount).toBe(2);
    expect(gap.affected).toBe(2);
  });

  it("keeps at most 20 missing ids in memory, however many there are", () => {
    const a = id(1),
      b = id(2);
    const parents = Array.from({ length: 5_000 }, (_, i) => id(10 + i, "x"));
    const missing = new Set(parents);
    let stored = 0;
    const add = Set.prototype.add;
    Set.prototype.add = function (this: Set<unknown>, v: unknown) {
      if (missing.has(v as string)) stored++;
      return add.call(this, v);
    } as typeof Set.prototype.add;
    try {
      historyGap([
        { time: a, parents: [] },
        { time: b, parents },
      ]);
    } finally {
      Set.prototype.add = add;
    }
    // (the test's own Set above was built before the spy)
    expect(stored).toBeLessThanOrEqual(20);
  });
});
