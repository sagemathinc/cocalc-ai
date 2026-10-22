/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { legacyPatchId } from "patchflow";
import {
  isSnapshotRecordBeforeLoadedRange,
  loadedStartSnapshotFromMessages,
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

describe("prevSeqForMoreHistoryFromHistory with where the loaded history starts", () => {
  // The latest snapshot (patch at seq 29288, prev 28989) is loaded, and so is
  // the previous snapshot's record (patch at seq 28989, prev 301), appended
  // after seq 29288.
  const history = [
    {
      time: legacyPatchId(100),
      isSnapshot: true,
      seqInfo: { seq: 28989, prev_seq: 301 },
    },
    {
      time: legacyPatchId(200),
      isSnapshot: true,
      seqInfo: { seq: 29288, prev_seq: 28989 },
    },
  ];

  it("steps back to the nearest snapshot before the loaded start", () => {
    expect(prevSeqForMoreHistoryFromHistory(history, 29288)).toBe(28989);
  });

  it("then to the one before it", () => {
    expect(prevSeqForMoreHistoryFromHistory(history, 28989)).toBe(301);
  });

  it("loads everything when no snapshot is before the loaded start", () => {
    expect(prevSeqForMoreHistoryFromHistory(history, 301)).toBe(0);
  });

  it("keeps the old rule when the loaded start is unknown", () => {
    expect(prevSeqForMoreHistoryFromHistory(history)).toBe(301);
  });
});

describe("isSnapshotRecordBeforeLoadedRange", () => {
  const record = (time: string, seq: number) => ({
    time,
    is_snapshot: true,
    seq_info: { seq },
  });
  // the sagebrush chat: opened at 43137, record of 42836 at 43138
  const opened = { openStartSeq: 43137 };

  it("ignores a record its loaded snapshot's writer proved to be an ancestor", () => {
    const start = { ancestors: new Set(["t42836"]) };
    expect(
      isSnapshotRecordBeforeLoadedRange(record("t42836", 42836), 43137, {
        ...opened,
        start,
        recordSeq: 43138,
      }),
    ).toBe(true);
    // not proved: maybe a concurrent head nothing loaded builds on
    expect(
      isSnapshotRecordBeforeLoadedRange(record("t42900", 42900), 43137, {
        ...opened,
        start,
        recordSeq: 43139,
      }),
    ).toBe(false);
  });

  it("does not ignore an unproved record in the range opened (legacy)", () => {
    expect(
      isSnapshotRecordBeforeLoadedRange(record("t42836", 42836), 43137, {
        ...opened,
        start: {},
        recordSeq: 43138,
      }),
    ).toBe(false);
  });

  it("ignores a record stored before the position opened at, until its patch loads", () => {
    // after a step back to 42836: the record of 42535 at 42843
    expect(
      isSnapshotRecordBeforeLoadedRange(record("t42535", 42535), 42836, {
        ...opened,
        start: {},
        recordSeq: 42843,
      }),
    ).toBe(true);
    expect(
      isSnapshotRecordBeforeLoadedRange(record("t42535", 42535), 42535, {
        ...opened,
        start: {},
        recordSeq: 42843,
      }),
    ).toBe(false);
  });

  it("keeps the loaded snapshot, patches, seeds and records without a seq", () => {
    const context = {
      ...opened,
      start: { ancestors: new Set(["t1"]) },
      recordSeq: 1,
    };
    const keep = [
      { time: "t1", is_snapshot: true, seq_info: { seq: 43137 } },
      { time: "t1", is_snapshot: false, seq_info: { seq: 1 } },
      { time: "t1", is_snapshot: true, seq_info: { seq: 0 } },
      { time: "t1", is_snapshot: true },
      { time: "t1", is_snapshot: true, seq_info: null },
    ];
    for (const patch of keep) {
      expect(isSnapshotRecordBeforeLoadedRange(patch, 43137, context)).toBe(
        false,
      );
    }
    expect(
      isSnapshotRecordBeforeLoadedRange(record("t1", 2), undefined, context),
    ).toBe(false);
  });
});

describe("loadedStartSnapshotFromMessages", () => {
  const snap = (time: string, seq_info: any) => ({
    time,
    is_snapshot: true,
    seq_info,
  });

  it("follows the ancestors of listed snapshots whose records are loaded", () => {
    const start = loadedStartSnapshotFromMessages(
      [
        { time: "p", parents: [] },
        snap("b", { seq: 20, prev_seq: 10, snapshot_ancestors: ["a"] }),
        snap("c", { seq: 30, prev_seq: 20, snapshot_ancestors: ["b"] }),
      ],
      30,
    );
    expect([...(start?.ancestors ?? [])].sort()).toEqual(["a", "b"]);
  });

  it("is legacy without a list, and undefined without the start snapshot", () => {
    expect(
      loadedStartSnapshotFromMessages(
        [snap("c", { seq: 30, prev_seq: 20 })],
        30,
      ),
    ).toEqual({});
    expect(
      loadedStartSnapshotFromMessages([snap("c", { seq: 30 })], 31),
    ).toBeUndefined();
  });
});
