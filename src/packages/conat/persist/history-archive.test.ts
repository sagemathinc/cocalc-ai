/*
The archive of a sync document's history (bounded history design r3, §4.5):
loadable segments, the messages no load can reach, and the bounds on archived
history.
*/

import { PersistentStream } from "./storage";
import { initContext, syncFiles } from "./context";
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
  "COCALC_HISTORY_MAX_ARCHIVED_ID_EPOCHS",
];

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
    process.env.COCALC_HISTORY_MAX_ARCHIVE_BYTES = "60";
    // an archive from before segments
    write(20);
    const legacy = stream.resetHistory({ archive: true }).archive!;
    sql("DELETE FROM history_segments");
    sql("UPDATE history_epochs SET archive=NULL, kept_records=0, kept_bytes=0");
    write(25, { epoch: 1 });
    write(25, { epoch: 1 });
    // 20 (legacy) + 50 > 60: the legacy archive goes
    expect(stream.resetHistory({ archive: true })).toMatchObject({
      droppedArchived: { records: 1, bytes: 20 },
    });
    expect(sql(`SELECT name FROM sqlite_master WHERE name=?`, legacy)).toEqual(
      [],
    );
    write(30, { epoch: 2 });
    // 50 + 30 > 60: the oldest segment goes
    const result = stream.resetHistory({ archive: true });
    expect(result.droppedArchived).toEqual({ records: 2, bytes: 50 });
    const archives = stream.historyArchives();
    expect(archives.map(({ kept }) => kept.bytes)).toEqual([0, 0, 30]);
    expect(archives[1].archive).toBeUndefined();
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
    expect(stream.purgeArchivedHistory()).toEqual({ records: 1, bytes: 10 });
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
