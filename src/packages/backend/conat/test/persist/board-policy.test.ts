/*
A board's stream through real persist servers: the ordinary service only
reads it, and only the board write service (as the hub) writes it.
*/

import { before, after, connect } from "@cocalc/backend/conat/test/setup";
import { dstream } from "@cocalc/conat/sync/dstream";
import { BOARD_WRITE_SERVICE } from "@cocalc/conat/persist/board-policy";
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

function writerStream(project_id: string, path: string) {
  return dstream({
    client: connect(),
    project_id,
    name: name(path),
    service: BOARD_WRITE_SERVICE,
    persistUser: {},
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

async function waitFor(f: () => boolean, ms = 10_000) {
  const start = Date.now();
  while (!f()) {
    if (Date.now() - start > ms) throw Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}
