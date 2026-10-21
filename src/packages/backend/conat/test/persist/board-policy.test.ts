/*
A board's stream through real persist servers: the ordinary service only
reads it, and only the board write service (as the hub) writes it.
*/

import * as setup from "@cocalc/backend/conat/test/setup";
import { before, after, connect } from "@cocalc/backend/conat/test/setup";
import { BOARD_WRITE_MAX_TTL_MS } from "@cocalc/conat/persist/board-write-fence";
import { dstream } from "@cocalc/conat/sync/dstream";
import { astream } from "@cocalc/conat/sync/astream";
import {
  BOARD_WRITE_RECEIVE_LIMITS,
  BOARD_WRITE_SERVICE,
} from "@cocalc/conat/persist/board-policy";
import { messageData } from "@cocalc/conat/core/client";
import { patchesStreamName } from "@cocalc/conat/sync/synctable-stream";
import { boardSyncdbPath } from "@cocalc/util/board/names";
import { uuid } from "@cocalc/util/misc";
import { stream as persistStream } from "@cocalc/conat/persist/client";
import { storagePath } from "@cocalc/conat/sync/core-stream";
import { syncFiles } from "@cocalc/conat/persist/context";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

beforeAll(before);
afterAll(after);

jest.setTimeout(30_000);

// A board patch record (as SyncDoc writes them): the board write service
// stores only patches that extend the stream's one chain.
const rec = (n: number, prev?: number) => ({
  time: `t${n}`,
  parents: prev == null ? [] : [`t${prev}`],
  patch: "[]",
});

const name = (path: string) =>
  patchesStreamName({ path: boardSyncdbPath(path) });

// The fence a board writer sends: the test server's current nonce.
const fence = (nonce = setup.boardWriteFence!.nonce) => ({
  expectedNonce: nonce,
  ttlMs: BOARD_WRITE_MAX_TTL_MS,
});

function writerStream(project_id: string, path: string) {
  return dstream({
    client: connect(),
    project_id,
    name: name(path),
    service: BOARD_WRITE_SERVICE,
    persistUser: {},
    writeFence: fence(),
    noInventory: true,
  });
}

function readerStream(project_id: string, path: string, opts = {}) {
  return dstream({
    client: connect(),
    project_id,
    name: name(path),
    noInventory: true,
    ...opts,
  });
}

test("the write service writes a board stream; the ordinary service reads it", async () => {
  const project_id = uuid();
  const path = "/home/user/plan.board.json";
  const writer = await writerStream(project_id, path);
  writer.publish(rec(1));
  await writer.save();
  const reader = await readerStream(project_id, path);
  expect(reader.getAll()).toEqual([rec(1)]);
  // The reader sees the writer's later changes.
  writer.publish(rec(2, 1));
  await writer.save();
  await waitFor(() => reader.length === 2);
  writer.close();
  reader.close();
});

test("the ordinary service refuses every write to a board stream", async () => {
  const project_id = uuid();
  const path = "/home/user/plan.board.json";
  const writer = await writerStream(project_id, path);
  writer.publish(rec(1));
  await writer.save();
  const reader = await readerStream(project_id, path);
  // A client that writes anyway: the server refuses it (a client keeps
  // retrying a refused write, as for any write error; only the host writes
  // board streams, so no supported client does this).
  reader.publish(rec(9, 1));
  void reader.save().catch(() => {});
  await new Promise((r) => setTimeout(r, 1000));
  // Nothing reached the stream.
  const check = await readerStream(project_id, path);
  expect(check.getAll()).toEqual([rec(1)]);
  writer.close();
  reader.close();
  check.close();
});

test("one client's reader and writer of a board stream are different streams, in either order", async () => {
  for (const readerFirst of [true, false]) {
    const project_id = uuid();
    const path = "/home/user/cached.board.json";
    const client = connect();
    const open = (write: boolean) =>
      dstream({
        client,
        project_id,
        name: name(path),
        noInventory: true,
        ...(write
          ? {
              service: BOARD_WRITE_SERVICE,
              persistUser: {},
              writeFence: fence(),
            }
          : {}),
      });
    const first = await open(!readerFirst);
    const second = await open(readerFirst);
    const [reader, writer] = readerFirst ? [first, second] : [second, first];
    expect(reader === writer).toBe(false);
    // The writer writes, though a reader of the stream was opened first...
    writer.publish(rec(1));
    await writer.save();
    // ...and the reader can't, though a writer was opened first.
    reader.publish(rec(9, 1));
    void reader.save().catch(() => {});
    await new Promise((r) => setTimeout(r, 1000));
    const check = await readerStream(project_id, path);
    expect(check.getAll()).toEqual([rec(1)]);
    reader.close();
    writer.close();
    check.close();
  }
});

