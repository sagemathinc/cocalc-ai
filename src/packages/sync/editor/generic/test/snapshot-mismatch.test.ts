/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
One patch whose value differs from the hash its author recorded used to stop
snapshots of a document for good: snapshot() refuses it, and every client picks
the same candidate.  Agent chats then grew to tens of thousands of patches,
all loaded on every open.
*/

import { legacyPatchId } from "patchflow";
import {
  snapshotCandidateFromHistory,
  snapshotTimeAvoidingMismatch,
} from "../sync-doc";

function session({
  times,
  mismatch,
  cuts,
}: {
  times: string[];
  mismatch: Set<string>;
  cuts?: Set<string>;
}) {
  return {
    history: () => times.map((time) => ({ time })),
    verifyValue: jest.fn((time: string) =>
      mismatch.has(time) ? "mismatch" : "ok",
    ),
    isCut: cuts == null ? undefined : (time: string) => cuts.has(time),
  };
}

const t = (i: number) => legacyPatchId(1000 + i);
const times = Array.from({ length: 10 }, (_, i) => t(i));

describe("snapshotTimeAvoidingMismatch", () => {
  it("keeps a candidate whose value matches", () => {
    const s = session({ times, mismatch: new Set() });
    expect(snapshotTimeAvoidingMismatch(s, t(3))).toBe(t(3));
  });

  it("moves past a mismatched candidate to the next usable cut", () => {
    const s = session({
      times,
      mismatch: new Set([t(3), t(4)]),
      cuts: new Set([t(6)]),
    });
    expect(snapshotTimeAvoidingMismatch(s, t(3))).toBe(t(6));
  });

  it("uses the first matching patch when there is no clean cut", () => {
    const s = session({
      times,
      mismatch: new Set([t(3)]),
      cuts: new Set(),
    });
    expect(snapshotTimeAvoidingMismatch(s, t(3))).toBe(t(4));
  });

  it("never picks the newest patch, nor a mismatched one", () => {
    const s = session({
      times,
      mismatch: new Set(times.slice(3, 9)),
    });
    expect(snapshotTimeAvoidingMismatch(s, t(3))).toBeUndefined();
  });

  it("stops scanning after maxScan patches", () => {
    const s = session({ times, mismatch: new Set(times.slice(3, 7)) });
    expect(snapshotTimeAvoidingMismatch(s, t(3), 2)).toBeUndefined();
    expect(snapshotTimeAvoidingMismatch(s, t(3), 5)).toBe(t(7));
  });
});

describe("snapshotCandidateFromHistory", () => {
  const history = (n: number, snapshotAt?: number) =>
    Array.from({ length: n }, (_, i) => ({
      time: t(i),
      isSnapshot: i === snapshotAt,
    }));
  const index = (time: string | undefined) =>
    time == null ? undefined : times20.indexOf(time);
  const times20 = Array.from({ length: 2000 }, (_, i) => t(i));

  it("snapshots one interval after the last snapshot normally", () => {
    const time = snapshotCandidateFromHistory({
      history: history(25, 0),
      interval: 10,
      maxSize: 1e12,
    });
    expect(index(time)).toBe(10);
  });

  it("far behind, snapshots one full interval before the newest patch", () => {
    const time = snapshotCandidateFromHistory({
      history: history(1000, 0),
      interval: 10,
      maxSize: 1e12,
    });
    // ten patches after it, as after any snapshot
    expect(index(time)).toBe(1000 - 10 - 1);
  });

  it("never picks the newest patch, even with interval 1 and no clean cut", () => {
    for (const n of [4, 5, 50]) {
      const time = snapshotCandidateFromHistory({
        history: history(n, 0),
        interval: 1,
        maxSize: 1e12,
        isCut: () => false,
      });
      expect(time).toBeDefined();
      expect(index(time)).toBeLessThan(n - 1);
    }
  });

  it("treats an invalid interval as 1", () => {
    for (const interval of [0, -5, NaN]) {
      const time = snapshotCandidateFromHistory({
        history: history(10, 0),
        interval,
        maxSize: 1e12,
        isCut: () => false,
      });
      expect(index(time)).toBe(10 - 1 - 1);
    }
  });

  it("prefers a nearby clean cut", () => {
    const time = snapshotCandidateFromHistory({
      history: history(1000, 0),
      interval: 10,
      maxSize: 1e12,
      isCut: (time) => time === t(985),
    });
    expect(index(time)).toBe(985);
  });
});
