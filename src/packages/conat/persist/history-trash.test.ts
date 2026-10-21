/*
Bounded reset work (bounded history plan H1c r4): the live counts, the
delete notification's `through`, trash and its non-circular admission, the
one-budget step, and the one process-wide scheduler.
*/

import { mkdtempSync, rmSync, statSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  COUNT_PROBE_RECORDS,
  PersistentStream,
  RESET_DELETE_LIST_MAX,
  registerTrashWorkForTests,
  runTrashTickForTests,
  trashSchedulerState,
  unregisterTrashWorkForTests,
} from "./storage";
import { initContext, syncFiles } from "./context";
import { DataEncoding, encode } from "@cocalc/conat/core/codec";

let dir: string;
let n = 0;
const streams: PersistentStream[] = [];

const LIMIT_ENV = [
  "COCALC_HISTORY_MAX_TRIM_RECORDS",
  "COCALC_HISTORY_MAX_TRIM_BYTES",
  "COCALC_HISTORY_MAX_TRASH_ITEMS",
  "COCALC_HISTORY_MAX_TRASH_RECORDS",
  "COCALC_HISTORY_MAX_TRASH_BYTES",
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
  dir = mkdtempSync(join(tmpdir(), "history-trash-"));
});

afterEach(() => {
  for (const s of streams.splice(0)) s.close();
  for (const name of LIMIT_ENV) delete process.env[name];
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function newPath() {
  return join(dir, `stream-${n++}`);
}

function open(path: string) {
  const s = new PersistentStream({ path, noCache: true } as any);
  streams.push(s);
  return s;
}

function close(s: PersistentStream) {
  s.close();
  streams.splice(streams.indexOf(s), 1);
}

function write(
  s: PersistentStream,
  { msgID, epoch, key }: { msgID?: string; epoch?: number; key?: string } = {},
) {
  return s.set({
    encoding: DataEncoding.JsonCodec,
    raw: Buffer.from('"x"'),
    ...(epoch != null ? { headers: { history_epoch: epoch } } : {}),
    msgID,
    key,
  });
}

function snapshot(value: string) {
  return {
    encoding: DataEncoding.MsgPack,
    raw: Buffer.from(
      encode({
        encoding: DataEncoding.MsgPack,
        mesg: { is_snapshot: true, snapshot: value, time: "t" },
      }),
    ),
    msgID: `seed-${value}`,
    checkpoint: { name: "latest_snapshot", data: { patchId: "t" } },
  };
}

const sql = (s: PersistentStream, statement: string, ...params: any[]) =>
  s.sqlite(statement, params);

const counts = (s: PersistentStream) =>
  sql(s, "SELECT * FROM stream_counts WHERE id=1")[0];

const truth = (s: PersistentStream) =>
  sql(
    s,
    "SELECT COUNT(*) AS records, COALESCE(SUM(size), 0) AS bytes FROM messages",
  )[0];

// rows written as an older server would: no counts, no ids, no ledger
function legacyRows(path: string, rows: number, { ids = false } = {}) {
  const db = new DatabaseSync(path + ".db");
  db.exec(
    `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < ${rows})
     INSERT INTO messages(time, compress, encoding, raw, size) SELECT 1, 0, ${DataEncoding.JsonCodec}, CAST('"x"' AS BLOB), 3 FROM c`,
  );
  if (ids) {
    db.exec(
      "INSERT OR IGNORE INTO message_ids(seq, msg_id) SELECT seq, 'id' || seq FROM messages",
    );
  }
  db.close();
}

// a stream from before H1c: N messages and no stream_counts row
function legacyStream(rows: number, opts: { ids?: boolean } = {}) {
  const path = newPath();
  close(open(path));
  legacyRows(path, rows, opts);
  const db = new DatabaseSync(path + ".db");
  db.exec("DELETE FROM stream_counts");
  db.close();
  return { path, stream: open(path) };
}

function drain(s: PersistentStream, max = 10_000) {
  for (let i = 0; i < max; i++) {
    if (s.runTrashStep()) return i + 1;
  }
  throw Error("trash did not drain");
}

function judge(s: PersistentStream) {
  const { seq, count } = s.inventory();
  return { ifRevision: { seq, count }, coveredSeq: seq };
}

describe("live counts (H1c §1)", () => {
  it("every write site keeps the stored counts exact", () => {
    const s = open(newPath());
    const check = () => {
      const c = counts(s);
      const t = truth(s);
      expect(c.initialized).toBe(1);
      expect({ records: c.records, bytes: c.bytes }).toEqual(t);
      expect(s.inventory().count).toBe(t.records);
      expect(s.inventory().bytes).toBe(t.bytes);
    };
    for (let i = 0; i < 5; i++) write(s, { msgID: `m${i}` });
    check();
    write(s, { key: "k" });
    write(s, { key: "k" }); // replaces it
    check();
    s.delete({ seq: 1 });
    check();
    s.delete({ seqs: [2, 3] });
    check();
    s.delete({ last_seq: 4 });
    check();
    for (let i = 0; i < 4; i++) write(s);
    s.config({ max_msgs: 2 });
    write(s);
    check();
    s.delete({ all: true });
    check();
    expect(counts(s).counted_through_seq).toBe(
      sql(s, "SELECT seq FROM sqlite_sequence WHERE name='messages'")[0].seq,
    );
  });

  it("probes a stream from before H1c once, then counts it in bounded steps", () => {
    const rows = COUNT_PROBE_RECORDS + 5;
    // a small step budget, so the open's own step doesn't finish counting
    process.env.COCALC_HISTORY_MAX_TRIM_RECORDS = "4000";
    const { path, stream } = legacyStream(rows);
    expect(counts(stream).initialized).toBe(0);
    // "more than COUNT_PROBE_RECORDS", exactly
    expect(stream.inventory().count).toBe(COUNT_PROBE_RECORDS + 1);
    expect(stream.liveCountExact()).toBe(false);
    // 4,000 rows a step: the open counted 4,000; 2 more steps
    expect(drain(stream)).toBe(2);
    expect(stream.inventory().count).toBe(rows);
    expect(stream.inventory().bytes).toBe(rows * 3);
    close(stream);
    // not probed again
    const again = open(path);
    expect(counts(again).initialized).toBe(1);
    expect(again.inventory().count).toBe(rows);
  });

  it("counts again what an older server wrote during a rollback window", () => {
    const path = newPath();
    const s = open(path);
    for (let i = 0; i < 3; i++) write(s);
    close(s);
    // an older server ignores stream_counts
    legacyRows(path, 4);
    process.env.COCALC_HISTORY_MAX_TRIM_RECORDS = "2";
    const again = open(path);
    expect(counts(again).initialized).toBe(0);
    drain(again);
    expect(again.inventory().count).toBe(7);
  });

  it("while counting, a write still moves the revision; a delete-only change does not (accepted, narrow)", () => {
    process.env.COCALC_HISTORY_MAX_TRIM_RECORDS = "100";
    const { stream } = legacyStream(COUNT_PROBE_RECORDS + 2);
    const before = judge(stream);
    write(stream);
    expect(
      stream.resetHistory({ ...before, archive: true, seed: snapshot("v") })
        .refused,
    ).toBe("moved");
    const now = judge(stream);
    stream.delete({ seq: 1 });
    const r = stream.resetHistory({
      ...now,
      archive: true,
      seed: snapshot("v"),
    });
    expect(r.refused).toBeUndefined();
    expect(r.reset).toBe(true);
  });
});

describe("the delete notification (H1c §2)", () => {
  const deletes = (s: PersistentStream) => {
    const seen: any[] = [];
    s.on("change", (c: any) => {
      if (c.op === "delete") seen.push(c);
    });
    return seen;
  };

  it(`lists up to ${RESET_DELETE_LIST_MAX} seqs, and always says through`, () => {
    const { stream } = legacyStream(RESET_DELETE_LIST_MAX);
    const seen = deletes(stream);
    const last = stream.inventory().seq;
    stream.resetHistory({ archive: true });
    expect(seen).toHaveLength(1);
    expect(seen[0].through).toBe(last);
    expect(seen[0].seqs).toHaveLength(RESET_DELETE_LIST_MAX);
  });

  it("over that, only through: a change of constant size", () => {
    const { stream } = legacyStream(RESET_DELETE_LIST_MAX + 1);
    const seen = deletes(stream);
    const last = stream.inventory().seq;
    stream.resetHistory({ archive: true });
    expect(seen[0]).toEqual({ op: "delete", seqs: [], through: last });
    expect(JSON.stringify(seen[0]).length).toBeLessThan(1024);
  });
});

describe("a purge (H1c §3, §4)", () => {
  it("deletes nothing in its transaction; unreadable at once; removed in bounded steps", () => {
    process.env.COCALC_HISTORY_MAX_TRIM_RECORDS = "100";
    const s = open(newPath());
    for (let i = 0; i < 500; i++) write(s, { msgID: `m${i}` });
    const tablesBefore = sql(
      s,
      "SELECT name FROM sqlite_master WHERE name LIKE 'messages_archived_%'",
    );
    expect(tablesBefore).toEqual([]);
    expect(s.resetHistory({}).reset).toBe(true);
    // the old messages, all still there, in a renamed table nothing reads
    const [{ name }] = sql(
      s,
      "SELECT name FROM sqlite_master WHERE name LIKE 'messages_archived_%'",
    );
    expect(sql(s, `SELECT COUNT(*) AS n FROM "${name}"`)[0].n).toBe(500);
    expect([...s.getAll()]).toEqual([]);
    expect(counts(s).trash_items).toBeGreaterThan(0);
    // each step deletes at most maxTrimRecords rows, across every kind
    const remaining = () =>
      (sql(s, "SELECT name FROM sqlite_master WHERE name=?", name).length
        ? sql(s, `SELECT COUNT(*) AS n FROM "${name}"`)[0].n
        : 0) + sql(s, "SELECT COUNT(*) AS n FROM message_ids")[0].n;
    let left = remaining();
    for (let i = 0; i < 100 && !s.runTrashStep(); i++) {
      const now = remaining();
      expect(left - now).toBeLessThanOrEqual(100);
      expect(left - now).toBeGreaterThan(0);
      left = now;
    }
    expect(remaining()).toBe(0);
    expect(counts(s)).toMatchObject({
      trash_items: 0,
      trash_records: 0,
      trash_bytes: 0,
      trash_unknown_items: 0,
    });
  });
});

describe("non-circular admission (H1c §3.3)", () => {
  it("admits the first reset of any stream, even one still being counted", () => {
    process.env.COCALC_HISTORY_MAX_TRIM_RECORDS = "100";
    const { stream } = legacyStream(COUNT_PROBE_RECORDS + 50, { ids: true });
    expect(stream.liveCountExact()).toBe(false);
    const result = stream.resetHistory({});
    expect(result.reset).toBe(true);
    expect(result.countExact).toBe(false);
    expect(counts(stream).trash_unknown_items).toBeGreaterThan(0);
  });

  it("a later reset waits for the trash, changing nothing; every retry makes progress", () => {
    process.env.COCALC_HISTORY_MAX_TRIM_RECORDS = "1000";
    const { stream } = legacyStream(COUNT_PROBE_RECORDS + 50, { ids: true });
    stream.resetHistory({});
    const epoch = stream.historyEpochNow();
    const pendingRows = () =>
      sql(
        stream,
        "SELECT name FROM sqlite_master WHERE name LIKE 'messages_archived_%'",
      ).reduce(
        (sum: number, { name }: any) =>
          sum + sql(stream, `SELECT COUNT(*) AS n FROM "${name}"`)[0].n,
        0,
      ) + sql(stream, "SELECT COUNT(*) AS n FROM message_ids")[0].n;
    let refused = 0;
    for (let i = 0; i < 100; i++) {
      const before = pendingRows();
      const result = stream.resetHistory({});
      if (result.reset) break;
      refused += 1;
      expect(result.refused).toBe("trash-pending");
      expect(stream.historyEpochNow()).toBe(epoch);
      // 4 steps of at most 1,000 rows each, and at least one
      const removed = before - pendingRows();
      expect(removed).toBeGreaterThan(0);
      expect(removed).toBeLessThanOrEqual(4000);
    }
    expect(refused).toBeGreaterThan(0);
    expect(stream.historyEpochNow()).toBe(epoch + 1);
  });

  it("under the cap, a full trash drains within 3 retries", () => {
    process.env.COCALC_HISTORY_MAX_TRIM_RECORDS = "10";
    process.env.COCALC_HISTORY_MAX_TRASH_RECORDS = "100";
    const s = open(newPath());
    for (let i = 0; i < 60; i++) write(s);
    s.resetHistory({});
    for (let i = 0; i < 60; i++) write(s, { epoch: s.historyEpochNow() });
    let tries = 0;
    while (!s.resetHistory({}).reset) tries += 1;
    expect(tries).toBeLessThanOrEqual(3);
  });

  it("never holds more than maxTrashItems items", () => {
    process.env.COCALC_HISTORY_MAX_TRIM_RECORDS = "1";
    process.env.COCALC_HISTORY_MAX_TRASH_ITEMS = "4";
    const s = open(newPath());
    let refused = 0;
    for (let round = 0; round < 12; round++) {
      for (let i = 0; i < 3; i++) {
        write(s, { epoch: s.historyEpochNow(), msgID: `r${round}-${i}` });
      }
      if (!s.resetHistory({}).reset) refused += 1;
      expect(counts(s).trash_items).toBeLessThanOrEqual(4);
    }
    expect(refused).toBeGreaterThan(0);
  });

  it("keeps an unknown item across reopen until it is gone", () => {
    process.env.COCALC_HISTORY_MAX_TRIM_RECORDS = "100";
    const { path, stream } = legacyStream(COUNT_PROBE_RECORDS + 50);
    stream.resetHistory({});
    expect(counts(stream).trash_unknown_items).toBe(1);
    close(stream);
    const again = open(path);
    expect(counts(again).trash_unknown_items).toBe(1);
    drain(again);
    expect(counts(again).trash_unknown_items).toBe(0);
    expect(again.resetHistory({}).reset).toBe(true);
  });

  it("removing an item subtracts exactly its charge (minimum included); totals never go negative", () => {
    const s = open(newPath());
    // an empty purge: one item, charged the minimum
    s.resetHistory({});
    const charged = counts(s);
    expect(charged.trash_items).toBe(1);
    expect(charged.trash_records).toBe(1);
    expect(charged.trash_bytes).toBe(4096);
    drain(s);
    expect(counts(s)).toMatchObject({
      trash_items: 0,
      trash_records: 0,
      trash_bytes: 0,
    });
  });
});

describe("one step, one budget (H1c §5)", () => {
  it("removes at most maxTrimRecords rows and maxTrimBytes plus one message across every kind", () => {
    process.env.COCALC_HISTORY_MAX_ARCHIVED_ID_EPOCHS = "1";
    const path = newPath();
    const s = open(path);
    for (let i = 0; i < 200; i++) {
      write(s, { msgID: `a${i}` });
      if (i % 10 == 9) {
        s.setCheckpoint({ name: "latest_snapshot", seq: s.inventory().seq });
      }
    }
    // a purge (messages, ids, cuts), then a stale count (an older server)
    s.resetHistory({});
    close(s);
    legacyRows(path, 50);
    process.env.COCALC_HISTORY_MAX_TRIM_RECORDS = "37";
    process.env.COCALC_HISTORY_MAX_TRIM_BYTES = "40";
    const t = open(path);
    const tally = () => {
      const trash = sql(
        t,
        "SELECT name FROM sqlite_master WHERE name LIKE 'messages_archived_%'",
      );
      return {
        rows:
          trash.reduce(
            (sum: number, { name }: any) =>
              sum + sql(t, `SELECT COUNT(*) AS n FROM "${name}"`)[0].n,
            0,
          ) +
          sql(t, "SELECT COUNT(*) AS n FROM message_ids")[0].n +
          sql(t, "SELECT COUNT(*) AS n FROM history_cuts")[0].n,
        bytes: trash.reduce(
          (sum: number, { name }: any) =>
            sum +
            sql(t, `SELECT COALESCE(SUM(size), 0) AS b FROM "${name}"`)[0].b,
          0,
        ),
        counted: Number(counts(t).init_cursor ?? 0),
      };
    };
    let before = tally();
    for (let i = 0; i < 500; i++) {
      const done = t.runTrashStep();
      const after = tally();
      const counted = Math.max(0, after.counted - before.counted);
      expect(before.rows - after.rows + counted).toBeLessThanOrEqual(37);
      // 40 bytes, plus one message (3 bytes) only as a step's first row
      expect(before.bytes - after.bytes).toBeLessThanOrEqual(40 + 3);
      before = after;
      if (done) break;
    }
    expect(before.rows).toBe(0);
  });
});

describe("the one scheduler (H1c §5)", () => {
  it("one timer and at most 8 steps a tick, for any number of streams", () => {
    process.env.COCALC_HISTORY_MAX_TRIM_RECORDS = "1";
    const many: PersistentStream[] = [];
    for (let i = 0; i < 50; i++) {
      const s = open(newPath());
      for (let j = 0; j < 20; j++) write(s, { msgID: `m${j}` });
      s.resetHistory({});
      many.push(s);
    }
    expect(trashSchedulerState().timers).toBe(1);
    expect(trashSchedulerState().queued).toBeGreaterThanOrEqual(50);
    let steps = 0;
    for (const s of many) {
      const run = s.runTrashStep;
      (s as any).runTrashStep = () => {
        steps += 1;
        return run();
      };
    }
    runTrashTickForTests();
    expect(steps).toBeLessThanOrEqual(8);
    expect(trashSchedulerState().timers).toBe(1);
    for (const s of many) close(s);
    expect(trashSchedulerState().queued).toBe(0);
  });

  it("serves blocked streams first, sharing 4 steps among them", () => {
    let ran: string[] = [];
    const worker = (name: string) => ({
      trashGeneration: 0,
      isClosing: () => false,
      runTrashStep: () => {
        ran.push(name);
        return false;
      },
    });
    const idle = Array.from({ length: 10 }, (_, i) => worker(`idle${i}`));
    const blocked = Array.from({ length: 6 }, (_, i) => worker(`b${i}`));
    for (const w of idle) registerTrashWorkForTests(w);
    for (const w of blocked) registerTrashWorkForTests(w, true);
    runTrashTickForTests();
    expect(ran).toHaveLength(8);
    expect(ran.slice(0, 4).every((name) => name.startsWith("b"))).toBe(true);
    ran = [];
    runTrashTickForTests();
    // round-robin: the other blocked streams get their turn
    expect(ran.slice(0, 4).every((name) => name.startsWith("b"))).toBe(true);
    for (const w of [...idle, ...blocked]) unregisterTrashWorkForTests(w);
  });

  it("never runs work selected for an old generation (close, or a restore)", () => {
    let ran = 0;
    const w = {
      trashGeneration: 0,
      isClosing: () => false,
      runTrashStep: () => {
        ran += 1;
        return false;
      },
    };
    registerTrashWorkForTests(w);
    // the fence: a new generation before the tick runs
    w.trashGeneration += 1;
    runTrashTickForTests();
    expect(ran).toBe(0);
    expect(trashSchedulerState().queued).toBe(0);
  });

  it("a reopened stream finishes its trash; an old object never registers again", () => {
    process.env.COCALC_HISTORY_MAX_TRIM_RECORDS = "5";
    const path = newPath();
    const s = open(path);
    for (let i = 0; i < 40; i++) write(s, { msgID: `m${i}` });
    s.resetHistory({});
    close(s);
    const queued = trashSchedulerState().queued;
    // the closed object, registering again, is dropped at the tick
    s.runTrashStep();
    const again = open(path);
    drain(again);
    expect(counts(again).trash_items).toBe(0);
    expect(trashSchedulerState().queued).toBeLessThanOrEqual(queued + 1);
  });
});

describe("cleanup is safe at every step (H1c §4)", () => {
  it("never yields absent for an expired or purged epoch, and never changes the epoch, fence, reset marker or ops", () => {
    process.env.COCALC_HISTORY_MAX_TRIM_RECORDS = "3";
    process.env.COCALC_HISTORY_MAX_ARCHIVED_ID_EPOCHS = "1";
    const s = open(newPath());
    for (let i = 0; i < 20; i++) write(s, { msgID: `e0-${i}` });
    let r = s.resetHistory({
      ...judge(s),
      archive: true,
      seed: snapshot("1"),
      opId: "one",
      settings: { history_reset: { reason: "test" } },
    });
    expect(r.reset).toBe(true);
    r = s.resetHistory({ ...judge(s), archive: true, seed: snapshot("2") });
    expect(r.reset).toBe(true);
    const fixed = () => ({
      epoch: s.historyEpochNow(),
      fence: sql(s, "SELECT value FROM config WHERE field='required_headers'"),
      ops: sql(s, "SELECT op_id, result_json FROM history_ops ORDER BY op_id"),
      metadata: s.getMetadata(),
    });
    const before = fixed();
    for (let i = 0; i < 200; i++) {
      const ids = s.historyInclusion({
        epoch: 0,
        ids: ["e0-0", "e0-19", "never"],
      }).ids;
      for (const id of Object.keys(ids)) {
        expect(ids[id].status).not.toBe("absent");
      }
      expect(fixed()).toEqual(before);
      if (s.runTrashStep()) break;
    }
    expect(fixed()).toEqual(before);
  });
});