test("an astream with the writer's route asks as the hub, with its fence (as a board's history reset does)", async () => {
  const project_id = uuid();
  const path = "/home/user/astream.board.json";
  const s = astream({
    client: connect(),
    project_id,
    name: name(path),
    service: BOARD_WRITE_SERVICE,
    persistUser: {},
    writeFence: fence(),
    noInventory: true,
  });
  // Through the board write service as the hub, fenced: accepted (as a project,
  // the write service would refuse the connection).
  await s.publish(rec(1));
  s.close();
  const reader = await readerStream(project_id, path);
  expect(reader.getAll()).toEqual([rec(1)]);
  reader.close();
});

test("a reader can't make a board stream ephemeral", async () => {
  const project_id = uuid();
  const path = "/home/user/ephemeral.board.json";
  // The first opener asks for in-memory storage...
  const sneaky = await readerStream(project_id, path, { ephemeral: true });
  // ...but the board's stream is the durable one the writer uses.
  const writer = await writerStream(project_id, path);
  writer.publish(rec(1));
  await writer.save();
  await waitFor(() => sneaky.length === 1);
  // Durable: the board's database is on disk (a RAM stream would leave no
  // file), whatever the first opener asked for.
  const files = await listFiles(syncFiles.local!);
  expect(
    files.some((f) => f.includes(project_id) && f.endsWith(".sage-board.db")),
  ).toBe(true);
  sneaky.close();
  writer.close();
});

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(p)));
    else out.push(p);
  }
  return out;
}

test("a first reader can't choose how the host's writes are stored", async () => {
  const project_id = uuid();
  const path = "/home/user/options.board.json";
  // A reader opens the board stream first, with options no host would use.
  const raw = persistStream({
    client: connect(),
    user: { project_id },
    storage: {
      path: storagePath({ project_id, name: name(path) }),
      compression: { algorithm: 99, threshold: 0 },
      sync: true,
      surprise: "field",
    } as any,
  });
  await raw.getAll();
  // The host's writes go through, stored with the server's own options.
  const writer = await writerStream(project_id, path);
  writer.publish({ ...rec(1), patch: JSON.stringify("x".repeat(10_000)) });
  await writer.save();
  const check = await readerStream(project_id, path);
  expect(check.getAll()).toEqual([
    { ...rec(1), patch: JSON.stringify("x".repeat(10_000)) },
  ]);
  raw.close();
  writer.close();
  check.close();
});

test("the write service refuses streams that aren't boards", async () => {
  const project_id = uuid();
  await expect(
    dstream({
      client: connect(),
      project_id,
      name: "patchflow/home/user/notes.txt",
      service: BOARD_WRITE_SERVICE,
      persistUser: {},
      noInventory: true,
    }),
  ).rejects.toThrow(/only board streams/);
});

test("the write service refuses anyone but the hub", async () => {
  const project_id = uuid();
  await expect(
    dstream({
      client: connect(),
      project_id,
      name: name("/home/user/plan.board.json"),
      service: BOARD_WRITE_SERVICE,
      noInventory: true,
    }),
  ).rejects.toThrow(/only the host/);
});

