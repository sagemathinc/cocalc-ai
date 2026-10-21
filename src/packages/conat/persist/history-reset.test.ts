/*
The seeded, conditional reset of a sync document's history (bounded history
design r3, §4.2-§4.4): its conditions, the seed, and the msg ids that tell an
open copy which of its pending patches were included.
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
    path: `/tmp/history-reset-test-${n++}`,
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

const archives = () =>
  sql(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'messages_archived_%'",
  ).map(({ name }) => name);

describe("a seeded reset", () => {
  it("archives the history and starts the new one with the seed and its checkpoint, in one step", () => {
    write(10, { msgID: "a" });
    write(10, { msgID: "b" });
    const changes: any[] = [];
    stream.on("change", (change) => changes.push(change));

    const result = stream.resetHistory({
      ...judge(),
      ifInitEpoch: 0,
      archive: true,
      seed: snapshot("hello"),
      opId: "op1",
      reason: "oversized",
    });
    expect(result).toMatchObject({
      reset: true,
      history_epoch: 1,
      count: 2,
      seedSeq: 3,
      coveredSeq: 2,
    });
    expect(
      sql(`SELECT seq FROM "${result.archive}" ORDER BY seq`).map(
        ({ seq }) => seq,
      ),
    ).toEqual([1, 2]);
    // the new history is exactly the seed, in the new epoch
    const all = [...stream.getAll()];
    expect(all.map(({ seq }) => seq)).toEqual([3]);
    expect(all[0].headers).toEqual({ history_epoch: 1 });
    expect(stream.getCheckpoints()).toEqual({
      latest_snapshot: expect.objectContaining({
        seq: 3,
        data: { patchId: "t" },
      }),
    });
    // open copies see the new epoch first, then the delete, then the seed
    expect(changes.map((c) => c.op ?? "set")).toEqual([
      "metadata",
      "delete",
      "checkpoints",
      "set",
    ]);
    expect(changes[3]).toMatchObject({ seq: 3, msgID: "seed-hello" });
    // writes from the old epoch are refused
    expect(() => write(10, { epoch: 0 })).toThrow("required header mismatch");
    expect(write(10, { epoch: 1 }).seq).toBe(4);
  });

  it("is refused if the history moved after it was judged, e.g., a patch arrived", () => {
    write(10);
    const judged = judge();
    write(10);
    for (const options of [
      judged,
      { coveredSeq: judged.coveredSeq },
      { ifRevision: judged.ifRevision, coveredSeq: stream.seq() },
    ]) {
      expect(
        stream.resetHistory({ ...options, archive: true, seed: snapshot("v") }),
      ).toEqual({
        reset: false,
        history_epoch: 0,
        count: 0,
        refused: "moved",
      });
    }
    expect(stream.length).toBe(2);
    // a delete moves it too, though the newest seq stays
    const again = judge();
    stream.delete({ seq: 1 });
    expect(
      stream.resetHistory({ ...again, coveredSeq: stream.seq() }).refused,
    ).toBe("moved");
  });

  it("is refused for a delayed seeder from an older epoch", () => {
    write(10);
    expect(
      stream.resetHistory({ ...judge(), seed: snapshot("first") }).reset,
    ).toBe(true);
    write(10, { epoch: 1 });
    // judged before the first reset
    expect(
      stream.resetHistory({
        ...judge(),
        ifInitEpoch: 0,
        seed: snapshot("stale"),
      }),
    ).toMatchObject({ reset: false, refused: "epoch", history_epoch: 1 });
    expect(stream.length).toBe(2);
  });

  it("returns the first result for a repeated opId (a lost reply), without resetting again", () => {
    write(10);
    const first = stream.resetHistory({
      ...judge(),
      archive: true,
      seed: snapshot("v"),
      opId: "op",
    });
    write(10, { epoch: 1, msgID: "after" });
    const again = stream.resetHistory({
      ...judge(),
      archive: true,
      seed: snapshot("v"),
      opId: "op",
    });
    expect(again).toEqual({ ...first, repeated: true });
    // the edit made after the reset is still there
    expect(stream.length).toBe(2);
    expect(stream.historyInclusion({ epoch: 1, ids: ["after"] }).ids).toEqual({
      after: { status: "live", seq: 3 },
    });
  });

  it("refuses a seed too large or not a snapshot, and changes nothing", () => {
    process.env.COCALC_HISTORY_MAX_SNAPSHOT_BYTES = "100";
    write(10);
    for (const [seed, refused] of [
      [snapshot("x".repeat(200)), "seed-too-large"],
      [
        { ...snapshot("v"), raw: Buffer.from("not msgpack \xff") },
        "seed-invalid",
      ],
      [
        {
          ...snapshot("v"),
          raw: Buffer.from(
            encode({ encoding: DataEncoding.MsgPack, mesg: { patch: "[]" } }),
          ),
        },
        "seed-invalid",
      ],
    ] as const) {
      expect(
        stream.resetHistory({ ...judge(), archive: true, seed: seed as any }),
      ).toMatchObject({ reset: false, refused });
    }
    expect(stream.length).toBe(1);
    expect(archives()).toEqual([]);
    // not fenced
    expect(write(10).seq).toBe(2);
  });

  it("leaves the old history if writing the seed fails (the resetter dies)", () => {
    write(10, { msgID: "a" });
    const insertMessage = (stream as any).insertMessage;
    (stream as any).insertMessage = () => {
      throw Error("disk I/O error");
    };
    expect(() =>
      stream.resetHistory({ ...judge(), archive: true, seed: snapshot("v") }),
    ).toThrow("disk I/O error");
    expect([...stream.getAll()].map(({ seq }) => seq)).toEqual([1]);
    expect(archives()).toEqual([]);
    expect(stream.getMetadata()).toBeUndefined();
    (stream as any).insertMessage = insertMessage;
    // not fenced
    expect(write(10).seq).toBe(2);
  });

  it("requires coveredSeq with a seed", () => {
    expect(() => stream.resetHistory({ seed: snapshot("v") })).toThrow(
      "requires coveredSeq",
    );
  });
});

describe("historyInclusion: which pending patches did the reset include?", () => {
  it("included through coveredSeq, absent if never accepted in that closed epoch, live after", () => {
    write(10, { msgID: "mine" });
    write(10, { msgID: "theirs" });
    stream.resetHistory({ ...judge(), archive: true, seed: snapshot("v") });
    write(10, { epoch: 1, msgID: "new" });
    expect(
      stream.historyInclusion({
        epoch: 0,
        ids: ["mine", "theirs", "never-arrived", "new"],
      }),
    ).toEqual({
      history_epoch: 1,
      ids: {
        mine: { status: "included", seq: 1 },
        theirs: { status: "included", seq: 2 },
        "never-arrived": { status: "absent" },
        new: { status: "live", seq: 4 },
      },
    });
    // the current epoch can still accept a patch in flight: never "absent"
    expect(
      stream.historyInclusion({ epoch: 1, ids: ["never-arrived"] }).ids,
    ).toEqual({ "never-arrived": { status: "unknown" } });
  });

  it("a rollback to the saved file never reports the excluded tail as included", () => {
    write(10, { msgID: "saved" });
    write(10, { msgID: "tail" });
    expect(
      stream.resetHistory({
        coveredSeq: 1,
        archive: true,
        seed: snapshot("from file"),
        reason: "damaged",
      }).refused,
    ).toBe("moved");
    const result = stream.resetHistory({
      coveredSeq: 1,
      allowRollback: true,
      archive: true,
      seed: snapshot("from file"),
      reason: "damaged",
    });
    expect(result).toMatchObject({ reset: true, coveredSeq: 1 });
    expect(
      stream.historyInclusion({ epoch: 0, ids: ["saved", "tail"] }).ids,
    ).toEqual({
      saved: { status: "included", seq: 1 },
      tail: { status: "excluded", seq: 2 },
    });
  });

  it("is unknown, never absent, where the evidence is incomplete", () => {
    // a stream from before msg ids were recorded
    write(10, { msgID: "old" });
    sql("DELETE FROM message_ids");
    sql("DELETE FROM history_epochs");
    (stream as any).ensureCurrentEpoch();
    stream.resetHistory({ ...judge(), archive: true, seed: snapshot("v") });
    expect(stream.historyInclusion({ epoch: 0, ids: ["old"] }).ids).toEqual({
      old: { status: "unknown" },
    });
  });

  it("is unknown after a message of that epoch was deleted", () => {
    write(10, { msgID: "a" });
    write(10, { msgID: "b" });
    stream.delete({ seq: 2 });
    stream.resetHistory({ ...judge(), archive: true, seed: snapshot("v") });
    expect(stream.historyInclusion({ epoch: 0, ids: ["a", "b"] }).ids).toEqual({
      a: { status: "included", seq: 1 },
      b: { status: "unknown" },
    });
  });

  it("is unknown once the epoch's ids expired, after maxArchivedIdEpochs more resets", () => {
    process.env.COCALC_HISTORY_MAX_ARCHIVED_ID_EPOCHS = "2";
    write(10, { msgID: "e0" });
    for (let epoch = 1; epoch <= 3; epoch++) {
      stream.resetHistory({
        ...judge(),
        archive: true,
        seed: snapshot(`${epoch}`),
      });
      if (epoch == 1) {
        expect(
          stream.historyInclusion({ epoch: 0, ids: ["e0", "x"] }).ids,
        ).toEqual({
          e0: { status: "included", seq: 1 },
          x: { status: "absent" },
        });
      }
    }
    expect(stream.historyInclusion({ epoch: 0, ids: ["e0", "x"] }).ids).toEqual(
      {
        e0: { status: "unknown" },
        x: { status: "unknown" },
      },
    );
  });

  it("follows the seeds: an id stays included through later seeded resets, not through a purge", () => {
    process.env.COCALC_HISTORY_MAX_ARCHIVED_ID_EPOCHS = "5";
    write(10, { msgID: "a" });
    stream.resetHistory({ ...judge(), archive: true, seed: snapshot("1") });
    stream.resetHistory({ ...judge(), archive: true, seed: snapshot("2") });
    expect(stream.historyInclusion({ epoch: 0, ids: ["a"] }).ids.a.status).toBe(
      "included",
    );
    // a reset without a seed starts from the empty document
    stream.resetHistory({ archive: true });
    expect(stream.historyInclusion({ epoch: 0, ids: ["a"] }).ids.a.status).toBe(
      "excluded",
    );
    // and purging forgets everything
    stream.resetHistory({});
    expect(stream.historyInclusion({ epoch: 0, ids: ["a"] }).ids).toEqual({
      a: { status: "unknown" },
    });
  });

  it("bounds the request", () => {
    expect(() =>
      stream.historyInclusion({
        epoch: 0,
        ids: Array.from({ length: 1001 }, (_, i) => `${i}`),
      }),
    ).toThrow("at most 1000");
  });
});
