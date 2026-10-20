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
  writer.publish({ edit: 1 });
  await writer.save();
  const reader = await readerStream(project_id, path);
  expect(reader.getAll()).toEqual([{ edit: 1 }]);
  // The reader sees the writer's later changes.
  writer.publish({ edit: 2 });
  await writer.save();
  await waitFor(() => reader.length === 2);
  writer.close();
  reader.close();
});

test("the ordinary service refuses every write to a board stream", async () => {
  const project_id = uuid();
  const path = "/home/user/plan.board.json";
  const writer = await writerStream(project_id, path);
  writer.publish({ edit: 1 });
  await writer.save();
  const reader = await readerStream(project_id, path);
  // A client that writes anyway: the server refuses it (a client keeps
  // retrying a refused write, as for any write error; only the host writes
  // board streams, so no supported client does this).
  reader.publish({ edit: "from a browser" });
  void reader.save().catch(() => {});
  await new Promise((r) => setTimeout(r, 1000));
  // Nothing reached the stream.
  const check = await readerStream(project_id, path);
  expect(check.getAll()).toEqual([{ edit: 1 }]);
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
    writer.publish({ edit: 1 });
    await writer.save();
    // ...and the reader can't, though a writer was opened first.
    reader.publish({ edit: "from a reader" });
    void reader.save().catch(() => {});
    await new Promise((r) => setTimeout(r, 1000));
    const check = await readerStream(project_id, path);
    expect(check.getAll()).toEqual([{ edit: 1 }]);
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
  await s.publish({ edit: 1 });
  s.close();
  const reader = await readerStream(project_id, path);
  expect(reader.getAll()).toEqual([{ edit: 1 }]);
  reader.close();
});

test("a reader can't make a board stream ephemeral", async () => {
  const project_id = uuid();
  const path = "/home/user/ephemeral.board.json";
  // The first opener asks for in-memory storage...
  const sneaky = await readerStream(project_id, path, { ephemeral: true });
  // ...but the board's stream is the durable one the writer uses.
  const writer = await writerStream(project_id, path);
  writer.publish({ edit: 1 });
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
  writer.publish({ edit: "x".repeat(10_000) });
  await writer.save();
  const check = await readerStream(project_id, path);
  expect(check.getAll()).toEqual([{ edit: "x".repeat(10_000) }]);
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
      messageData: messageData({ edit: 1 }),
      timeout: 10_000,
    });
    expect(seq).toBeGreaterThan(0);
    raw.close();
  });

  test("a snapshot-sized message gets through", async () => {
    const project_id = uuid();
    const raw = hubStream(project_id, "/home/user/snapshot.board.json");
    const { seq } = await raw.set({
      messageData: messageData(null, { raw: Buffer.alloc(7 * MiB) }),
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
  const one = () => messageData({ edit: 1 });

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

async function waitFor(f: () => boolean, ms = 10_000) {
  const start = Date.now();
  while (!f()) {
    if (Date.now() - start > ms) throw Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}
