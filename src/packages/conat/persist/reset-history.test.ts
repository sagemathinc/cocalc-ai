/*
PersistentStream.resetHistory resets a sync document's history in one
transaction: fence, new epoch in the metadata, and the old messages deleted or
kept aside in a table of their own.
*/

import { PersistentStream } from "./storage";
import { initContext, syncFiles } from "./context";
import { DatabaseSync } from "node:sqlite";
import { statSync, copyFileSync } from "node:fs";

let stream: PersistentStream;

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
  process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES = "100";
});

afterAll(() => {
  delete process.env.COCALC_PERSIST_MAX_MESSAGE_BYTES;
});

beforeEach(() => {
  stream = new PersistentStream({
    path: "/tmp/reset-history-test",
    ephemeral: true,
  });
});

afterEach(() => {
  stream.close();
});

function write(bytes: number, history_epoch?: number) {
  return stream.set({
    encoding: "json" as any,
    raw: Buffer.from(`"${"x".repeat(bytes)}"`),
    ...(history_epoch != null ? { headers: { history_epoch } } : {}),
  });
}

function tables(): string[] {
  return stream
    .sqlite("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .map(({ name }) => name);
}

const archives = () =>
  tables().filter((name) => name.startsWith("messages_archived_"));

// H1c: a purge leaves its table as counted trash and earlier archives
// unreferenced (plan §3.1 (a) and (e)): unreadable at commit, removed in
// bounded steps; check that, then remove them
function expectOnlyTrash() {
  expect(
    stream.sqlite(
      "SELECT archive FROM history_epochs WHERE archive IS NOT NULL",
    ),
  ).toEqual([]);
  expect(
    stream.sqlite("SELECT 1 FROM history_trash WHERE kind='messages'"),
  ).toHaveLength(1);
  while (!stream.runTrashStep());
  expect(archives()).toEqual([]);
}

describe("resetHistory", () => {
  it("fences, publishes the new epoch, and deletes the history; seqs continue", () => {
    stream.setMetadata({ users: ["a"], settings: { other: 1 } });
    write(10);
    const { seq: last } = write(10);
    const changes: string[] = [];
    stream.on("change", (change) => changes.push(change.op ?? "set"));

    const result = stream.resetHistory({
      settings: { history_purged_by: "me" },
    });
    expect(result).toEqual({ reset: true, history_epoch: 1, count: 2 });
    expect(stream.length).toBe(0);
    expectOnlyTrash();
    // other metadata and settings are kept
    expect(stream.getMetadata()).toEqual({
      users: ["a"],
      settings: { other: 1, history_purged_by: "me", history_epoch: 1 },
    });
    // metadata first, so open copies close before their history disappears
    expect(changes).toEqual(["metadata", "delete", "checkpoints"]);
    // writes from older epochs are rejected
    expect(() => write(10)).toThrow("required header mismatch");
    expect(() => write(10, 0)).toThrow("required header mismatch");
    expect(write(10, 1).seq).toBe(last + 1);
  });

  it("archives the history in a table of its own, keeping the indexes and seqs working", () => {
    write(10);
    write(200);
    const { seq: last } = write(10);
    const result = stream.resetHistory({ archive: true });
    expect(result.reset).toBe(true);
    expect(result.count).toBe(3);
    expect(archives()).toEqual([result.archive]);
    expect(
      stream.sqlite(`SELECT COUNT(*) AS n FROM "${result.archive}"`)[0].n,
    ).toBe(3);
    expect(stream.length).toBe(0);
    // the new history continues the old sequence numbers, and keys still work
    expect(write(10, 1).seq).toBe(last + 1);
    stream.set({
      key: "k",
      encoding: "json" as any,
      raw: Buffer.from("1"),
      headers: { history_epoch: 1 },
    });
    stream.set({
      key: "k",
      encoding: "json" as any,
      raw: Buffer.from("2"),
      headers: { history_epoch: 1 },
    });
    expect(stream.keys()).toEqual(["k"]);
    // the new table's indexes have the next generation's names; the
    // archived table keeps its own (H1c: dropping them is O(index pages))
    expect(
      stream
        .sqlite(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='messages' ORDER BY name",
        )
        .map(({ name }) => name),
    ).toEqual(
      expect.arrayContaining(["idx_messages_key_g1", "idx_messages_time_g1"]),
    );
    expect(
      stream
        .sqlite(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? ORDER BY name",
          [result.archive],
        )
        .map(({ name }) => name),
    ).toEqual(
      expect.arrayContaining(["idx_messages_key", "idx_messages_time"]),
    );
  });

  it("with ifOversizedSeq, only resets while that message is too large to load", () => {
    const { seq: small } = write(10);
    const { seq: big } = write(200);
    expect(stream.resetHistory({ ifOversizedSeq: small })).toEqual({
      reset: false,
      history_epoch: 0,
      count: 0,
      refused: "not-oversized",
    });
    expect(stream.length).toBe(2);

    const first = stream.resetHistory({ ifOversizedSeq: big, archive: true });
    expect(first).toMatchObject({ reset: true, history_epoch: 1, count: 2 });
    write(10, 1);
    // a second reset for the same message changes nothing, so it cannot
    // remove what was written since
    const second = stream.resetHistory({ ifOversizedSeq: big, archive: true });
    expect(second).toEqual({
      reset: false,
      history_epoch: 1,
      count: 0,
      refused: "not-oversized",
    });
    expect(stream.length).toBe(1);
    expect(archives()).toHaveLength(1);
    expect(write(10, 1).seq).toBeGreaterThan(big);
  });

  it("chooses an epoch above the metadata's, the fence's, and minEpoch", () => {
    stream.setMetadata({ settings: { history_epoch: 4 } });
    expect(stream.resetHistory({}).history_epoch).toBe(5);
    stream.config({ required_headers: { history_epoch: 9 } });
    expect(stream.resetHistory({}).history_epoch).toBe(10);
    expect(stream.resetHistory({ minEpoch: 20 }).history_epoch).toBe(21);
    expect(stream.config().required_headers).toEqual({ history_epoch: 21 });
  });

  it("a reset without archive also drops the history kept by earlier resets", () => {
    write(200);
    stream.resetHistory({ archive: true });
    write(200, 1);
    stream.resetHistory({ archive: true });
    expect(archives()).toHaveLength(2);
    write(10, 2);
    expect(stream.resetHistory({})).toMatchObject({ reset: true, count: 1 });
    expectOnlyTrash();
    expect(stream.length).toBe(0);
  });
});
