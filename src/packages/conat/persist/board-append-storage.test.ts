/*
The append rule over real storage: PersistentStream with node:sqlite, the
strict-msgID setMany the board write service uses, and real MsgPack, in the
same order server.ts runs them (requestRecords, appendCheck, setMany,
commitAppend). Every accepted write must leave a history the open check
opens.
*/

import { DatabaseSync } from "node:sqlite";
import { copyFileSync, statSync } from "node:fs";
import { DataEncoding, decode, encode } from "@cocalc/conat/core/codec";
import { initContext, syncFiles } from "./context";
import { PersistentStream } from "./storage";
import {
  appendCheck,
  appendHead,
  commitAppend,
  requestRecords,
} from "./board-append";
import {
  BOARD_HISTORY_LIMITS,
  BoardAppendCheck,
  BoardHistoryCheck,
  type AppendRecord,
} from "./board-history";

initContext({
  sqlite: { DatabaseSync },
  compress: (data) => data,
  decompress: (data) => data,
  syncFiles,
  statSync,
  copyFileSync,
  ensureContainingDirectoryExists: async () => undefined,
});

const patch = (time: string, parents: string[] = []) => ({
  time,
  parents,
  patch: "[]",
  is_snapshot: false,
});
const snapshot = (time: string) => ({
  time,
  is_snapshot: true,
  snapshot: "{}",
  seq_info: { seq: 1 },
});

let n = 0;
function newStream() {
  return new PersistentStream({
    path: `/tmp/board-append-storage-${process.pid}-${n++}`,
    ephemeral: true,
  });
}

// One fenced setMany, as server.ts runs it. Throws the append check's
// refusal (nothing stored then).
function write(
  stream: PersistentStream,
  messages: { mesg: object; msgID: string }[],
) {
  const data = messages.map(({ mesg, msgID }) => ({
    msgID,
    messageData: {
      encoding: DataEncoding.MsgPack,
      raw: Buffer.from(encode({ encoding: DataEncoding.MsgPack, mesg })),
    },
  }));
  const records = requestRecords({ cmd: "setMany" }, { data }, stream)!;
  const append = appendCheck(stream as any, records);
  const results = stream.setMany(
    data.map(({ msgID, messageData }) => ({ msgID, ...messageData })),
    { allOrNothing: true, strictMsgID: true },
  );
  if (results.some((r) => "error" in r)) throw Error(JSON.stringify(results));
  commitAppend(stream as any, append, results as { seq: number }[]);
  return results as { seq: number }[];
}

function opens(stream: PersistentStream) {
  const check = new BoardHistoryCheck();
  for (const m of stream.getAll()) {
    const stop = check.add(
      decode({ encoding: m.encoding, data: m.raw }),
      m.raw.length,
    );
    if (stop) return stop;
  }
  return check.finish();
}

// astra's CORR-956-1 history: t0, snap(t0), t1..t1000, snap(t1000) (msgID
// s1000), then snap(t0) again with a new msgID: a valid backward cut, so
// the suffix is t1..t1000, exactly at the 1000 limit.
function astraHistory() {
  const stream = newStream();
  write(stream, [{ mesg: patch("t0"), msgID: "p0" }]);
  write(stream, [{ mesg: snapshot("t0"), msgID: "s0" }]);
  for (let i = 1; i <= 1000; i += 100) {
    const batch: { mesg: object; msgID: string }[] = [];
    for (let k = i; k < i + 100; k++) {
      batch.push({ mesg: patch(`t${k}`, [`t${k - 1}`]), msgID: `p${k}` });
    }
    write(stream, batch);
  }
  write(stream, [{ mesg: snapshot("t1000"), msgID: "s1000" }]);
  write(stream, [{ mesg: snapshot("t0"), msgID: "s0-again" }]);
  expect(opens(stream)).toMatchObject({
    ok: true,
    cut: "t0",
    suffix: BOARD_HISTORY_LIMITS.suffixRecords,
    head: "t1000",
  });
  return stream;
}

