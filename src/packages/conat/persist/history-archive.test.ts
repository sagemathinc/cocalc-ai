/*
The archive of a sync document's history (bounded history design r3, §4.5):
loadable segments, the messages no load can reach, and the bounds on archived
history.
*/

import {
  ARCHIVE_RECORD_OVERHEAD_BYTES as R,
  ARCHIVE_TABLE_OVERHEAD_BYTES as T,
  PersistentStream,
} from "./storage";
import { initContext, syncFiles } from "./context";
import { historyLimits } from "./history-limits";
import { DataEncoding, encode } from "@cocalc/conat/core/codec";
import { DatabaseSync } from "node:sqlite";
import { statSync, copyFileSync } from "node:fs";

let stream: PersistentStream;
let n = 0;

const LIMIT_ENV = [
  "COCALC_HISTORY_MAX_SNAPSHOT_BYTES",
  "COCALC_HISTORY_MAX_SUFFIX_BYTES",
  "COCALC_HISTORY_MAX_OPEN_RECORDS",
  "COCALC_HISTORY_MAX_ARCHIVE_BYTES",
  "COCALC_HISTORY_MAX_ARCHIVE_RECORDS",
  "COCALC_HISTORY_MAX_ARCHIVE_SEGMENTS",
  "COCALC_HISTORY_MAX_ARCHIVED_ID_EPOCHS",
  "COCALC_HISTORY_MAX_TRIM_RECORDS",
  "COCALC_HISTORY_MAX_TRIM_BYTES",
];

