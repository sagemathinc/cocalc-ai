/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { legacyPatchId } from "patchflow";
import {
  patchesHaveFullHistoryFromPatches,
  prevSeqForMoreHistoryFromHistory,
} from "../sync-doc";

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

describe("patchesHaveFullHistoryFromPatches", () => {
  it("treats an oldest snapshot without a previous cursor as full history", () => {
    expect(
      patchesHaveFullHistoryFromPatches([
        {
          is_snapshot: true,
          seq_info: {},
        },
      ]),
    ).toBe(true);
  });

  it("treats an oldest snapshot with prev_seq=1 as full history", () => {
    expect(
      patchesHaveFullHistoryFromPatches([
        {
          is_snapshot: true,
          seq_info: { prev_seq: 1 },
        },
      ]),
    ).toBe(true);
  });

  it("keeps More enabled when an older snapshot cursor still exists", () => {
    expect(
      patchesHaveFullHistoryFromPatches([
        {
          is_snapshot: true,
          seq_info: { prev_seq: 15 },
        },
      ]),
    ).toBe(false);
  });
});
