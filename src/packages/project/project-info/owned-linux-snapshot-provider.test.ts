/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  collectDescendantsFromMap,
  staleRootIds,
} from "./owned-linux-snapshot-provider";

describe("owned linux snapshot helpers", () => {
  it("collects descendants from roots", () => {
    const childrenByPid = new Map<number, number[]>([
      [10, [11, 12]],
      [11, [13]],
      [12, []],
      [13, [14]],
      [14, []],
    ]);
    const pids = collectDescendantsFromMap({
      rootPids: [10],
      childrenByPid,
    });
    expect(Array.from(pids).sort((a, b) => a - b)).toEqual([
      10, 11, 12, 13, 14,
    ]);
  });

  it("enforces descendant traversal limit", () => {
    const childrenByPid = new Map<number, number[]>([
      [10, [11, 12]],
      [11, [13]],
      [12, [14]],
      [13, [15]],
      [14, [16]],
      [15, []],
      [16, []],
    ]);
    const pids = collectDescendantsFromMap({
      rootPids: [10],
      childrenByPid,
      limit: 4,
    });
    expect(pids.size).toBe(4);
    expect(pids.has(10)).toBe(true);
  });

  it("finds stale roots by pid", () => {
    const stale = staleRootIds({
      roots: [
        {
          root_id: "r1",
          kind: "terminal",
          pid: 100,
          spawned_at: 0,
        },
        {
          root_id: "r2",
          kind: "jupyter",
          pid: 200,
          spawned_at: 0,
        },
        {
          root_id: "r3",
          kind: "exec",
          spawned_at: 0,
        },
      ],
      alivePids: new Set([100]),
    });
    expect(stale).toEqual(["r2"]);
  });
});