describe("the write service's transport bounds", () => {
  const MiB = 1024 * 1024;

  function hubStream(project_id: string, path: string) {
    return persistStream({
      client: connect(),
      user: {},
      storage: { path: storagePath({ project_id, name: name(path) }) },
      service: BOARD_WRITE_SERVICE,
      writeFence: fence(),
    });
  }

  test("the limits are the design's: 8 MiB a message, 16 MiB and 8 messages in flight", () => {
    expect(BOARD_WRITE_RECEIVE_LIMITS).toEqual({
      maxMessageBytes: 8 * MiB,
      maxInflightBytes: 16 * MiB,
      maxInflightMessages: 8,
    });
  });

  test("a message too big to be a snapshot is dropped before reassembly; the stream still works", async () => {
    const project_id = uuid();
    const raw = hubStream(project_id, "/home/user/big.board.json");
    // Never assembled, so never answered: the writer times out.
    await expect(
      raw.set({
        messageData: messageData(null, { raw: Buffer.alloc(9 * MiB) }),
        timeout: 3000,
      }),
    ).rejects.toThrow(/timeout/i);
    const { seq } = await raw.set({
      messageData: messageData(rec(1)),
      timeout: 10_000,
    });
    expect(seq).toBeGreaterThan(0);
    raw.close();
  });

  test("a snapshot-sized message gets through", async () => {
    const project_id = uuid();
    const raw = hubStream(project_id, "/home/user/snapshot.board.json");
    // A snapshot is of a stored patch (the append rule).
    await raw.set({ messageData: messageData(rec(1)), timeout: 10_000 });
    const { seq } = await raw.set({
      // A snapshot record of a board near the editable limit.
      messageData: messageData({
        time: "t1",
        is_snapshot: true,
        // (A board document: one JSON object per line.)
        snapshot: `{"t":"${"x".repeat(7 * MiB - 8)}"}`,
        seq_info: { seq: 1 },
      }),
      timeout: 20_000,
    });
    expect(seq).toBeGreaterThan(0);
    raw.close();
  });

  test("the write service's load balancer ignores a large lookup", async () => {
    const client = connect();
    const subject = `${BOARD_WRITE_SERVICE}.hub.id`;
    await expect(
      client.request(subject, null, {
        raw: Buffer.alloc(128 * 1024),
        timeout: 2000,
      }),
    ).rejects.toThrow(/timeout/i);
    const reply = await client.request(subject, null, { timeout: 5000 });
    expect(reply.data).toBeTruthy();
  });

  test("the write service's status server ignores a large ping", async () => {
    const client = connect();
    const subject = `${BOARD_WRITE_SERVICE}.hub.server.status`;
    await expect(
      client.request(subject, null, {
        raw: Buffer.alloc(128 * 1024),
        timeout: 2000,
      }),
    ).rejects.toThrow(/timeout/i);
    const reply = await client.request(subject, null, { timeout: 5000 });
    expect(reply.data?.id).toBeTruthy();
  });
});

describe("the write service's fence (A2b 5a)", () => {
  function raw(project_id: string, path: string, writeFence?) {
    return persistStream({
      client: connect(),
      user: {},
      storage: { path: storagePath({ project_id, name: name(path) }) },
      service: BOARD_WRITE_SERVICE,
      ...(writeFence ? { writeFence } : {}),
      noCache: true,
    });
  }
  const one = () => messageData(rec(1));

  test("the write service reports its instance nonce; the ordinary service refuses to", async () => {
    const project_id = uuid();
    const w = raw(project_id, "/home/user/n.board.json");
    expect(await w.boardInstance()).toBe(setup.boardWriteFence!.nonce);
    w.close();
    const r = persistStream({
      client: connect(),
      user: { project_id },
      storage: {
        path: storagePath({
          project_id,
          name: name("/home/user/n.board.json"),
        }),
      },
      noCache: true,
    });
    // Not on the ordinary service's read allowlist for board streams.
    await expect(r.boardInstance()).rejects.toThrow(/read-only/);
    r.close();
  });

  test("a write without the fence, or with another instance's nonce, is refused and stores nothing", async () => {
    const project_id = uuid();
    const path = "/home/user/fenced.board.json";
    const none = raw(project_id, path);
    await expect(none.set({ messageData: one() })).rejects.toMatchObject({
      code: "instance",
    });
    none.close();
    const other = raw(
      project_id,
      path,
      fence("fedcba9876543210fedcba9876543210"),
    );
    await expect(other.set({ messageData: one() })).rejects.toMatchObject({
      code: "instance",
    });
    // Other mutating commands are fenced too.
    await expect(other.setMetadata({ x: 1 })).rejects.toMatchObject({
      code: "instance",
    });
    other.close();
    const ok = raw(project_id, path, fence());
    // Nothing was stored by the refused writes.
    expect(await ok.getAll()).toEqual([]);
    const { seq } = await ok.set({ messageData: one() });
    expect(seq).toBe(1);
    ok.close();
  });

  test("the restart race: a write signed for the old instance reaches a new one and is refused", async () => {
    const project_id = uuid();
    const path = "/home/user/race.board.json";
    const old = setup.boardWriteFence!;
    const w = raw(project_id, path, fence(old.nonce));
    // The server process restarts between the writer reading the nonce and
    // its write: the new process has a new nonce.
    setup.setBoardWriteFence({
      nonce: "00112233445566778899aabbccddeeff",
      assertWritable() {},
    });
    try {
      await expect(w.set({ messageData: one() })).rejects.toMatchObject({
        code: "instance",
      });
      const check = raw(project_id, path, fence());
      expect(await check.getAll()).toEqual([]);
      check.close();
    } finally {
      setup.setBoardWriteFence(old);
      w.close();
    }
  });

  test("without a lock, every board write is refused 'lock'; reads still work", async () => {
    const project_id = uuid();
    const path = "/home/user/nolock.board.json";
    const old = setup.boardWriteFence;
    const w = raw(project_id, path, fence());
    setup.setBoardWriteFence(undefined);
    try {
      await expect(w.set({ messageData: one() })).rejects.toMatchObject({
        code: "lock",
      });
      expect(await w.getAll()).toEqual([]);
      expect(await w.boardInstance()).toBe(null);
    } finally {
      setup.setBoardWriteFence(old);
      w.close();
    }
  });
});

