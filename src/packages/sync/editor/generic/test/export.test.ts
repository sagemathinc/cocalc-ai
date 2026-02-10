/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { legacyPatchId } from "patchflow";
import { export_history } from "../export";

describe("export_history", () => {
  it("decodes patch-id timestamps into time_utc", () => {
    const t = Date.UTC(2025, 6, 9, 21, 23, 25);
    const entries = export_history(
      ["__filesystem__", "acct-1"],
      [{ time: legacyPatchId(t), userId: 1, patch: [] }],
      { patch_lengths: true, patches: false },
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].time_utc.getTime()).toBe(t);
    // JSON output should never contain null for time_utc.
    expect(JSON.parse(JSON.stringify(entries))[0].time_utc).not.toBeNull();
  });

  it("prefers wall time when present", () => {
    const patchIdTime = Date.UTC(2025, 0, 1, 0, 0, 0);
    const wallTime = Date.UTC(2026, 0, 1, 0, 0, 0);
    const entries = export_history(
      ["acct-0"],
      [{ time: legacyPatchId(patchIdTime), wall: wallTime, patch: [] }],
      {},
    );
    expect(entries[0].time_utc.getTime()).toBe(wallTime);
  });

  it("falls back to epoch for malformed time values", () => {
    const entries = export_history(
      ["acct-0"],
      [{ time: "not-a-patch-id", patch: [] }],
      {},
    );
    expect(entries[0].time_utc.getTime()).toBe(0);
  });
});

