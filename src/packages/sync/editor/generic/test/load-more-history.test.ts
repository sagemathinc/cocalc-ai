/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { legacyPatchId } from "patchflow";
import { prevSeqForMoreHistoryFromHistory } from "../sync-doc";

describe("prevSeqForMoreHistoryFromHistory", () => {
  it("uses the prevSeq from the oldest visible snapshot", () => {
    expect(
      prevSeqForMoreHistoryFromHistory([
        {
          time: legacyPatchId(200),
          isSnapshot: true,
          seqInfo: { prevSeq: 40 },
        },
        {
          time: legacyPatchId(300),
          isSnapshot: true,
          seqInfo: { prevSeq: 90 },
        },
      ]),
    ).toBe(40);
  });

  it("falls back to loading from the start when no snapshot cursor is visible", () => {
    expect(
      prevSeqForMoreHistoryFromHistory([
        { time: legacyPatchId(200) },
        { time: legacyPatchId(300) },
      ]),
    ).toBe(0);
  });

  it("returns undefined when there is no loaded history", () => {
    expect(prevSeqForMoreHistoryFromHistory([])).toBeUndefined();
  });
});