describe("the write service keeps a board's history one chain (G1)", () => {
  function hub(project_id: string, path: string) {
    return persistStream({
      client: connect(),
      user: {},
      storage: { path: storagePath({ project_id, name: name(path) }) },
      service: BOARD_WRITE_SERVICE,
      writeFence: fence(),
      noCache: true,
    });
  }
  const set = (w: ReturnType<typeof hub>, r: object) =>
    w.set({ messageData: messageData(r), timeout: 10_000 });
  async function stored(project_id: string, path: string) {
    const r = await readerStream(project_id, path);
    const all = r.getAll();
    r.close();
    return all;
  }

  test("each patch must follow the head: a branch, a merge or a second root is refused 'branch' and stores nothing", async () => {
    const project_id = uuid();
    const path = "/home/user/chain.board.json";
    const w = hub(project_id, path);
    await set(w, rec(1));
    await set(w, rec(2, 1));
    for (const bad of [
      rec(3, 1),
      rec(3),
      { ...rec(3), parents: ["t2", "t1"] },
      { edit: 1 },
    ]) {
      await expect(set(w, bad)).rejects.toMatchObject({ code: "branch" });
    }
    expect(await stored(project_id, path)).toEqual([rec(1), rec(2, 1)]);
    // The chain goes on.
    await set(w, rec(3, 2));
    expect(await stored(project_id, path)).toHaveLength(3);
    w.close();
  });

  test("a batch is stored whole or not at all", async () => {
    const project_id = uuid();
    const path = "/home/user/batch.board.json";
    const w = hub(project_id, path);
    await set(w, rec(1));
    const ops = (rs: object[]) =>
      rs.map((r) => ({ messageData: messageData(r) }));
    // The second patch branches: nothing of the batch is stored.
    await expect(
      w.setMany(ops([rec(2, 1), rec(3, 1)]), { timeout: 10_000 }),
    ).rejects.toMatchObject({ code: "branch" });
    expect(await stored(project_id, path)).toEqual([rec(1)]);
    const results = await w.setMany(ops([rec(2, 1), rec(3, 2)]), {
      timeout: 10_000,
    });
    expect(results.every((r) => "seq" in r)).toBe(true);
    expect(await stored(project_id, path)).toEqual([
      rec(1),
      rec(2, 1),
      rec(3, 2),
    ]);
    w.close();
  });

  test("a batch that passes the rule but fails in storage stores nothing", async () => {
    const project_id = uuid();
    const path = "/home/user/partial.board.json";
    const w = hub(project_id, path);
    await set(w, rec(1));
    // The second write fails in storage (over the stream's message size);
    // the first must not be stored without it.
    await w.config({ config: { max_msg_size: 500 } });
    const results = await w.setMany(
      [
        { messageData: messageData(rec(2, 1)) },
        {
          messageData: messageData({
            ...rec(3, 2),
            patch: JSON.stringify("x".repeat(1000)),
          }),
        },
      ],
      { timeout: 10_000 },
    );
    expect(results.every((r) => "error" in r)).toBe(true);
    expect(await stored(project_id, path)).toEqual([rec(1)]);
    // And the head is still t1.
    await set(w, rec(2, 1));
    w.close();
  });

  test("a snapshot record passes; a retried head is accepted", async () => {
    const project_id = uuid();
    const path = "/home/user/snap.board.json";
    const w = hub(project_id, path);
    await set(w, rec(1));
    await set(w, rec(2, 1));
    await set(w, {
      time: "t1",
      is_snapshot: true,
      snapshot: "{}",
      seq_info: { seq: 1 },
    });
    await set(w, rec(2, 1));
    await set(w, rec(3, 2));
    w.close();
  });

  test("astra LIMIT-7B0-2: a snapshot in a setMany (a real MessageData, decoded afresh on every read) is scanned before the synchronous step, never in it", async () => {
    const jsonScan = require("@cocalc/conat/persist/json-scan");
    const project_id = uuid();
    const path = "/home/user/snap-many.board.json";
    const w = hub(project_id, path);
    await set(w, rec(1));
    const snapshot = {
      time: "t1",
      is_snapshot: true,
      snapshot: '{"type":"doc"}\n{"type":"item","id":"a"}',
      seq_info: { seq: 1 },
    };
    const sync = jest.spyOn(jsonScan, "isJsonObjectLines");
    const async_ = jest.spyOn(jsonScan, "isJsonObjectLinesAsync");
    try {
      const results = await w.setMany(
        [
          { messageData: messageData(snapshot) },
          { messageData: messageData(rec(2, 1)) },
        ],
        { timeout: 10_000 },
      );
      expect(results.every((r) => "seq" in r)).toBe(true);
      expect(async_).toHaveBeenCalled();
      expect(sync).not.toHaveBeenCalled();
    } finally {
      sync.mockRestore();
      async_.mockRestore();
    }
    expect(await stored(project_id, path)).toEqual([
      rec(1),
      snapshot,
      rec(2, 1),
    ]);
    // A snapshot that isn't a board document is refused the same way.
    await expect(
      w.setMany(
        [
          {
            messageData: messageData({
              ...snapshot,
              time: "t2",
              snapshot: "{",
            }),
          },
        ],
        {
          timeout: 10_000,
        },
      ),
    ).rejects.toMatchObject({ code: "branch" });
    w.close();
  });

  test("astra's schedules through the service: a re-appended id and a snapshot of an unknown patch are refused, before and after a restart", async () => {
    const project_id = uuid();
    const path = "/home/user/astra.board.json";
    let w = hub(project_id, path);
    await set(w, rec(1));
    await set(w, rec(2, 1));
    // t1 again, under t2: a different patch at a stored time.
    await expect(set(w, rec(1, 2))).rejects.toMatchObject({ code: "branch" });
    // A snapshot of a patch the history doesn't have.
    await expect(
      set(w, {
        time: "t9",
        is_snapshot: true,
        snapshot: "{}",
        seq_info: { seq: 1 },
      }),
    ).rejects.toMatchObject({ code: "branch" });
    expect(await stored(project_id, path)).toEqual([rec(1), rec(2, 1)]);
    w.close();
    // The graph read again from the stream: the same rules.
    await setup.restartPersistServer();
    w = hub(project_id, path);
    await expect(set(w, rec(1, 2))).rejects.toMatchObject({ code: "branch" });
    await expect(set(w, rec(3, 1))).rejects.toMatchObject({ code: "branch" });
    await set(w, {
      time: "t1",
      is_snapshot: true,
      snapshot: "{}",
      seq_info: { seq: 1 },
    });
    await set(w, rec(3, 2));
    w.close();
  });

  test("astra's round 2: a retry changes nothing only if it is the stored record exactly, live and after a restart", async () => {
    const project_id = uuid();
    const path = "/home/user/identity.board.json";
    let w = hub(project_id, path);
    const old = { ...rec(1), patch: '[{"text":"old"}]' };
    await set(w, old);
    // The same time and parents, another payload: refused, so the stored
    // value can't differ from what a live graph (which keeps the first) has.
    await expect(
      set(w, { ...rec(1), patch: '[{"text":"new"}]' }),
    ).rejects.toMatchObject({ code: "branch" });
    // The same payload under other parents: refused.
    await expect(set(w, { ...old, parents: ["t0"] })).rejects.toMatchObject({
      code: "branch",
    });
    // Exactly the stored record: accepted, and the value is unchanged.
    await set(w, old);
    const live = readerStream(project_id, path);
    const r = await live;
    expect(new Set(r.getAll().map((x) => JSON.stringify(x)))).toEqual(
      new Set([JSON.stringify(old)]),
    );
    w.close();
    // Reopened from the stream by a new server process: the same value.
    await setup.restartPersistServer();
    expect(
      new Set((await stored(project_id, path)).map((x) => JSON.stringify(x))),
    ).toEqual(new Set([JSON.stringify(old)]));
    w = hub(project_id, path);
    await expect(
      set(w, { ...rec(1), patch: '[{"text":"new"}]' }),
    ).rejects.toMatchObject({ code: "branch" });
    await set(w, rec(2, 1));
    r.close();
    w.close();
  });

  test("a board's records are stored without a key: a keyed record is refused, whatever it claims", async () => {
    const project_id = uuid();
    const path = "/home/user/keyed.board.json";
    const w = hub(project_id, path);
    await set(w, rec(1));
    // A keyed set deletes the row with that key before inserting: a new
    // patch, a retry, or a batch naming any key is refused, storing nothing.
    await expect(
      w.set({
        messageData: messageData(rec(2, 1)),
        key: "t1",
        timeout: 10_000,
      }),
    ).rejects.toMatchObject({ code: "branch" });
    await expect(
      w.set({ messageData: messageData(rec(1)), key: "t1", timeout: 10_000 }),
    ).rejects.toMatchObject({ code: "branch" });
    await expect(
      w.setMany(
        [
          { messageData: messageData(rec(2, 1)) },
          { messageData: messageData(rec(3, 2)), key: "x" },
        ],
        { timeout: 10_000 },
      ),
    ).rejects.toMatchObject({ code: "branch" });
    expect(await stored(project_id, path)).toEqual([rec(1)]);
    await set(w, rec(2, 1));
    w.close();
  });

  describe("astra CORR-ABB-1: a msgID is the same record, or refused", () => {
    const setId = (w: ReturnType<typeof hub>, r: object, msgID: string) =>
      w.set({ messageData: messageData(r), msgID, timeout: 10_000 });

    // What a new server process reads: the whole chain, and its head the
    // one the service had cached (it takes the next patch after it).
    async function reopened(project_id: string, path: string, head: number) {
      await setup.restartPersistServer();
      const all = await stored(project_id, path);
      const w = hub(project_id, path);
      await set(w, rec(head + 1, head));
      w.close();
      return all;
    }

    test("astra's sequence: B reusing A's msgID is refused, nothing is stored, the head stays A, and C after B is refused", async () => {
      const project_id = uuid();
      const path = "/home/user/msgid.board.json";
      const w = hub(project_id, path);
      const r = await readerStream(project_id, path);
      const changes: unknown[] = [];
      r.on("change", (x) => changes.push(x));
      await setId(w, rec(1), "same");
      await waitFor(() => changes.length === 1);
      // B with A's msgID: refused (it would have been dropped as a
      // duplicate while the head moved to B).
      await expect(setId(w, rec(2, 1), "same")).rejects.toMatchObject({
        code: "msgid-conflict",
      });
      // So C after B is refused too: the head is still A.
      await expect(setId(w, rec(3, 2), "fresh-c")).rejects.toMatchObject({
        code: "branch",
      });
      expect(await stored(project_id, path)).toEqual([rec(1)]);
      // No change was emitted for a record that wasn't stored.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(changes).toHaveLength(1);
      // B with its own msgID goes on.
      await setId(w, rec(2, 1), "fresh-b");
      await waitFor(() => changes.length === 2);
      r.close();
      w.close();
      // Reopened: complete, and its head the cached one (t2).
      expect(await reopened(project_id, path, 2)).toEqual([rec(1), rec(2, 1)]);
    });

    test("the same record again under its msgID is a no-op: nothing stored, nothing emitted, the head unchanged", async () => {
      const project_id = uuid();
      const path = "/home/user/msgid-retry.board.json";
      const w = hub(project_id, path);
      const r = await readerStream(project_id, path);
      const changes: unknown[] = [];
      r.on("change", (x) => changes.push(x));
      const first = await setId(w, rec(1), "a");
      await waitFor(() => changes.length === 1);
      // The retry: the same seq back, and nothing new.
      expect(await setId(w, rec(1), "a")).toMatchObject({ seq: first.seq });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(changes).toHaveLength(1);
      expect(await stored(project_id, path)).toEqual([rec(1)]);
      // The head is still t1.
      await set(w, rec(2, 1));
      r.close();
      w.close();
      expect(await reopened(project_id, path, 2)).toEqual([rec(1), rec(2, 1)]);
    });

    test("in a batch: a reused msgID with another record refuses the whole batch", async () => {
      const project_id = uuid();
      const path = "/home/user/msgid-batch.board.json";
      const w = hub(project_id, path);
      await setId(w, rec(1), "a");
      // Refused before anything is stored (the append check resolves each
      // msgID against storage first, as storage would: CORR-956-1), the
      // whole request.
      await expect(
        w.setMany(
          [
            { messageData: messageData(rec(2, 1)), msgID: "b" },
            { messageData: messageData(rec(3, 2)), msgID: "a" },
          ],
          { timeout: 10_000 },
        ),
      ).rejects.toMatchObject({ code: "msgid-conflict" });
      expect(await stored(project_id, path)).toEqual([rec(1)]);
      await set(w, rec(2, 1));
      w.close();
      expect(await reopened(project_id, path, 2)).toEqual([rec(1), rec(2, 1)]);
    });
  });

  test("a new server process reads the head from the stream", async () => {
    const project_id = uuid();
    const path = "/home/user/restart.board.json";
    let w = hub(project_id, path);
    await set(w, rec(1));
    await set(w, rec(2, 1));
    w.close();
    await setup.restartPersistServer();
    w = hub(project_id, path);
    await expect(set(w, rec(3, 1))).rejects.toMatchObject({ code: "branch" });
    await set(w, rec(3, 2));
    w.close();
  });
});

