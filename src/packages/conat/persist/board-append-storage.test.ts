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
  appendCheckPrepared,
  prepareAppend,
  prepareRequest,
  requestRecords,
  storedBytes,
} from "./board-append";
import * as jsonScan from "./json-scan";
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
      storedBytes(m.raw, m.headers, m.key),
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

test("astra CORR9561: a msgID that isn't a string is refused before storage", () => {
  const stream = astraHistory();
  try {
    const before = stream.seqBounds().newest_retained_seq;
    const raw = (mesg: object) =>
      Buffer.from(encode({ encoding: DataEncoding.MsgPack, mesg }));
    for (const msgID of [42, { id: "s1000" }, ["s1000"], true]) {
      // astra's repro, with the retry's msgID as another type.
      const data = [
        {
          msgID,
          messageData: {
            encoding: DataEncoding.MsgPack,
            raw: raw(snapshot("t1000")),
          },
        },
        {
          msgID: "p1001",
          messageData: {
            encoding: DataEncoding.MsgPack,
            raw: raw(patch("t1001", ["t1000"])),
          },
        },
      ];
      expect(() =>
        requestRecords({ cmd: "setMany" }, { data }, stream),
      ).toThrow(/msgID must be a string/);
      expect(() =>
        requestRecords(
          { cmd: "set", msgID },
          { encoding: DataEncoding.MsgPack, raw: raw(snapshot("t1000")) },
          stream,
        ),
      ).toThrow(/msgID must be a string/);
    }
    expect(stream.seqBounds().newest_retained_seq).toBe(before);
    expect(opens(stream)).toMatchObject({ ok: true });
  } finally {
    stream.close();
  }
});

test("astra CORR9561: storage's strict mode refuses a msgID that isn't a string too", () => {
  const stream = newStream();
  try {
    const raw = Buffer.from(
      encode({ encoding: DataEncoding.MsgPack, mesg: patch("t0") }),
    );
    expect(() =>
      stream.set({
        encoding: DataEncoding.MsgPack,
        raw,
        msgID: 42 as any,
        strictMsgID: true,
      }),
    ).toThrow(/msgID must be a string/);
    expect(
      stream.setMany(
        [{ encoding: DataEncoding.MsgPack, raw, msgID: 42 as any }],
        { allOrNothing: true, strictMsgID: true },
      ),
    ).toEqual([expect.objectContaining({ code: "branch" })]);
    expect([...stream.getAll()]).toHaveLength(0);
  } finally {
    stream.close();
  }
});

test("astra CORR-F37-1: a board stream's retention settings delete nothing as it reopens", async () => {
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const path = join(mkdtempSync(join(tmpdir(), "board-reopen-")), "stream");
  const raw = Buffer.from(
    encode({ encoding: DataEncoding.MsgPack, mesg: patch("t0") }),
  );
  const cap = BOARD_HISTORY_LIMITS.recordBytes;
  let stream = new PersistentStream({ path, recordCap: cap });
  stream.set({ encoding: DataEncoding.MsgPack, raw, ttl: 1 });
  stream.config({ max_age: 1, allow_msg_ttl: true } as any);
  expect([...stream.getAll()]).toHaveLength(1);
  stream.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Reopened as a board stream: the cap is there before its limits run.
  stream = new PersistentStream({ path, recordCap: cap });
  try {
    expect([...stream.getAll()]).toHaveLength(1);
    expect(stream.config()).toMatchObject({ max_age: 1, allow_msg_ttl: true });
  } finally {
    stream.close();
  }
  // (Without the cap, the same settings do delete it: the control.)
  stream = new PersistentStream({ path });
  try {
    expect([...stream.getAll()]).toHaveLength(0);
  } finally {
    stream.close();
  }
});

