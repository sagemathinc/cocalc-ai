/*
 * The board manager against a real Conat server, file server and syncdbs,
 * with Sagebrush's own board library.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "@cocalc/conat/sync-doc/install";
import {
  before as beforeConat,
  after as afterConat,
  connect,
} from "@cocalc/backend/conat/test/setup";
import {
  createPathFileserver,
  cleanupFileservers,
} from "@cocalc/backend/conat/files/test/util";
import * as lib from "@sagemathinc/sagebrush-board";
import { uuid } from "@cocalc/util/misc";
import { BoardManager } from "./manager";
import { fileOf, openBoardSyncdb, recordsToString } from "./service";

jest.setTimeout(30_000);

let home: string;
let rootfs: string;
let fileserver: Awaited<ReturnType<typeof createPathFileserver>>;

beforeAll(async () => {
  await beforeConat();
  home = await mkdtemp(join(tmpdir(), "board-home-"));
  rootfs = await mkdtemp(join(tmpdir(), "board-rootfs-"));
  fileserver = await createPathFileserver({
    path: home,
    rootfs,
    unsafeMode: false,
  });
});

afterAll(async () => {
  await cleanupFileservers();
  await rm(home, { recursive: true, force: true });
  await rm(rootfs, { recursive: true, force: true });
  await afterConat();
});

const BOARD = {
  format: "sagebrush-board",
  version: 1,
  title: "Plan",
  nodes: [
    { id: "a", text: "hello world", x: 0, y: 0 },
    { id: "b", text: "second", x: 200, y: 0 },
  ],
  edges: [{ from: "a", to: "b" }],
};

async function until(check: () => boolean | Promise<boolean>, ms = 10_000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

function itemText(db: any, id: string): string | undefined {
  return db.get_one({ type: "item", page: "", id })?.text;
}

async function setup(text: string) {
  const project_id = uuid();
  const path = `plan-${uuid().slice(0, 8)}.board.json`;
  const client = connect();
  const fs: any = client.fs({ project_id, service: fileserver.service });
  await fs.writeFile(path, text);
  const syncdb = await openBoardSyncdb({
    client,
    project_id,
    path,
    service: fileserver.service,
  });
  const file = fileOf(fs, path);
  const writes: string[] = [];
  const counted = {
    ...file,
    write: async (t: string) => {
      writes.push(t);
      await file.write(t);
    },
  };
  const manager = new BoardManager({
    lib,
    syncdb: syncdb as any,
    file: counted,
    recordsToString,
    saveDelayMs: 50,
  });
  await manager.start();
  // A second replica, as a browser has.
  const browser = await openBoardSyncdb({
    client: connect(),
    project_id,
    path,
    service: fileserver.service,
  });
  const read = async () => `${await fs.readFile(path, "utf8")}`;
  const cleanup = async () => {
    await manager.close();
    await browser.close();
    await syncdb.close();
  };
  return {
    project_id,
    fs,
    path,
    syncdb,
    browser,
    manager,
    writes,
    read,
    cleanup,
  };
}

const canonical = (doc: any) => lib.canonical(lib.cleanDoc(doc));

test("loads the file and leaves an unedited board's file alone", async () => {
  const text = canonical(BOARD);
  const t = await setup(text);
  try {
    expect(t.manager.getStatus()).toEqual({
      state: "ok",
      bytes: Buffer.byteLength(text),
    });
    await until(() => itemText(t.browser, "a") === "hello world");
    await t.manager.save();
    expect(t.writes).toEqual([]);
    expect(await t.read()).toBe(text);
  } finally {
    await t.cleanup();
  }
});

test("saves an edit as the board's canonical JSON, byte for byte", async () => {
  const t = await setup(JSON.stringify(BOARD)); // not canonical on disk
  try {
    await until(() => itemText(t.browser, "a") === "hello world");
    t.browser.set({ type: "item", page: "", id: "b", text: "edited" });
    t.browser.commit();
    await until(async () => (await t.read()).includes('"edited"'));
    const expected = canonical({
      ...BOARD,
      nodes: [BOARD.nodes[0], { ...BOARD.nodes[1], text: "edited" }],
    });
    expect(await t.read()).toBe(expected);
    // Its own write does not come back as a change from elsewhere.
    const writes = t.writes.length;
    await new Promise((r) => setTimeout(r, 500));
    expect(t.writes.length).toBe(writes);
    expect(t.manager.getStatus().state).toBe("ok");
  } finally {
    await t.cleanup();
  }
});

test("an edit to the file merges with typing in the same note", async () => {
  const t = await setup(canonical(BOARD));
  try {
    await until(() => itemText(t.browser, "a") === "hello world");
    // Someone types in note a; meanwhile an agent appends "!" to the same
    // note in the file and moves note b.
    t.browser.set({
      type: "item",
      page: "",
      id: "a",
      text: "hello brave world",
    });
    t.browser.commit();
    await t.fs.writeFile(
      t.path,
      canonical({
        ...BOARD,
        nodes: [
          { ...BOARD.nodes[0], text: "hello world!" },
          { ...BOARD.nodes[1], x: 999 },
        ],
      }),
    );
    await until(
      () =>
        itemText(t.browser, "a") === "hello brave world!" &&
        t.browser.get_one({ type: "item", page: "", id: "b" })?.x === 999,
    );
    await until(async () => (await t.read()).includes("hello brave world!"));
  } finally {
    await t.cleanup();
  }
});

test("a file that is not a board is never loaded or written over", async () => {
  const t = await setup(canonical(BOARD));
  try {
    await until(() => itemText(t.browser, "a") === "hello world");
    await t.fs.writeFile(t.path, "{ this is not json");
    await until(() => t.manager.getStatus().state === "invalid");
    t.browser.set({ type: "item", page: "", id: "b", text: "typed later" });
    t.browser.commit();
    await new Promise((r) => setTimeout(r, 500));
    await t.manager.save();
    expect(await t.read()).toBe("{ this is not json");
    expect(itemText(t.browser, "a")).toBe("hello world");
    // A board again: loaded, and the typing kept.
    await t.fs.writeFile(t.path, canonical(BOARD));
    await until(() => t.manager.getStatus().state === "ok");
    expect(itemText(t.browser, "b")).toBe("typed later");
  } finally {
    await t.cleanup();
  }
});

test("the file is the official version when a board is opened again", async () => {
  const t = await setup(canonical(BOARD));
  await until(() => itemText(t.browser, "a") === "hello world");
  await t.cleanup();
  // Changed while nobody had it open.
  const changed = canonical({
    ...BOARD,
    nodes: [{ ...BOARD.nodes[0], text: "changed offline" }, BOARD.nodes[1]],
  });
  await t.fs.writeFile(t.path, changed);
  const client = connect();
  const syncdb = await openBoardSyncdb({
    client,
    project_id: t.project_id,
    path: t.path,
    service: fileserver.service,
  });
  const manager = new BoardManager({
    lib,
    syncdb: syncdb as any,
    file: fileOf(t.fs, t.path),
    recordsToString,
    saveDelayMs: 50,
  });
  try {
    await manager.start();
    expect(itemText(syncdb, "a")).toBe("changed offline");
    await manager.save();
    expect(`${await t.fs.readFile(t.path, "utf8")}`).toBe(changed);
  } finally {
    await manager.close();
    await syncdb.close();
  }
});

test("a missing file is reported, not created", async () => {
  const t = await setup(canonical(BOARD));
  try {
    await t.fs.unlink(t.path);
    const fresh = new BoardManager({
      lib,
      syncdb: t.syncdb as any,
      file: fileOf(t.fs, t.path),
      recordsToString,
    });
    await fresh.start();
    expect(fresh.getStatus()).toEqual({ state: "missing" });
    await fresh.close();
    await expect(t.fs.readFile(t.path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await t.cleanup();
  }
});