describe("the board writer's single-attempt save (A2b 5a)", () => {
  async function fencedWriter(
    project_id: string,
    path: string,
    nonce?: string,
  ) {
    return await dstream({
      client: connect(),
      project_id,
      name: name(path),
      service: BOARD_WRITE_SERVICE,
      persistUser: {},
      writeFence: fence(nonce),
      noAutosave: true,
      noInventory: true,
      noCache: true,
    });
  }

  test("saveOnce stores what is unsaved, once", async () => {
    const project_id = uuid();
    const path = "/home/user/once.board.json";
    const w = await fencedWriter(project_id, path);
    w.publish(rec(1));
    expect(w.hasUnsavedChanges()).toBe(true);
    expect(await w.saveOnce()).toEqual({ status: "saved" });
    expect(w.hasUnsavedChanges()).toBe(false);
    const r = await readerStream(project_id, path);
    expect(r.getAll()).toEqual([rec(1)]);
    w.close();
    r.close();
  });

  test("a refused attempt is definite, stores nothing, is never retried, and can be discarded", async () => {
    const project_id = uuid();
    const path = "/home/user/refused.board.json";
    const w = await fencedWriter(
      project_id,
      path,
      "fedcba9876543210fedcba9876543210",
    );
    w.publish(rec(1));
    expect(await w.saveOnce()).toMatchObject({
      status: "refused",
      code: "instance",
    });
    // Still unsaved locally, and nothing retries it.
    expect(w.hasUnsavedChanges()).toBe(true);
    await new Promise((r) => setTimeout(r, 1500));
    const r = await readerStream(project_id, path);
    expect(r.getAll()).toEqual([]);
    w.discardUnsaved();
    expect(w.hasUnsavedChanges()).toBe(false);
    w.close();
    r.close();
  });

  test("no reply at all is not a refusal: saveOnce throws (the outcome is unknown)", async () => {
    const project_id = uuid();
    const path = "/home/user/unknown.board.json";
    const w = await fencedWriter(project_id, path);
    // The write service goes away before the attempt.
    await setup.boardPersistServer.close();
    try {
      w.publish(rec(1), { timeout: 1500 } as any);
      await expect(w.saveOnce()).rejects.toThrow();
      expect(w.hasUnsavedChanges()).toBe(true);
    } finally {
      w.close();
      await setup.restartPersistServer();
    }
  });
});

async function waitFor(f: () => boolean, ms = 10_000) {
  const start = Date.now();
  while (!f()) {
    if (Date.now() - start > ms) throw Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}
