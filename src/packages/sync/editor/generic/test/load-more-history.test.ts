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

  it("reads SyncDoc's seq_info (prev_seq)", () => {
    expect(
      prevSeqForMoreHistoryFromHistory([
        {
          time: legacyPatchId(300),
          isSnapshot: true,
          seqInfo: { prev_seq: 90 },
        },
      ]),
    ).toBe(90);
  });

  it("loads from the start when the oldest loaded snapshot is the first one", () => {
    expect(
      prevSeqForMoreHistoryFromHistory([
        { time: legacyPatchId(200), isSnapshot: true, seqInfo: {} },
        {
          time: legacyPatchId(300),
          isSnapshot: true,
          seqInfo: { prevSeq: 90 },
        },
      ]),
    ).toBe(0);
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
  it("a document's first snapshot of a patch after the start is not the whole history", () => {
    // The first snapshot has no prev_seq (there is no earlier snapshot), but
    // the patches before the one it is of exist and are not loaded.
    expect(
      patchesHaveFullHistoryFromPatches([
        {
          is_snapshot: true,
          seq_info: { seq: 300 },
        },
      ]),
    ).toBe(false);
  });

  it("a snapshot of the first message in the stream is the whole history", () => {
    expect(
      patchesHaveFullHistoryFromPatches([
        {
          is_snapshot: true,
          seq_info: { seq: 1 },
        },
      ]),
    ).toBe(true);
  });

  it("keeps More enabled when an older snapshot exists", () => {
    expect(
      patchesHaveFullHistoryFromPatches([
        {
          is_snapshot: true,
          seq_info: { seq: 40, prev_seq: 15 },
        },
      ]),
    ).toBe(false);
  });

  it("an old snapshot record without seq: as before, by its prev_seq", () => {
    expect(
      patchesHaveFullHistoryFromPatches([{ is_snapshot: true, seq_info: {} }]),
    ).toBe(true);
    expect(
      patchesHaveFullHistoryFromPatches([
        { is_snapshot: true, seq_info: { prev_seq: 15 } },
      ]),
    ).toBe(false);
  });
});