test('codex 4332816468: a board stream refuses a legacy required-header mismatch as "branch"', () => {
  const raw = Buffer.from(
    encode({ encoding: DataEncoding.MsgPack, mesg: patch("t0") }),
  );
  for (const [cap, code] of [
    [BOARD_HISTORY_LIMITS.recordBytes, "branch"],
    [undefined, "reject"],
  ] as const) {
    const stream = newStream();
    if (cap != null) stream.setRecordCap(cap);
    try {
      stream.config({ required_headers: { history_epoch: 7 } } as any);
      expect(() =>
        stream.set({ encoding: DataEncoding.MsgPack, raw, msgID: "p0" }),
      ).toThrow(expect.objectContaining({ code }));
      expect([...stream.getAll()]).toHaveLength(0);
    } finally {
      stream.close();
    }
  }
});

test("codex 4332730147: a record's stored headers count toward the history's bytes", () => {
  const raw = Buffer.from(
    encode({ encoding: DataEncoding.MsgPack, mesg: patch("t0") }),
  );
  const headers = { big: "x".repeat(900_000) };
  const expected = raw.length + JSON.stringify(headers).length;
  // In a request ...
  const [set] = requestRecords(
    { cmd: "set", headers },
    { raw, encoding: DataEncoding.MsgPack },
  )!;
  expect(set.bytes).toBe(expected);
  const [many] = requestRecords(
    { cmd: "setMany" },
    {
      data: [{ messageData: { raw, encoding: DataEncoding.MsgPack, headers } }],
    },
  )!;
  expect(many.bytes).toBe(expected);
  // ... and as stored, read back (as the open check and readGraph count it).
  const stream = newStream();
  try {
    stream.set({ encoding: DataEncoding.MsgPack, raw, headers } as any);
    const [m] = [...stream.getAll()];
    expect(storedBytes(m.raw, m.headers, m.key)).toBe(expected);
    // 80 such records: about 72 MB, over the 64 MiB a history may hold.
    const check = new BoardHistoryCheck();
    let stop: any;
    for (let i = 0; i < 80 && !stop; i++) {
      stop = check.add(patch(`t${i}`, i ? [`t${i - 1}`] : []), expected);
    }
    expect(stop).toMatchObject({ ok: false, reason: "too-large" });
  } finally {
    stream.close();
  }
});