describe("CORR-956-1: the projection is over what storage actually writes", () => {
  test.each([
    ["the duplicate first", true],
    ["the duplicate after the new record", false],
  ])(
    "astra's repro (%s): refused, nothing stored, the history still opens",
    (_name, duplicateFirst) => {
      const stream = astraHistory();
      try {
        const before = stream.seqBounds().newest_retained_seq;
        const retry = { mesg: snapshot("t1000"), msgID: "s1000" };
        const next = { mesg: patch("t1001", ["t1000"]), msgID: "p1001" };
        expect(() =>
          write(stream, duplicateFirst ? [retry, next] : [next, retry]),
        ).toThrow(/over 1000 patches after the newest snapshot/);
        expect(stream.seqBounds().newest_retained_seq).toBe(before);
        expect(opens(stream)).toMatchObject({ ok: true, head: "t1000" });
      } finally {
        stream.close();
      }
    },
  );

  test("an exact retry alone is a no-op: nothing written, the cache kept", () => {
    const stream = astraHistory();
    try {
      const before = stream.seqBounds().newest_retained_seq!;
      const results = write(stream, [
        { mesg: snapshot("t1000"), msgID: "s1000" },
      ]);
      // Storage gave it its stored seq.
      expect(results[0].seq).toBeLessThanOrEqual(before);
      expect(stream.seqBounds().newest_retained_seq).toBe(before);
      expect(opens(stream)).toMatchObject({ ok: true, cut: "t0" });
      expect(appendHead(stream as any)).toBe("t1000");
    } finally {
      stream.close();
    }
  });

  test("a stored snapshot sent again with a new msgID is written (a copy) and moves the cut", () => {
    const stream = astraHistory();
    try {
      // snap(t1000) again, new msgID: stored again, so it is the newest
      // snapshot, and t1001 is then a suffix of 1.
      write(stream, [
        { mesg: snapshot("t1000"), msgID: "s1000-again" },
        { mesg: patch("t1001", ["t1000"]), msgID: "p1001" },
      ]);
      expect(opens(stream)).toMatchObject({
        ok: true,
        cut: "t1000",
        suffix: 1,
        head: "t1001",
      });
    } finally {
      stream.close();
    }
  });

  test("a msgID reused for another record is refused before anything is stored", () => {
    const stream = astraHistory();
    try {
      expect(() =>
        write(stream, [{ mesg: patch("t1001", ["t1000"]), msgID: "s1000" }]),
      ).toThrow(/msgID s1000, which is already stored/);
    } finally {
      stream.close();
    }
  });
});

describe("daybreak2: reading the stored graph stops at the first refusal", () => {
  const R = (value: object, bytes: number): AppendRecord => ({
    value,
    digest: JSON.stringify(value),
    bytes,
  });

  test("over the total: nothing after the first row past it is read", () => {
    let read = 0;
    function* rows() {
      for (let i = 0; i < 20_000; i++) {
        read += 1;
        yield R(patch(`t${i}`, i === 0 ? [] : [`t${i - 1}`]), 100);
      }
    }
    const limits = { ...BOARD_HISTORY_LIMITS, totalBytes: 1_000 };
    const check = BoardAppendCheck.fromRecords(rows(), 0, limits);
    // Rows 1-10 are 1,000 bytes; row 11 is over.
    expect(read).toBe(11);
    expect(() => check.check([R(patch("x", ["t10"]), 100)], limits)).toThrow(
      /isn't openable \(too-large\)/,
    );
  });

  test("an invalid row, a keyed row: nothing after it is read", () => {
    for (const bad of [
      R({ time: "bad id!" }, 10),
      { ...R(patch("t1", ["t0"]), 10), key: "k" },
    ]) {
      let read = 0;
      function* rows() {
        yield R(patch("t0"), 10);
        read += 1;
        yield bad;
        read += 1;
        for (let i = 2; i < 20_000; i++) {
          read += 1;
          yield R(patch(`t${i}`), 10);
        }
      }
      BoardAppendCheck.fromRecords(rows(), 0);
      expect(read).toBe(1);
    }
  });

  test("through appendCheck: a stream's rows are read lazily and the read stops", () => {
    let read = 0;
    const raw = (mesg: object) =>
      Buffer.from(encode({ encoding: DataEncoding.MsgPack, mesg }));
    const stream = {
      seqBounds: () => ({ newest_retained_seq: 20_000 }),
      msgIDOutcome: () => "new" as const,
      *getAll() {
        for (let i = 0; i < 20_000; i++) {
          read += 1;
          yield {
            encoding: DataEncoding.MsgPack,
            raw: raw(i === 3 ? { time: "bad id!" } : patch(`t${i}`)),
          };
        }
      },
    };
    expect(() => appendCheck(stream, [R(patch("x", ["t0"]), 10)])).toThrow(
      /isn't a board patch/,
    );
    expect(read).toBe(4);
  });
});