// Counts the rows each statement returns while fn runs.
function rowsRead(fn: () => void): { max: number; total: number } {
  const db = (stream as any).db;
  const prepare = db.prepare.bind(db);
  const counts = { max: 0, total: 0 };
  const count = (statement: string, n: number) => {
    // resetHistory's delete notification lists the live seqs (as on main)
    if (statement === "SELECT seq FROM messages") return;
    counts.max = Math.max(counts.max, n);
    counts.total += n;
  };
  db.prepare = (statement: string) => {
    const stmt = prepare(statement);
    return new Proxy(stmt, {
      get(target, key) {
        if (key === "all") {
          return (...args) => {
            const rows = target.all(...args);
            count(statement, rows.length);
            return rows;
          };
        }
        if (key === "get") {
          return (...args) => {
            const row = target.get(...args);
            count(statement, row == null ? 0 : 1);
            return row;
          };
        }
        if (key === "iterate") {
          return function* (...args) {
            let n = 0;
            try {
              for (const row of target.iterate(...args)) {
                n += 1;
                yield row;
              }
            } finally {
              count(statement, n);
            }
          };
        }
        const value = target[key];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  try {
    fn();
  } finally {
    db.prepare = prepare;
  }
  return counts;
}

beforeAll(() => {
  initContext({
    sqlite: { DatabaseSync },
    compress: (data) => data,
    decompress: (data) => data,
    syncFiles,
    statSync,
    copyFileSync,
    ensureContainingDirectoryExists: async () => undefined,
  });
});

beforeEach(() => {
  stream = new PersistentStream({
    path: `/tmp/history-archive-test-${n++}`,
    ephemeral: true,
  });
});

afterEach(() => {
  stream.close();
  for (const name of LIMIT_ENV) delete process.env[name];
});

// a patch in the given epoch, whose recorded size (data plus headers) is bytes
function write(
  bytes: number,
  {
    epoch,
    msgID,
    checkpoint,
  }: {
    epoch?: number;
    msgID?: string;
    checkpoint?: { name: string; seq?: number };
  } = {},
) {
  const headers = epoch != null ? { history_epoch: epoch } : undefined;
  const data = bytes - (JSON.stringify(headers)?.length ?? 0) - 2;
  return stream.set({
    encoding: DataEncoding.JsonCodec,
    raw: Buffer.from(`"${"x".repeat(Math.max(0, data))}"`),
    ...(headers != null ? { headers } : {}),
    msgID,
    checkpoint,
  });
}

function snapshot(value: string, extra: object = {}) {
  return {
    encoding: DataEncoding.MsgPack,
    raw: Buffer.from(
      encode({
        encoding: DataEncoding.MsgPack,
        mesg: { is_snapshot: true, snapshot: value, time: "t", ...extra },
      }),
    ),
    msgID: `seed-${value}`,
    checkpoint: { name: "latest_snapshot", data: { patchId: "t" } },
  };
}

// what an open copy holds: the stream's newest seq and number of messages
function judge() {
  const { seq, count } = stream.inventory();
  return { ifRevision: { seq, count }, coveredSeq: seq };
}

function sql(statement: string, ...params: any[]) {
  return stream.sqlite(statement, params);
}

describe("archive segments", () => {
  // a snapshot written with its checkpoint at the patch it describes
  function snapshotAt(seq: number, bytes: number) {
    return write(bytes, { checkpoint: { name: "latest_snapshot", seq } });
  }

  it("takes only snapshot checkpoints as cuts, never e.g. the saved_file proof", () => {
    write(10, { checkpoint: { name: "saved_file" } });
    stream.setCheckpoint({ name: "saved_file", seq: 1 });
    snapshotAt(1, 10);
    stream.setCheckpoint({ name: "latest_snapshot", seq: 2 });
    expect(
      sql("SELECT seq, snapshot_seq FROM history_cuts ORDER BY seq"),
    ).toEqual([
      { seq: 1, snapshot_seq: 2 },
      { seq: 2, snapshot_seq: null },
    ]);
  });

  it("keeps maximal loadable stretches, and removes (and counts) what no load can reach", () => {
    process.env.COCALC_HISTORY_MAX_SNAPSHOT_BYTES = "100";
    process.env.COCALC_HISTORY_MAX_SUFFIX_BYTES = "50";
    // from the empty document: 1..3 load (30 bytes)
    write(10); // 1
    write(10); // 2
    write(10); // 3
    write(40); // 4: past the suffix budget from the empty document
    write(10); // 5: no cut reaches it
    // a cut at 6 whose snapshot is 7: 6..9 load (cut 60, suffix 30)
    write(10); // 6
    snapshotAt(6, 60); // 7
    write(10); // 8
    write(10); // 9
    const result = stream.resetHistory({
      ...judge(),
      archive: true,
      seed: snapshot("v"),
    });
    expect(result).toMatchObject({
      segments: 2,
      dropped: { records: 2, bytes: 50 },
    });
    const [epoch] = stream.historyArchives();
    expect(epoch).toMatchObject({
      epoch: 0,
      first_seq: 1,
      last_seq: 9,
      covered_seq: 9,
      archive: result.archive,
      kept: { records: 7, bytes: 120 },
      dropped: { records: 2, bytes: 50 },
      info: { reason: null },
    });
    expect(epoch.segments).toEqual([
      { first_seq: 1, last_seq: 3, cut_bytes: 0, suffix_bytes: 30, records: 3 },
      {
        first_seq: 6,
        last_seq: 9,
        cut_seq: 6,
        snapshot_seq: 7,
        cut_bytes: 60,
        suffix_bytes: 30,
        records: 4,
      },
    ]);
    expect(
      sql(`SELECT seq FROM "${result.archive}" ORDER BY seq`).map(
        ({ seq }) => seq,
      ),
    ).toEqual([1, 2, 3, 6, 7, 8, 9]);
  });

  it("merges stretches while they fit, and drops a history with no loadable start", () => {
    process.env.COCALC_HISTORY_MAX_SUFFIX_BYTES = "1000";
    write(10);
    snapshotAt(1, 10);
    write(10);
    snapshotAt(3, 10);
    write(10);
    expect(
      stream.resetHistory({ ...judge(), archive: true, seed: snapshot("v") }),
    ).toMatchObject({ segments: 1, dropped: { records: 0, bytes: 0 } });
    // the new epoch starts with its seed; with only a cut whose snapshot is
    // missing, nothing in the next epoch can be loaded
    sql("DELETE FROM history_cuts");
    sql("DELETE FROM stream_checkpoints");
    sql("UPDATE history_epochs SET starts_empty=0 WHERE last_seq IS NULL");
    write(10, { epoch: 1 });
    const result = stream.resetHistory({
      ...judge(),
      archive: true,
      seed: snapshot("w"),
    });
    expect(result).toMatchObject({
      segments: 0,
      dropped: { records: 2 },
    });
    expect(result.archive).toBeUndefined();
    expect(stream.historyArchives()[1]).toMatchObject({
      kept: { records: 0, bytes: 0 },
      segments: [],
    });
  });

  it("keeps archived history within maxArchiveBytes, dropping the oldest first", () => {
    // each archive is charged its records' and table's overhead too: room for
    // one archive of two 25-byte records
    process.env.COCALC_HISTORY_MAX_ARCHIVE_BYTES = `${T + 50 + 2 * R}`;
    // an archive from before segments
    write(20);
    const legacy = stream.resetHistory({ archive: true }).archive!;
    sql("DELETE FROM history_segments");
    sql("UPDATE history_epochs SET archive=NULL, kept_records=0, kept_bytes=0");
    write(25, { epoch: 1 });
    write(25, { epoch: 1 });
    // the legacy archive (20 bytes) and these two do not fit: the legacy one goes
    expect(stream.resetHistory({ archive: true })).toMatchObject({
      droppedArchived: { records: 1, bytes: 20 },
    });
    expect(sql(`SELECT name FROM sqlite_master WHERE name=?`, legacy)).toEqual(
      [],
    );
    write(30, { epoch: 2 });
    // the oldest segment goes
    const result = stream.resetHistory({ archive: true });
    expect(result.droppedArchived).toEqual({ records: 2, bytes: 50 });
    const archives = stream.historyArchives();
    expect(archives.map(({ kept }) => kept.bytes)).toEqual([0, 0, 30]);
    expect(archives[1].archive).toBeUndefined();
  });

  it("bounds archived records, dropping the oldest, archives from before segments first", () => {
    process.env.COCALC_HISTORY_MAX_ARCHIVE_RECORDS = "5";
    for (let i = 0; i < 3; i++) write(10);
    const legacy = stream.resetHistory({ archive: true }).archive!;
    sql("DELETE FROM history_segments");
    sql("UPDATE history_epochs SET archive=NULL, kept_records=0, kept_bytes=0");
    for (let i = 0; i < 4; i++) write(30, { epoch: 1 });
    // 3 + 4 > 5: the legacy archive goes
    expect(stream.resetHistory({ archive: true }).droppedArchived).toEqual({
      records: 3,
      bytes: 30,
    });
    expect(sql("SELECT name FROM sqlite_master WHERE name=?", legacy)).toEqual(
      [],
    );
    for (let i = 0; i < 3; i++) write(30, { epoch: 2 });
    // 4 + 3 > 5: the older archive's segment goes
    expect(stream.resetHistory({ archive: true }).droppedArchived).toEqual({
      records: 4,
      bytes: 120,
    });
    expect(
      stream.historyArchives().reduce((n, { kept }) => n + kept.records, 0),
    ).toBe(3);
  });

  it("bounds the number of segments, and so the archive listing", () => {
    process.env.COCALC_HISTORY_MAX_ARCHIVE_SEGMENTS = "10";
    process.env.COCALC_HISTORY_MAX_OPEN_RECORDS = "1";
    // 200 patch+snapshot pairs: 200 cuts, and about a segment for each
    for (let i = 0; i < 200; i++) {
      const { seq } = write(10);
      snapshotAt(seq, 10);
    }
    const result = stream.resetHistory({ archive: true });
    expect(result.segments).toBe(200);
    // the first patch is a segment from the empty document, its snapshot
    // fits none; the 189 oldest of the others go
    expect(result.dropped).toEqual({ records: 1, bytes: 10 });
    expect(result.droppedArchived).toEqual({ records: 379, bytes: 3790 });
    const [epoch] = stream.historyArchives();
    expect(epoch.segments).toHaveLength(10);
    // the newest are kept
    expect(epoch.segments[9].last_seq).toBe(400);
    expect(sql("SELECT COUNT(*) AS n FROM history_segments")[0].n).toBe(10);
    expect(sql(`SELECT COUNT(*) AS n FROM "${result.archive}"`)[0].n).toBe(20);
  });

  it("bounds the work of archiving an epoch far larger than the archive bounds", () => {
    process.env.COCALC_HISTORY_MAX_ARCHIVE_RECORDS = "50";
    process.env.COCALC_HISTORY_MAX_TRIM_RECORDS = "100";
    // e.g., from before the bounds: 2,000 messages, with a cut every 10
    const db = (stream as any).db;
    db.exec("BEGIN");
    for (let i = 1; i <= 2000; i++) {
      (stream as any).insertMessage({
        encoding: DataEncoding.JsonCodec,
        raw: Buffer.from('"x"'),
        ...(i % 10 == 0
          ? { checkpoint: { name: "latest_snapshot", seq: i - 1 } }
          : {}),
      });
    }
    db.exec("COMMIT");
    let result: any;
    const read = rowsRead(() => {
      result = stream.resetHistory({ archive: true });
    });
    // the newest 50 scanned (and 1 more to stop), then segmented, then 100
    // older ones trimmed; nothing in proportion to the 2,000
    expect(read.total).toBeLessThan(400);
    expect(read.max).toBeLessThanOrEqual(100);
    expect(result.droppedArchived).toEqual({ records: 100, bytes: 300 });
    const kept = stream.historyArchives()[0].kept.records;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThanOrEqual(50);
    const left = () =>
      sql(`SELECT COUNT(*) AS n FROM "${result.archive}"`)[0].n;
    expect(left()).toBe(2000 - 100 - (50 - kept));
    // each later step removes at most 100 more, until only the segments
    // are left
    let steps = 0;
    while (left() > kept) {
      const before = left();
      const step = rowsRead(() =>
        (stream as any).runTransaction(() =>
          (stream as any).trimArchivedHistory(historyLimits()),
        ),
      );
      expect(step.total).toBeLessThan(250);
      expect(before - left()).toBeLessThanOrEqual(100);
      steps += 1;
    }
    expect(steps).toBe(Math.ceil((2000 - 100 - 50) / 100));
    expect(stream.historyArchives()[0].kept.records).toBe(kept);
  });

  it("removes many archives from before segments in bounded steps, oldest first", () => {
    // while these are made, each reset removes just 1 message of them
    process.env.COCALC_HISTORY_MAX_TRIM_RECORDS = "1";
    for (let epoch = 0; epoch < 30; epoch++) {
      for (let i = 0; i < 3; i++) write(30, epoch > 0 ? { epoch } : {});
      stream.resetHistory({ archive: true });
      // as an older server left it: a table with no index
      sql("DELETE FROM history_segments");
      sql("UPDATE history_epochs SET archive=NULL");
    }
    const count = () =>
      sql(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'messages_archived_%'",
      )[0].n;
    let before = count();
    expect(before).toBeGreaterThan(15);
    process.env.COCALC_HISTORY_MAX_TRIM_RECORDS = "7";
    let steps = 0;
    while (count() > 0) {
      const step = rowsRead(() =>
        (stream as any).runTransaction(() =>
          (stream as any).trimArchivedHistory(historyLimits()),
        ),
      );
      // at most 8 names and 7 messages read
      expect(step.max).toBeLessThanOrEqual(8);
      expect(before - count()).toBeLessThanOrEqual(3);
      before = count();
      steps += 1;
    }
    expect(steps).toBeGreaterThan(5);
  });

  it("keeps at most 100 archives, however small", () => {
    for (let epoch = 0; epoch < 102; epoch++) {
      write(10, epoch > 0 ? { epoch } : {});
      stream.resetHistory({ archive: true });
    }
    const archives = stream.historyArchives();
    expect(archives.filter(({ archive }) => archive != null)).toHaveLength(100);
    expect(archives[0]).toMatchObject({
      kept: { records: 0, bytes: 0 },
      dropped: { records: 1 },
    });
    expect(
      sql(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'messages_archived_%'",
      )[0].n,
    ).toBe(100);
  });

  it("deletes archived history on request, keeping the current history and the ids", () => {
    write(10, { msgID: "a" });
    stream.resetHistory({ ...judge(), archive: true, seed: snapshot("v") });
    expect(stream.purgeArchivedHistory()).toEqual({
      records: 1,
      bytes: 10,
      done: true,
    });
    expect(
      sql(
        "SELECT name FROM sqlite_master WHERE name LIKE 'messages_archived_%'",
      ),
    ).toEqual([]);
    expect(stream.length).toBe(1);
    expect(stream.historyInclusion({ epoch: 0, ids: ["a"] }).ids.a.status).toBe(
      "included",
    );
  });
});