describe("daybreak2 (round 12): snapshot bodies are scanned before the synchronous step", () => {
  const setMany = (messages: { mesg: object; msgID: string }[]) => ({
    data: messages.map(({ mesg, msgID }) => ({
      msgID,
      messageData: {
        encoding: DataEncoding.MsgPack,
        raw: Buffer.from(encode({ encoding: DataEncoding.MsgPack, mesg })),
      },
    })),
  });
  // As server.ts runs it: prepared asynchronously, then the synchronous step.
  async function writePrepared(
    stream: PersistentStream,
    messages: { mesg: object; msgID: string }[],
  ) {
    const mesg = setMany(messages);
    const prepared = await prepareRequest({ cmd: "setMany" }, mesg);
    await prepareAppend(stream as any);
    const scans = jest.spyOn(jsonScan, "isJsonObjectLines");
    try {
      const records = requestRecords(
        { cmd: "setMany" },
        mesg,
        stream,
        prepared,
      )!;
      // As server.ts: the prepared check (it refuses if anything isn't ready).
      const append = appendCheckPrepared(stream as any, records);
      const results = stream.setMany(
        mesg.data.map(({ msgID, messageData }) => ({ msgID, ...messageData })),
        { allOrNothing: true, strictMsgID: true },
      );
      commitAppend(stream as any, append, results as { seq: number }[]);
      // Nothing was scanned synchronously.
      expect(scans).not.toHaveBeenCalled();
    } finally {
      scans.mockRestore();
    }
  }

  test("a prepared request and graph: no synchronous scan, same verdicts", async () => {
    const stream = newStream();
    try {
      await writePrepared(stream, [{ mesg: patch("t0"), msgID: "p0" }]);
      await writePrepared(stream, [{ mesg: snapshot("t0"), msgID: "s0" }]);
      // A fresh process: the graph (with a stored snapshot) is read again,
      // its bodies scanned in prepareAppend.
      const { forgetAppendHead } = require("./board-append");
      forgetAppendHead(stream);
      await writePrepared(stream, [{ mesg: patch("t1", ["t0"]), msgID: "p1" }]);
      expect(opens(stream)).toMatchObject({ ok: true, head: "t1" });
    } finally {
      stream.close();
    }
  });

  test("a prepared snapshot that isn't a board document is refused, nothing stored", async () => {
    const stream = newStream();
    try {
      write(stream, [{ mesg: patch("t0"), msgID: "p0" }]);
      const mesg = setMany([
        { mesg: { ...snapshot("t0"), snapshot: "{" }, msgID: "s0" },
      ]);
      const prepared = await prepareRequest({ cmd: "setMany" }, mesg);
      expect(prepared![0]).toMatchObject({ document: false });
      const records = requestRecords(
        { cmd: "setMany" },
        mesg,
        stream,
        prepared,
      )!;
      expect(() => appendCheck(stream as any, records)).toThrow(
        expect.objectContaining({ code: "branch" }),
      );
      expect([...stream.getAll()]).toHaveLength(1);
    } finally {
      stream.close();
    }
  });

  test("prepared values are used only for exactly the bytes they were prepared from", async () => {
    const mesg = setMany([{ mesg: snapshot("t0"), msgID: "s0" }]);
    const prepared = await prepareRequest({ cmd: "setMany" }, mesg);
    // Other bytes in the same position: decoded and scanned again.
    const other = setMany([
      { mesg: { ...snapshot("t0"), snapshot: "{" }, msgID: "s0" },
    ]);
    const [r] = requestRecords({ cmd: "setMany" }, other, undefined, prepared)!;
    expect(r.document).toBeUndefined();
    expect((r.value as any).snapshot).toBe("{");
  });
});