describe("at most one snapshot record per batch, counted after msgIDOutcome", () => {
  test("(a) a duplicate snapshot plus one new written snapshot is accepted", () => {
    const stream = astraHistory();
    try {
      const results = write(stream, [
        // A duplicate: not written, so it doesn't count.
        { mesg: snapshot("t1000"), msgID: "s1000" },
        { mesg: snapshot("t500"), msgID: "s500" },
      ]);
      expect(results).toHaveLength(2);
      expect(opens(stream)).toMatchObject({ ok: true, cut: "t500" });
    } finally {
      stream.close();
    }
  });

  test("(b) two written snapshots are refused atomically: nothing stored", () => {
    const stream = astraHistory();
    try {
      const before = stream.seqBounds().newest_retained_seq;
      for (const batch of [
        [
          { mesg: snapshot("t500"), msgID: "s500" },
          { mesg: snapshot("t600"), msgID: "s600" },
        ],
        // A stored snapshot sent again under a NEW msgID is written, and
        // counts.
        [
          { mesg: snapshot("t1000"), msgID: "s1000-again" },
          { mesg: snapshot("t500"), msgID: "s500" },
        ],
      ]) {
        expect(() => write(stream, batch)).toThrow(/at most 1 snapshot record/);
        expect(stream.seqBounds().newest_retained_seq).toBe(before);
      }
      expect(opens(stream)).toMatchObject({ ok: true, cut: "t0" });
    } finally {
      stream.close();
    }
  });
});

test("daybreak2's pathological batch (alternating snapshots) is refused at once", () => {
  // A suffix of 1000 patches, and a batch of tiny snapshot records that
  // would move the cut back and forth along all of it: refused at its
  // second snapshot, before any projection work.
  const records: AppendRecord[] = [];
  const add = (value: object) =>
    records.push({
      value,
      digest: JSON.stringify(value),
      bytes: JSON.stringify(value).length,
    });
  add(patch("t0"));
  for (let i = 1; i < 1000; i++) add(patch(`t${i}`, [`t${i - 1}`]));
  add(snapshot("t0"));
  const check = BoardAppendCheck.fromRecords(records, records.length);
  const batch: AppendRecord[] = [];
  const s0 = snapshot("t0");
  const s999 = snapshot("t999");
  for (let i = 0; i < BOARD_HISTORY_LIMITS.records - records.length; i++) {
    const value = i % 2 === 0 ? s999 : s0;
    batch.push({
      value,
      digest: JSON.stringify(value),
      bytes: JSON.stringify(value).length,
    });
  }
  const start = performance.now();
  expect(() => check.check(batch)).toThrow(/at most 1 snapshot record/);
  const ms = performance.now() - start;
  console.log(`pathological batch refused in ${ms.toFixed(1)} ms`);
  expect(ms).toBeLessThan(50);
});

