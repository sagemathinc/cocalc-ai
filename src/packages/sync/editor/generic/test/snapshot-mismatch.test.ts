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
import { snapshotTimeAvoidingMismatch } from "../sync-doc";

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
