/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { __test__ } from "./event-loop-stalls";

describe("event loop stall GC summaries", () => {
  it("summarizes recent GC activity around a stall window", () => {
    const summary = __test__.summarizeGcEvents(
      [
        {
          ended_at_ms: 1_000,
          duration_ms: 5.2,
          kind: "minor",
        },
        {
          ended_at_ms: 27_000,
          duration_ms: 19.6,
          kind: "major",
        },
        {
          ended_at_ms: 29_500,
          duration_ms: 7.4,
          kind: "weakcb",
        },
      ],
      30_000,
    );
    expect(summary).toEqual({
      last_gc_kind: "weakcb",
      last_gc_duration_ms: 7,
      last_gc_ago_ms: 500,
      gc_total_ms_5s: 27,
      gc_total_ms_30s: 32,
      gc_major_count_30s: 1,
    });
  });

  it("drops GC events that are outside the retained window", () => {
    const summary = __test__.summarizeGcEvents(
      [
        {
          ended_at_ms: 100,
          duration_ms: 50,
          kind: "major",
        },
      ],
      30_500,
    );
    expect(summary).toEqual({});
  });

  it("maps known GC kinds to stable labels", () => {
    expect(__test__.gcKindName(4)).toBe("major");
    expect(__test__.gcKindName(1)).toBe("minor");
    expect(__test__.gcKindName(8)).toBe("incremental");
    expect(__test__.gcKindName(16)).toBe("weakcb");
    expect(__test__.gcKindName(999)).toBe("unknown");
  });
});