describe("codex round 7 (on 956e675030)", () => {
  test("4332257425: a msgID twice in one batch: the same record is stored once; another record is refused", () => {
    const stream = astraHistory();
    try {
      const before = stream.seqBounds().newest_retained_seq!;
      const next = { mesg: patch("t1001", ["t1000"]), msgID: "p1001" };
      // (A snapshot first moves the cut, so the suffix has room.)
      const results = write(stream, [
        { mesg: snapshot("t1000"), msgID: "s1000-again" },
        next,
        next,
      ]);
      expect(results[1].seq).toBe(results[2].seq);
      expect(stream.seqBounds().newest_retained_seq).toBe(before + 2);
      expect(appendHead(stream as any)).toBe("t1001");
      expect(opens(stream)).toMatchObject({ ok: true, head: "t1001" });
      // Another record under a msgID earlier in the batch: refused, nothing
      // stored.
      expect(() =>
        write(stream, [
          { mesg: patch("t1002", ["t1001"]), msgID: "p1002" },
          { mesg: patch("t1003", ["t1002"]), msgID: "p1002" },
        ]),
      ).toThrow(/msgID p1002, which is already stored/);
      expect(stream.seqBounds().newest_retained_seq).toBe(before + 2);
      // And storage itself, given such a batch directly, refuses it too.
      const raw = (mesg: object) =>
        Buffer.from(encode({ encoding: DataEncoding.MsgPack, mesg }));
      const direct = stream.setMany(
        [
          { msgID: "q", encoding: DataEncoding.MsgPack, raw: raw(patch("x")) },
          { msgID: "q", encoding: DataEncoding.MsgPack, raw: raw(patch("y")) },
        ],
        { allOrNothing: true, strictMsgID: true },
      );
      expect(direct).toEqual([
        expect.objectContaining({ code: "msgid-conflict" }),
        expect.objectContaining({ code: "msgid-conflict" }),
      ]);
      expect(stream.seqBounds().newest_retained_seq).toBe(before + 2);
    } finally {
      stream.close();
    }
  });

  test("4332257420: retention settings never trim a board's history", () => {
    const stream = newStream();
    stream.setRecordCap(BOARD_HISTORY_LIMITS.recordBytes);
    try {
      write(stream, [{ mesg: patch("t0"), msgID: "p0" }]);
      stream.config({ max_msgs: 1, max_age: 1, allow_msg_ttl: true } as any);
      // An append that would evict t0 is refused ("branch": the board
      // writer keeps its edits), and nothing is deleted.
      expect(() =>
        write(stream, [{ mesg: patch("t1", ["t0"]), msgID: "p1" }]),
      ).toThrow();
      const raw = Buffer.from(
        encode({ encoding: DataEncoding.MsgPack, mesg: patch("t1", ["t0"]) }),
      );
      expect(() =>
        stream.set({ encoding: DataEncoding.MsgPack, raw, msgID: "p1" }),
      ).toThrow(expect.objectContaining({ code: "branch" }));
      // Ages and TTLs delete nothing either (config enforces limits now).
      stream.config({ max_age: 1 } as any);
      expect([...stream.getAll()]).toHaveLength(1);
      expect(opens(stream)).toMatchObject({ ok: true, head: "t0" });
    } finally {
      stream.close();
    }
  });

  test("4332257428: a capped getAll reads metadata a chunk at a time", () => {
    const stream = newStream();
    stream.setRecordCap(BOARD_HISTORY_LIMITS.recordBytes);
    try {
      const raw = Buffer.from(
        encode({ encoding: DataEncoding.MsgPack, mesg: patch("t") }),
      );
      stream.setMany(
        Array.from({ length: 2_500 }, () => ({
          encoding: DataEncoding.MsgPack,
          raw,
        })),
      );
      const prepare = jest.spyOn((stream as any).db, "prepare");
      const it = stream.getAll();
      expect(it.next().done).toBe(false);
      const metaScans = () =>
        prepare.mock.calls.filter(([sql]) => /LIMIT 1000/.test(`${sql}`))
          .length;
      // One chunk's metadata, not the whole table's.
      expect(metaScans()).toBe(1);
      let n = 1;
      while (!it.next().done) n += 1;
      expect(n).toBe(2_500);
      expect(metaScans()).toBe(3);
    } finally {
      stream.close();
    }
  });
});