describe("round 14: the prepared graph cache", () => {
  const raw = (mesg: object) =>
    Buffer.from(encode({ encoding: DataEncoding.MsgPack, mesg }));
  const request = (mesg: object, msgID: string) => ({
    data: [
      {
        msgID,
        messageData: { encoding: DataEncoding.MsgPack, raw: raw(mesg) },
      },
    ],
  });
  const { forgetAppendHead } = require("./board-append");
  // A, snapshot(A), B, C: seqs 1-4.
  function history() {
    const stream = newStream();
    write(stream, [{ mesg: patch("A"), msgID: "a" }]);
    write(stream, [{ mesg: snapshot("A"), msgID: "sa" }]);
    write(stream, [{ mesg: patch("B", ["A"]), msgID: "b" }]);
    write(stream, [{ mesg: patch("C", ["B"]), msgID: "c" }]);
    // A fresh process: no cached graph.
    forgetAppendHead(stream);
    return stream;
  }

  test.each([true, false])(
    "astra CORR-7B0-1: a delete while it prepares is never cached over (forgetAppendHead too: %s)",
    async (forget) => {
      const stream = history();
      try {
        const preparing = prepareAppend(stream as any);
        // While it yields: B (seq 3) is deleted; the newest seq stays 4.
        if (forget) forgetAppendHead(stream);
        stream.delete({ seq: 3 } as any);
        expect(stream.seqBounds().newest_retained_seq).toBe(4);
        expect(await preparing).toBe(true);
        // What it cached is the stream as it is now: C's parent is gone, so
        // nothing may be appended (as the open check says).
        expect(opens(stream)).toMatchObject({ ok: false });
        const mesg = request(patch("D", ["C"]), "d");
        const prepared = await prepareRequest({ cmd: "setMany" }, mesg);
        const records = requestRecords(
          { cmd: "setMany" },
          mesg,
          stream,
          prepared,
        )!;
        expect(() => appendCheckPrepared(stream as any, records)).toThrow(
          expect.objectContaining({ code: "branch" }),
        );
        expect([...stream.getAll()]).toHaveLength(3);
      } finally {
        stream.close();
      }
    },
  );

  test('daybreak2: a stream that keeps changing is refused "board-retry"; nothing is read or scanned synchronously', async () => {
    const stream = history();
    try {
      const preparing = prepareAppend(stream as any, 1);
      // A write by another path while it yields.
      stream.set({
        encoding: DataEncoding.MsgPack,
        raw: raw(patch("X", ["C"])),
      });
      expect(await preparing).toBe(false);
      const mesg = request(patch("D", ["C"]), "d");
      const prepared = await prepareRequest({ cmd: "setMany" }, mesg);
      const records = requestRecords(
        { cmd: "setMany" },
        mesg,
        stream,
        prepared,
      )!;
      const scans = jest.spyOn(jsonScan, "isJsonObjectLines");
      const reads = jest.spyOn(stream, "getAll");
      try {
        // A retryable refusal before anything is stored: not a fence
        // refusal, so the writer keeps its edits and its save retries.
        expect(() => appendCheckPrepared(stream as any, records)).toThrow(
          expect.objectContaining({ code: "board-retry" }),
        );
        expect(scans).not.toHaveBeenCalled();
        expect(reads).not.toHaveBeenCalled();
      } finally {
        scans.mockRestore();
        reads.mockRestore();
      }
      expect([...stream.getAll()]).toHaveLength(5);
      // Once the stream is quiet, it prepares, and the append is checked
      // (X is the head now, so D after C is a branch).
      expect(await prepareAppend(stream as any)).toBe(true);
      expect(() => appendCheckPrepared(stream as any, records)).toThrow(
        expect.objectContaining({ code: "branch" }),
      );
    } finally {
      stream.close();
    }
  });

  test("reads never change the revision: a quiet stream prepares at once", async () => {
    const stream = history();
    try {
      expect(await prepareAppend(stream as any, 1)).toBe(true);
      [...stream.getAll()];
      stream.seqBounds();
      stream.config();
      expect(await prepareAppend(stream as any, 1)).toBe(true);
    } finally {
      stream.close();
    }
  });

  // A stream of n records that counts how many were read.
  function counting(n: number, at: (i: number) => object, size = 0) {
    let read = 0;
    const pad = "x".repeat(size);
    const stream = {
      seqBounds: () => ({ newest_retained_seq: n }),
      mutationCount: () => 0,
      msgIDOutcome: () => "new" as const,
      *getAll() {
        for (let i = 0; i < n; i++) {
          read += 1;
          yield {
            encoding: DataEncoding.MsgPack,
            raw: raw({ ...at(i), ...(size ? { pad } : {}) }),
          };
        }
      },
    };
    return { stream, read: () => read };
  }

  test("astra LIMIT-7B0-1: an invalid first record stops the read there", async () => {
    const { stream, read } = counting(20_000, (i) =>
      i === 0 ? { not: "a board record" } : patch(`t${i}`),
    );
    expect(await prepareAppend(stream as any)).toBe(true);
    expect(read()).toBe(1);
  });

  test("astra LIMIT-7B0-1: the read stops past the history's total bytes", async () => {
    // 1 MiB records, a valid chain: at most 64 MiB (plus the one past it).
    const { stream, read } = counting(
      200,
      (i) =>
        patch(
          `t${String(i).padStart(4, "0")}`,
          i ? [`t${String(i - 1).padStart(4, "0")}`] : [],
        ),
      1024 * 1024,
    );
    expect(await prepareAppend(stream as any)).toBe(true);
    expect(read()).toBeLessThanOrEqual(
      Math.ceil(BOARD_HISTORY_LIMITS.totalBytes / (1024 * 1024)) + 1,
    );
  });
});
