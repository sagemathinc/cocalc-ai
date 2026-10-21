/*
 * The board manager against a real Conat server, file server and syncdbs,
 * with Sagebrush's own board library.
 */

import { createHash } from "node:crypto";
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
import { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import { from_str as immerFromStr } from "@cocalc/sync/editor/immer-db/doc";
import {
  BOARD_EDITABLE_LIMIT,
  BOARD_HOST_RECORD_LIMIT,
  BOARD_PRIMARY_KEYS,
  BOARD_RECORD_LIMIT,
  BOARD_STRING_COLS,
} from "@cocalc/util/board/names";
import { BoardManager, type BoardFile } from "./manager";
import { fsServer } from "@cocalc/conat/files/fs";
import { dstream } from "@cocalc/conat/sync/dstream";
import { patchesStreamName } from "@cocalc/conat/sync/synctable-stream";
import { BOARD_WRITE_SERVICE } from "@cocalc/conat/persist/board-policy";
import { BOARD_WRITE_MAX_TTL_MS } from "@cocalc/conat/persist/board-write-fence";
import * as testSetup from "@cocalc/backend/conat/test/setup";
import { boardSyncdbPath } from "@cocalc/util/board/names";
import { getStream } from "@cocalc/conat/persist/util";
import { boardRecordCap } from "@cocalc/conat/persist/board-record-cap";
import { storagePath } from "@cocalc/conat/sync/core-stream";
import { DataEncoding, decode, encode } from "@cocalc/conat/core/codec";
import { BOARD_HISTORY_LIMITS } from "@cocalc/conat/persist/board-history";
import { checkBoardHistory } from "./history";
import {
  type ReplaceHooks,
  boardHandlers,
  canonicalBoardPath,
  closeBoards,
  fileOf,
  openBoard,
  openBoardCount,
  openBoardSyncdb,
  recordsToString,
} from "./service";

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
    // As on a project host: the service names boards /home/user/...
    homeAliases: ["/home/user"],
  });
});

afterAll(async () => {
  for (const fs of locals) fs.close();
  await cleanupFileservers();
  await rm(home, { recursive: true, force: true });
  await rm(rootfs, { recursive: true, force: true });
  await afterConat();
});

// The project's files as the project host's file service hands them to the
// board code: a local SandboxedFilesystem (with its bounded reads and
// openat2's no-replace rename), here over the test file server's directory.
const locals: SandboxedFilesystem[] = [];
function localFs(project_id: string): any {
  const fs = new SandboxedFilesystem(join(home, project_id), {
    host: project_id,
    homeAliases: ["/home/user"],
    allowSafeModeHardlink: true,
    allowSafeModeSymlink: true,
  });
  locals.push(fs);
  return fs;
}

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

async function setup(
  text: string,
  opts: {
    manager?: Partial<ConstructorParameters<typeof BoardManager>[0]>;
    wrap?: (file: BoardFile, fs: any, path: string) => BoardFile;
    hooks?: ReplaceHooks;
  } = {},
) {
  const project_id = uuid();
  const path = `plan-${uuid().slice(0, 8)}.board.json`;
  const client = connect();
  const fs: any = client.fs({ project_id, service: fileserver.service });
  await fs.writeFile(path, text);
  const syncdb = await openBoardSyncdb({
    // Writes as the host does (only the manager writes in production; these
    // replicas stand in for edits the host has admitted).
    writer: true,
    client,
    project_id,
    path,
    service: fileserver.service,
  });
  const local = localFs(project_id);
  const file = fileOf(local, path, opts.hooks);
  const writes: string[] = [];
  const counted: BoardFile = {
    ...file,
    replace: async (t: string, expected: string) => {
      writes.push(t);
      return await file.replace(t, expected);
    },
  };
  const manager = new BoardManager({
    lib,
    syncdb: syncdb as any,
    file: opts.wrap?.(counted, fs, path) ?? counted,
    recordsToString,
    saveDelayMs: 50,
    loadIntervalMs: 20,
    ...opts.manager,
  });
  await manager.start();
  // A second replica, as a browser has.
  const browserClient = connect();
  const browser = await openBoardSyncdb({
    // Writes as the host does (only the manager writes in production; these
    // replicas stand in for edits the host has admitted).
    writer: true,
    client: browserClient,
    project_id,
    path,
    service: fileserver.service,
  });
  // A save renames the board aside for an instant; a reader then may find
  // no file, or the path changing under it, and reads again.
  const read = async () => {
    for (let i = 0; ; i++) {
      try {
        return `${await fs.readFile(path, "utf8")}`;
      } catch (err) {
        if (i >= 20) throw err;
        await new Promise((r) => setTimeout(r, 10));
      }
    }
  };
  const cleanup = async () => {
    await manager.close();
    await browser.close();
    await syncdb.close();
    // (The server allows 100 connections per user.)
    browserClient.close();
    client.close();
  };
  return {
    project_id,
    fs,
    local,
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
  const client = connect();
  // (t's client closed with it.)
  const fs: any = client.fs({
    project_id: t.project_id,
    service: fileserver.service,
  });
  await fs.writeFile(t.path, changed);
  const syncdb = await openBoardSyncdb({
    // Writes as the host does (only the manager writes in production; these
    // replicas stand in for edits the host has admitted).
    writer: true,
    client,
    project_id: t.project_id,
    path: t.path,
    service: fileserver.service,
  });
  const manager = new BoardManager({
    lib,
    syncdb: syncdb as any,
    file: fileOf(t.local, t.path),
    recordsToString,
    saveDelayMs: 50,
  });
  try {
    await manager.start();
    expect(itemText(syncdb, "a")).toBe("changed offline");
    await manager.save();
    expect(`${await fs.readFile(t.path, "utf8")}`).toBe(changed);
  } finally {
    await manager.close();
    await syncdb.close();
    client.close();
  }
});

test("a missing file is reported, not created", async () => {
  const t = await setup(canonical(BOARD));
  try {
    await t.fs.unlink(t.path);
    const fresh = new BoardManager({
      lib,
      syncdb: t.syncdb as any,
      file: fileOf(t.local, t.path),
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

const withNode = (id: string, change: object) =>
  canonical({
    ...BOARD,
    nodes: BOARD.nodes.map((n) => (n.id === id ? { ...n, ...change } : n)),
  });

function setText(db: any, id: string, text: string) {
  db.set({ type: "item", page: "", id, text });
  db.commit();
}

const missing = { code: "ENOENT" };

test("restoring an earlier version this manager wrote is a change, not an echo", async () => {
  const t = await setup(canonical(BOARD));
  try {
    await until(() => itemText(t.browser, "a") === "hello world");
    setText(t.browser, "b", "B1");
    await until(async () => (await t.read()).includes('"B1"'));
    const b1 = await t.read();
    setText(t.browser, "b", "C1");
    await until(async () => (await t.read()).includes('"C1"'));
    await t.fs.writeFile(t.path, b1); // git checkout of the earlier save
    await until(() => itemText(t.browser, "b") === "B1");
    await t.manager.save();
    expect(await t.read()).toBe(b1);
    // And after the file was not a board for a while.
    await t.fs.writeFile(t.path, "{ not a board");
    await until(() => t.manager.getStatus().state === "invalid");
    await t.fs.writeFile(t.path, b1);
    await until(() => t.manager.getStatus().state === "ok");
    expect(await t.read()).toBe(b1);
  } finally {
    await t.cleanup();
  }
});

test("a deleted board is never written again", async () => {
  const t = await setup(canonical(BOARD));
  try {
    await until(() => itemText(t.browser, "a") === "hello world");
    await t.fs.unlink(t.path);
    setText(t.browser, "b", "typed after the delete");
    await new Promise((r) => setTimeout(r, 300));
    await t.manager.save();
    await expect(t.fs.readFile(t.path, "utf8")).rejects.toMatchObject(missing);
    expect(t.manager.isRetired()).toBe(true);
    expect(t.manager.getStatus()).toEqual({
      state: "missing",
      message: "the board was deleted or moved",
    });
    // Even if the file comes back, this manager does not write it.
    await t.fs.writeFile(t.path, canonical(BOARD));
    setText(t.browser, "b", "later");
    await new Promise((r) => setTimeout(r, 300));
    await t.manager.save();
    expect(await t.read()).toBe(canonical(BOARD));
  } finally {
    await t.cleanup();
  }
});

test("a moved board leaves both names alone", async () => {
  const t = await setup(canonical(BOARD));
  const moved = t.path.replace(".board.json", "-moved.board.json");
  try {
    await until(() => itemText(t.browser, "a") === "hello world");
    await t.fs.rename(t.path, moved);
    setText(t.browser, "b", "typed after the move");
    await new Promise((r) => setTimeout(r, 300));
    await t.manager.save();
    await expect(t.fs.readFile(t.path, "utf8")).rejects.toMatchObject(missing);
    expect(`${await t.fs.readFile(moved, "utf8")}`).toBe(canonical(BOARD));
    expect(t.manager.isRetired()).toBe(true);
  } finally {
    await t.cleanup();
  }
});

// What lands in the file between the manager's decision to write and its
// write. The write is a compare-and-swap, so none of it is written over.
const BETWEEN: [
  string,
  (fs: any, path: string) => Promise<void>,
  (t: any) => Promise<void>,
][] = [
  [
    "a valid edit (merged)",
    async (fs, path) => await fs.writeFile(path, withNode("a", { x: 555 })),
    async (t) => {
      await until(async () => (await t.read()).includes('"local"'));
      const doc = JSON.parse(await t.read());
      expect(doc.nodes.find((n) => n.id === "a").x).toBe(555);
      expect(t.manager.getStatus().state).toBe("ok");
    },
  ],
  [
    "a file that is not a board",
    async (fs, path) => await fs.writeFile(path, "{ interrupted external file"),
    async (t) => {
      expect(await t.read()).toBe("{ interrupted external file");
      expect(t.manager.getStatus().state).toBe("invalid");
    },
  ],
  [
    "a file renamed over it (merged)",
    async (fs, path) => {
      const tmp = `${path}.tmp-editor`;
      await fs.writeFile(tmp, withNode("a", { x: 777 }));
      await fs.rename(tmp, path);
    },
    async (t) => {
      await until(async () => (await t.read()).includes('"local"'));
      const doc = JSON.parse(await t.read());
      expect(doc.nodes.find((n) => n.id === "a").x).toBe(777);
    },
  ],
  [
    "a deletion",
    async (fs, path) => await fs.unlink(path),
    async (t) => {
      await expect(t.fs.readFile(t.path, "utf8")).rejects.toMatchObject(
        missing,
      );
      expect(t.manager.isRetired()).toBe(true);
    },
  ],
];

test.each(BETWEEN)(
  "a save never writes over %s that lands just before its write",
  async (_name, between, check) => {
    let hook: (() => Promise<void>) | undefined;
    const t = await setup(canonical(BOARD), {
      wrap: (file, fs, path) => ({
        ...file,
        replace: async (text, expected) => {
          const h = hook;
          hook = undefined;
          if (h) await h();
          return await file.replace(text, expected);
        },
      }),
    });
    try {
      await until(() => itemText(t.browser, "a") === "hello world");
      hook = () => between(t.fs, t.path);
      setText(t.browser, "b", "local");
      await until(() => hook === undefined);
      await t.manager.save();
      await check(t);
    } finally {
      await t.cleanup();
    }
  },
);

test("two managers: one that lost the board cannot write over the next", async () => {
  for (const revoked of [true, false]) {
    const held: { release?: () => void } = {};
    let holding = false;
    const t = await setup(canonical(BOARD), {
      wrap: (file) => ({
        ...file,
        replace: async (text, expected) => {
          if (!holding) {
            holding = true;
            await new Promise<void>((r) => (held.release = r));
          }
          return await file.replace(text, expected);
        },
      }),
    });
    // The next owner: another manager of the same file, with its own
    // document, as after a takeover elsewhere.
    const other = await openBoardSyncdb({
      // Writes as the host does (only the manager writes in production; these
      // replicas stand in for edits the host has admitted).
      writer: true,
      client: connect(),
      project_id: uuid(),
      path: t.path,
      service: fileserver.service,
    });
    const next = new BoardManager({
      lib,
      syncdb: other as any,
      file: fileOf(t.local, t.path),
      recordsToString,
      saveDelayMs: 50,
    });
    try {
      await until(() => itemText(t.browser, "a") === "hello world");
      await next.start();
      setText(t.browser, "b", "old owner");
      // Its debounced save reaches the write and is held there.
      await until(() => held.release != null);
      setText(other, "a", "new owner");
      await next.save();
      const nextText = await t.read();
      expect(nextText).toContain('"new owner"');
      if (revoked) t.manager.revoke();
      held.release!();
      await t.manager.settled();
      if (revoked) {
        expect(await t.read()).toBe(nextText);
      } else {
        // It lost its compare-and-swap, merged the file and saved both.
        const doc = JSON.parse(await t.read());
        expect(doc.nodes.map((n) => n.text)).toEqual([
          "new owner",
          "old owner",
        ]);
      }
    } finally {
      await next.close();
      await other.close();
      await t.cleanup();
    }
  }
});

test("a storm of writes to the file: bounded loads, ending at the last", async () => {
  let infos = 0;
  const t = await setup(canonical(BOARD), {
    manager: { loadIntervalMs: 200 },
    wrap: (file) => ({
      ...file,
      info: async () => {
        infos += 1;
        return await file.info();
      },
    }),
  });
  try {
    await until(() => itemText(t.browser, "a") === "hello world");
    infos = 0;
    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      await t.fs.writeFile(t.path, withNode("a", { x: i }));
    }
    await until(
      () => t.browser.get_one({ type: "item", page: "", id: "a" })?.x === 99,
    );
    const elapsed = Date.now() - start;
    expect(infos).toBeLessThanOrEqual(Math.ceil(elapsed / 200) + 2);
    expect(infos).toBeLessThan(100);
  } finally {
    await t.cleanup();
  }
});

describe("limits", () => {
  const text = canonical(BOARD);
  const bytes = Buffer.byteLength(text);
  const records = lib.toRecords(lib.cleanDoc(BOARD)).length;

  async function opened(manager: object) {
    let reads = 0;
    const t = await setup(text, {
      manager,
      wrap: (file) => ({
        ...file,
        read: async (maxBytes) => {
          reads += 1;
          return await file.read(maxBytes);
        },
      }),
    });
    return { t, reads: () => reads };
  }

  test("a file at the byte limit loads; one byte over is never read", async () => {
    const at = await opened({ maxBytes: bytes });
    expect(at.t.manager.getStatus()).toEqual({ state: "ok", bytes });
    await at.t.cleanup();
    const over = await opened({ maxBytes: bytes - 1 });
    expect(over.t.manager.getStatus()).toMatchObject({
      state: "too-large",
      bytes,
    });
    expect(over.reads()).toBe(0);
    await over.t.cleanup();
  });

  test("a board at the record limit loads; one over does not", async () => {
    const at = await opened({ maxRecords: records });
    expect(at.t.manager.getStatus().state).toBe("ok");
    await at.t.cleanup();
    const over = await opened({ maxRecords: records - 1 });
    expect(over.t.manager.getStatus()).toMatchObject({ state: "too-large" });
    setText(over.t.browser, "b", "edited");
    await new Promise((r) => setTimeout(r, 300));
    await over.t.manager.save();
    expect(await over.t.read()).toBe(text);
    await over.t.cleanup();
  });

  test("a document grown over the limit is not saved until it shrinks", async () => {
    const { t } = await opened({
      maxBytes: bytes + 20,
      hardMaxBytes: bytes + 500,
    });
    try {
      await until(() => itemText(t.browser, "a") === "hello world");
      setText(t.browser, "b", "x".repeat(100));
      await until(() => t.manager.getStatus().state === "too-large");
      expect(await t.read()).toBe(text);
      setText(t.browser, "b", "short");
      await until(async () => (await t.read()).includes('"short"'));
      expect(t.manager.getStatus().state).toBe("ok");
    } finally {
      await t.cleanup();
    }
  });
});

test("a board file with another hard link is not loaded", async () => {
  const t = await setup(canonical(BOARD));
  try {
    await t.fs.link(t.path, `${t.path}.alias.board.json`);
    const fresh = new BoardManager({
      lib,
      syncdb: t.syncdb as any,
      file: fileOf(t.local, t.path),
      recordsToString,
    });
    await fresh.start();
    expect(fresh.getStatus()).toMatchObject({ state: "invalid" });
    await fresh.close();
  } finally {
    await t.cleanup();
  }
});

describe("the service", () => {
  test("missing paths take no slot; aliases reach one board", async () => {
    const project_id = uuid();
    const client = connect();
    const fs: any = client.fs({ project_id, service: fileserver.service });
    const opts = {
      client,
      project_id,
      fs: localFs(project_id),
      service: fileserver.service,
    };
    try {
      await fs.writeFile("home-exists.txt", "");
      expect(
        await openBoard({ ...opts, path: "nothing-here.board.json" }),
      ).toMatchObject({ state: "missing" });
      expect(openBoardCount()).toBe(0);

      await fs.writeFile("real.board.json", canonical(BOARD));
      await fs.symlink("real.board.json", "alias.board.json");
      const real = await openBoard({ ...opts, path: "real.board.json" });
      const alias = await openBoard({ ...opts, path: "alias.board.json" });
      expect(alias).toEqual(real);
      expect(openBoardCount()).toBe(1);

      await fs.writeFile("plain.json", canonical(BOARD));
      await fs.symlink("plain.json", "sneaky.board.json");
      await expect(
        openBoard({ ...opts, path: "sneaky.board.json" }),
      ).rejects.toThrow(/not a board/);
    } finally {
      await closeBoards(project_id);
    }
    expect(openBoardCount()).toBe(0);
  });
});

describe("G1: a board's history is checked before anything opens it", () => {
  // The board's stream as the persist server holds it, to write a legacy
  // history (one from before the write service kept it one chain) directly.
  async function rawStream(project_id: string, path: string) {
    const stored = storagePath({
      project_id,
      name: patchesStreamName({
        path: boardSyncdbPath(canonicalBoardPath(path)),
      }),
    });
    return await getStream({
      subject: `${BOARD_WRITE_SERVICE}.hub`,
      service: BOARD_WRITE_SERVICE,
      storage: { path: stored },
      // As the persist server opens it.
      recordCap: boardRecordCap(stored),
    });
  }
  const write = (stream: any, mesg: object) =>
    stream.set({
      encoding: DataEncoding.MsgPack,
      raw: Buffer.from(encode({ encoding: DataEncoding.MsgPack, mesg })),
    });
  const record = (stream: any, seq: number) => {
    const m = stream.get({ seq });
    return decode({ encoding: m.encoding, data: m.raw });
  };

  test("a linear history opens; a branched one is quarantined: nothing opens it, and nothing is written", async () => {
    const project_id = uuid();
    const client = connect();
    const fs: any = client.fs({ project_id, service: fileserver.service });
    const opts = {
      client,
      project_id,
      fs: localFs(project_id),
      service: fileserver.service,
    };
    const path = "legacy.board.json";
    try {
      await fs.writeFile(path, canonical(BOARD));
      expect(await openBoard({ ...opts, path })).toMatchObject({ state: "ok" });
      await closeBoards(project_id);
      const verdict = await checkBoardHistory({
        client,
        project_id,
        path: canonicalBoardPath(path),
      });
      expect(verdict).toMatchObject({ ok: true });

      // A legacy branch: two children of the first patch.
      const stream = await rawStream(project_id, path);
      const first = record(stream, 1);
      for (const client of ["legacyBranchClientA", "legacyBranchClientB"]) {
        write(stream, {
          time: `${first.time.split("_")[0]}_${client}`,
          parents: [first.time],
          patch: "[]",
          is_snapshot: false,
        });
      }
      const before = await fs.readFile(path, "utf8");
      const status = await openBoard({ ...opts, path });
      expect(status).toMatchObject({ state: "quarantined" });
      expect(status.message).toMatch(/can't be opened here/);
      expect(openBoardCount()).toBe(0);
      expect(await fs.readFile(path, "utf8")).toBe(before);
      // Shown again (opened again and again): the same answer, from memory.
      expect(await openBoard({ ...opts, path })).toEqual(status);
      expect(openBoardCount()).toBe(0);
    } finally {
      await closeBoards(project_id);
      client.close();
    }
  });

  test("a single head over eight branches is quarantined", async () => {
    const project_id = uuid();
    const client = connect();
    const fs: any = client.fs({ project_id, service: fileserver.service });
    const path = "eight.board.json";
    // (Each test closes its client: the server allows 100 per user.)
    try {
      await fs.writeFile(path, canonical(BOARD));
      const stream = await rawStream(project_id, path);
      write(stream, { time: "r", parents: [], patch: "[]" });
      const tips: string[] = [];
      for (let b = 0; b < 8; b++) {
        write(stream, { time: `b${b}`, parents: ["r"], patch: "[]" });
        tips.push(`b${b}`);
      }
      write(stream, { time: "m", parents: tips, patch: "[]" });
      expect(
        await checkBoardHistory({
          client,
          project_id,
          path: canonicalBoardPath(path),
        }),
      ).toMatchObject({ ok: false, reason: "non-linear" });
      expect(
        await openBoard({
          client,
          project_id,
          path,
          fs: localFs(project_id),
          service: fileserver.service,
        }),
      ).toMatchObject({ state: "quarantined" });
      expect(openBoardCount()).toBe(0);
    } finally {
      client.close();
    }
  });

  test("a file change too costly to merge quarantines the board: nothing is merged or stored, and the file is left as it is", async () => {
    const t = await setup(canonical(BOARD), {
      manager: { workLimits: { maxWork: 100_000, maxFields: 64 } },
    });
    try {
      await until(() => itemText(t.browser, "a") === "hello world");
      await t.syncdb.save();
      const stored = async () =>
        [...(await rawStream(t.project_id, t.path)).getAll()].length;
      const before = await stored();
      // An agent rewrites one note completely: "hello world" -> 3,000 other
      // characters, (11 + 3,000)·3,000 of search, far over this cap.
      const rewritten = canonical({
        ...BOARD,
        nodes: [{ ...BOARD.nodes[0], text: "z".repeat(3000) }, BOARD.nodes[1]],
      });
      await t.fs.writeFile(t.path, rewritten);
      await until(() => t.manager.getStatus().state === "quarantined");
      expect(t.manager.getStatus()).toMatchObject({
        state: "quarantined",
        message: expect.stringMatching(/too much to merge/),
      });
      expect(t.manager.isRetired()).toBe(true);
      // Nothing merged, nothing stored, the file as the agent wrote it.
      expect(itemText(t.syncdb, "a")).toBe("hello world");
      await new Promise((r) => setTimeout(r, 300));
      expect(await stored()).toBe(before);
      expect(await t.read()).toBe(rewritten);
    } finally {
      await t.cleanup();
    }
  });

  test("the check stops at its limits, before reading the whole history", async () => {
    const project_id = uuid();
    const client = connect();
    const path = "/home/user/long.board.json";
    try {
      const stream = await rawStream(project_id, "long.board.json");
      let prev: string | undefined;
      for (let i = 0; i < 30; i++) {
        write(stream, {
          time: `p${i}`,
          parents: prev == null ? [] : [prev],
          patch: "[]",
        });
        prev = `p${i}`;
      }
      const limits = { ...BOARD_HISTORY_LIMITS };
      expect(
        await checkBoardHistory({ client, project_id, path, limits }),
      ).toMatchObject({ ok: true, suffix: 30 });
      expect(
        await checkBoardHistory({
          client,
          project_id,
          path,
          limits: { ...limits, records: 29 },
        }),
      ).toMatchObject({ ok: false, reason: "too-large" });
      expect(
        await checkBoardHistory({
          client,
          project_id,
          path,
          limits: { ...limits, suffixRecords: 29 },
        }),
      ).toMatchObject({ ok: false, reason: "too-large" });
    } finally {
      client.close();
    }
  });
});

// Find the file replaceBoardFile set aside, during a replace.
async function asideOf(fs: any, path: string): Promise<string> {
  const names: string[] = await fs.readdir(".");
  const name = names.find(
    (n) => n.startsWith(`.${path}.`) && n.endsWith(".sage-board-aside"),
  );
  if (!name) throw Error("no aside file");
  return name;
}

describe("no version from another writer is lost, at any step of a save", () => {
  test("a file created while the board is aside wins, and is merged", async () => {
    let hook: (() => Promise<void>) | undefined;
    const hooks: ReplaceHooks = {
      afterVerify: async () => {
        const h = hook;
        hook = undefined;
        await h?.();
      },
    };
    const t = await setup(canonical(BOARD), { hooks });
    try {
      await until(() => itemText(t.browser, "a") === "hello world");
      hook = async () => {
        // The board's name is free for a moment: someone writes it.
        await t.fs.writeFile(t.path, withNode("a", { x: 4242 }));
      };
      setText(t.browser, "b", "local");
      await until(async () => (await t.read()).includes('"local"'));
      expect(hook).toBeUndefined();
      const doc = JSON.parse(await t.read());
      expect(doc.nodes.find((n) => n.id === "a").x).toBe(4242);
      expect(t.manager.getStatus().state).toBe("ok");
      const names: string[] = await t.fs.readdir(".");
      // At most the previous version of the last save stays (until the
      // next save sweeps it), and no temp file.
      expect(names.filter((n) => n.endsWith(".sage-board-tmp"))).toEqual([]);
      expect(
        names.filter((n) => n.endsWith(".sage-board-aside")).length,
      ).toBeLessThanOrEqual(1);
    } finally {
      await t.cleanup();
    }
  });

  test("a write into the old file after the save is kept as a conflict copy", async () => {
    let hook: (() => Promise<void>) | undefined;
    const t = await setup(canonical(BOARD), {
      hooks: {
        afterPlace: async () => {
          const h = hook;
          hook = undefined;
          await h?.();
        },
      },
    });
    try {
      await until(() => itemText(t.browser, "a") === "hello world");
      const late = withNode("a", { x: 9 });
      let aside = "";
      hook = async () => {
        aside = await asideOf(t.fs, t.path);
      };
      setText(t.browser, "b", "local");
      await until(() => hook === undefined && aside !== "");
      await t.manager.settled();
      // A writer that had the old file open writes into it, even after
      // the save finished.
      await t.fs.writeFile(aside, late);
      // The next save surfaces it.
      setText(t.browser, "b", "local again");
      await until(async () => (await t.read()).includes('"local again"'));
      await t.manager.settled();
      const names: string[] = await t.fs.readdir(".");
      const copies = names.filter((n) => n.startsWith(`${t.path}.conflict-`));
      expect(copies.length).toBe(1);
      expect(`${await t.fs.readFile(copies[0], "utf8")}`).toBe(late);
      expect(names).not.toContain(aside);
    } finally {
      await t.cleanup();
    }
  });

  const hash = (text: string) =>
    createHash("sha256").update(text).digest("hex").slice(0, 16);

  test("a save interrupted while the board was aside is put back", async () => {
    const t = await setup(canonical(BOARD));
    try {
      await t.manager.close();
      const id = uuid();
      const text = canonical(BOARD);
      // As a host that stopped between steps 2 and 4 leaves it.
      await t.fs.writeFile(`.${t.path}.${id}.sage-board-tmp`, "new text");
      await t.fs.rename(
        t.path,
        `.${t.path}.${id}.${hash(text)}.sage-board-aside`,
      );
      const info = await fileOf(t.local, `/home/user/${t.path}`).info();
      expect(info?.size).toBe(Buffer.byteLength(text));
      expect(await t.read()).toBe(text);
      const names: string[] = await t.fs.readdir(".");
      expect(names.filter((n) => n.includes(".sage-board-"))).toEqual([]);
    } finally {
      await t.cleanup();
    }
  });

  test("a board deleted on purpose is not brought back by an old aside", async () => {
    const t = await setup(canonical(BOARD));
    try {
      await t.manager.close();
      const old = withNode("a", { x: 1 });
      // A save that finished (its tmp placed) left its aside behind.
      await t.fs.writeFile(
        `.${t.path}.${uuid()}.${hash(old)}.sage-board-aside`,
        old,
      );
      await t.fs.unlink(t.path);
      expect(await fileOf(t.local, `/home/user/${t.path}`).info()).toBe(
        undefined,
      );
      await expect(t.fs.readFile(t.path, "utf8")).rejects.toMatchObject(
        missing,
      );
      const names: string[] = await t.fs.readdir(".");
      expect(names.filter((n) => n.includes(".sage-board-"))).toEqual([]);
    } finally {
      await t.cleanup();
    }
  });
});

// A live document in the syncdb's format, in memory.
class MemorySyncdb {
  private doc = immerFromStr("", BOARD_PRIMARY_KEYS, BOARD_STRING_COLS);
  get_doc() {
    return this.doc;
  }
  from_str(value: string) {
    this.doc = immerFromStr(value, BOARD_PRIMARY_KEYS, BOARD_STRING_COLS);
  }
  set(record: object) {
    this.doc = this.doc.set(record);
  }
  commit() {}
  on() {}
  removeListener() {}
}

// A minimal note, as Sagebrush's records have it.
const item = (id: string, pos: number) => ({
  type: "item",
  page: "",
  id,
  text: "",
  x: 0,
  y: 0,
  parent: "",
  pos,
});

describe("the record limit is checked before writing", () => {
  test("one record over: nothing is written; back under: it saves", async () => {
    const records = lib.toRecords(lib.cleanDoc(BOARD)).length;
    const replaced: string[] = [];
    const t = await setup(canonical(BOARD), {
      manager: { maxRecords: records },
      wrap: (file) => ({
        ...file,
        replace: async (text, expected) => {
          replaced.push(text);
          return await file.replace(text, expected);
        },
      }),
    });
    try {
      await until(() => itemText(t.browser, "a") === "hello world");
      t.browser.set({
        type: "item",
        page: "",
        id: "c",
        text: "one too many",
        x: 400,
        y: 0,
        parent: "",
        pos: 2,
      });
      t.browser.commit();
      await until(() => t.manager.getStatus().state === "too-large");
      expect(replaced).toEqual([]);
      expect(await t.read()).toBe(canonical(BOARD));
      t.browser.delete({ type: "item", page: "", id: "c" });
      setText(t.browser, "b", "fits again");
      await until(async () => (await t.read()).includes('"fits again"'));
      expect(t.manager.getStatus().state).toBe("ok");
    } finally {
      await t.cleanup();
    }
  });

  // At production size the live syncdb is far too slow (patchflow applies a
  // patch of n new records in O(n^2)), so this one uses an in-memory
  // document with the syncdb's own format, and the real file and library.
  test("at the production limit: 100,000 records save, 100,001 do not", async () => {
    // A board with 99,999 records (its doc record and 99,998 notes).
    const nodes = Array.from({ length: 99_998 }, (_, i) => ({
      id: `n${i}`,
      text: "",
      x: 0,
      y: 0,
    }));
    const big = canonical({ ...BOARD, nodes, edges: [] });
    expect(lib.toRecords(lib.cleanDoc(JSON.parse(big))).length).toBe(99_999);
    const project_id = uuid();
    const path = "big.board.json";
    const fs: any = connect().fs({ project_id, service: fileserver.service });
    await fs.writeFile(path, big);
    const syncdb = new MemorySyncdb();
    const replaced: string[] = [];
    const file = fileOf(localFs(project_id), path);
    const manager = new BoardManager({
      lib,
      syncdb,
      file: {
        ...file,
        replace: async (text, expected) => {
          replaced.push(text);
          return await file.replace(text, expected);
        },
      },
      recordsToString,
      saveDelayMs: 60_000,
      // The protocol's limits, not the host's lower defaults.
      maxRecords: BOARD_RECORD_LIMIT,
      maxBytes: BOARD_EDITABLE_LIMIT,
    });
    try {
      await manager.start();
      expect(manager.getStatus().state).toBe("ok");
      syncdb.set(item("at-limit", 99_998));
      await manager.save();
      expect(manager.getStatus().state).toBe("ok");
      expect(replaced.length).toBe(1);
      const saved = `${await fs.readFile(path, "utf8")}`;
      expect(Buffer.byteLength(saved)).toBeLessThan(8 * 1024 * 1024);
      expect(lib.toRecords(lib.cleanDoc(JSON.parse(saved))).length).toBe(
        100_000,
      );
      syncdb.set(item("one-more", 99_999));
      await manager.save();
      expect(manager.getStatus()).toMatchObject({ state: "too-large" });
      expect(replaced.length).toBe(1); // never attempted
      expect(`${await fs.readFile(path, "utf8")}`).toBe(saved);
    } finally {
      await manager.close();
    }
  }, 120_000);
});

test("a document grown past what a host keeps retires its manager", async () => {
  const text = canonical(BOARD);
  const bytes = Buffer.byteLength(text);
  const t = await setup(text, {
    manager: { maxBytes: bytes + 20, hardMaxBytes: bytes + 60 },
  });
  try {
    let retired = 0;
    (t.manager as any).onRetire(() => (retired += 1));
    await until(() => itemText(t.browser, "a") === "hello world");
    setText(t.browser, "b", "x".repeat(200));
    await until(() => t.manager.isRetired());
    expect(retired).toBe(1);
    expect(t.manager.getStatus().state).toBe("too-large");
    expect(await t.read()).toBe(text);
  } finally {
    await t.cleanup();
  }
});

test("by default a host edits boards up to its own record limit", async () => {
  const board = (records: number) =>
    canonical({
      ...BOARD,
      nodes: Array.from({ length: records - 1 }, (_, i) => ({
        id: `n${i}`,
        text: "",
        x: 0,
        y: 0,
      })),
      edges: [],
    });
  const at = await setup(board(BOARD_HOST_RECORD_LIMIT), {
    manager: { maxRecords: undefined },
  });
  expect(at.manager.getStatus().state).toBe("ok");
  await at.cleanup();
  const over = await setup(board(BOARD_HOST_RECORD_LIMIT + 1), {
    manager: { maxRecords: undefined },
  });
  expect(over.manager.getStatus()).toMatchObject({ state: "too-large" });
  await over.cleanup();
});

test.each([
  ["unset", {}],
  ["empty", { COCALC_PROJECT_HOST_BOARD_EDITING: "" }],
  ["0", { COCALC_PROJECT_HOST_BOARD_EDITING: "0" }],
  ["true", { COCALC_PROJECT_HOST_BOARD_EDITING: "true" }],
  [" 1", { COCALC_PROJECT_HOST_BOARD_EDITING: " 1" }],
])(
  "with board editing off (%s), a direct boardOpen or a large write starts nothing",
  async (_name, env) => {
    const project_id = uuid();
    // The writable file service as a project host builds it, gate off.
    const service = `fs-gated-${uuid().slice(0, 8)}`;
    const server = await fsServer({
      service,
      client: connect(),
      fs: async () => localFs(project_id),
      jupyter: {
        importIpynb: async () => ({ ipynb: {} }),
        saveIpynb: async () => ({ bytes: 0, converted: false }),
      } as any,
      board: boardHandlers({
        client: connect(),
        projectIdOf: () => project_id,
        env,
      }),
    });
    const files: any = connect().fs({
      project_id,
      service: fileserver.service,
    });
    const gated: any = connect().fs({ project_id, service });
    await files.writeFile("gated.board.json", canonical(BOARD));
    const writer = await openBoardSyncdb({
      // Writes as the host does (only the manager writes in production; these
      // replicas stand in for edits the host has admitted).
      writer: true,
      client: connect(),
      project_id,
      path: "gated.board.json",
      service: fileserver.service,
    });
    try {
      for (const call of ["boardOpen", "boardSave"]) {
        await expect(gated[call]("gated.board.json")).rejects.toMatchObject({
          code: "ENOSYS",
        });
      }
      // A client writing an oversized change to the board's stream: no host
      // replica exists to apply it.
      // (Over the host's hard limits: 1,600 records, about 6.4 MB.)
      for (let i = 0; i < 1_600; i++) {
        writer.set({
          type: "item",
          page: "",
          id: `x${i}`,
          text: "x".repeat(4_000),
        });
      }
      writer.commit();
      await writer.save();
      await expect(gated.boardOpen("gated.board.json")).rejects.toMatchObject({
        code: "ENOSYS",
      });
      expect(openBoardCount()).toBe(0);
    } finally {
      await writer.close();
      (server as any)?.close?.();
    }
  },
  120_000,
);

test("an invalid snapshot checkpoint is repaired through the board write service", async () => {
  const t = await setup(canonical(BOARD));
  await until(() => itemText(t.browser, "a") === "hello world");
  setText(t.browser, "b", "before the bad checkpoint");
  await until(async () =>
    (await t.read()).includes("before the bad checkpoint"),
  );
  await t.cleanup();
  // Point the latest-snapshot checkpoint at a patch that is no snapshot.
  const ds = await dstream({
    client: connect(),
    project_id: t.project_id,
    name: patchesStreamName({ path: boardSyncdbPath(t.path) }),
    service: BOARD_WRITE_SERVICE,
    persistUser: {},
    // A board writer's fence: the test write service's nonce.
    writeFence: {
      expectedNonce: testSetup.boardWriteFence!.nonce,
      ttlMs: BOARD_WRITE_MAX_TTL_MS,
    },
    noInventory: true,
  });
  const n = ds.length;
  expect(n).toBeGreaterThan(1);
  await ds.setCheckpoint({
    name: "latest_snapshot",
    seq: ds.seq(n - 1)!,
    data: { patchId: "not-a-snapshot" },
  });
  ds.close();
  // The manager's syncdb opens anyway: the fallback full load and its
  // checkpoint repair go through the write service too.
  const syncdb = await openBoardSyncdb({
    writer: true,
    client: connect(),
    project_id: t.project_id,
    path: t.path,
    service: fileserver.service,
    timeoutMs: 20_000,
  });
  try {
    expect(itemText(syncdb, "b")).toBe("before the bad checkpoint");
  } finally {
    await syncdb.close();
  }
});

test("the manager's writer carries the write service's nonce, and can't open without a lock", async () => {
  const project_id = uuid();
  const path = "/home/user/fence.board.json";
  const old = testSetup.boardWriteFence;
  // The host has no board write lock: the writer refuses to open.
  testSetup.setBoardWriteFence(undefined);
  try {
    await expect(
      openBoardSyncdb({
        writer: true,
        client: connect(),
        project_id,
        path,
        service: fileserver.service,
        timeoutMs: 20_000,
      }),
    ).rejects.toThrow(/board writes are unavailable/);
  } finally {
    testSetup.setBoardWriteFence(old);
  }
  // With the lock, it opens and writes, fenced with the current nonce.
  const syncdb = await openBoardSyncdb({
    writer: true,
    client: connect(),
    project_id,
    path,
    service: fileserver.service,
    timeoutMs: 20_000,
  });
  try {
    syncdb.set({ type: "doc", page: "", id: "", title: "fenced" });
    syncdb.commit();
    await syncdb.save();
    // The write service restarts (a new nonce): this writer's writes are
    // refused from now on, never re-signed.
    testSetup.setBoardWriteFence({
      nonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f",
      assertWritable() {},
    });
    const probe = dstream({
      client: connect(),
      project_id,
      name: patchesStreamName({ path: boardSyncdbPath(path) }),
      service: BOARD_WRITE_SERVICE,
      persistUser: {},
      writeFence: {
        expectedNonce: old!.nonce,
        ttlMs: BOARD_WRITE_MAX_TTL_MS,
      },
      noInventory: true,
    });
    const ds = await probe;
    ds.publish({ stale: true });
    // One attempt, refused by the server ("instance"), as every attempt
    // with this writer's nonce will be.
    await expect((ds as any).attemptToSaveBatch()).rejects.toThrow(
      /sent to another server instance/,
    );
    ds.close();
    // Read back through the new instance: the stale write was not stored.
    const reader = await dstream({
      client: connect(),
      project_id,
      name: patchesStreamName({ path: boardSyncdbPath(path) }),
      service: BOARD_WRITE_SERVICE,
      persistUser: {},
      writeFence: {
        expectedNonce: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f",
        ttlMs: BOARD_WRITE_MAX_TTL_MS,
      },
      noInventory: true,
      noCache: true,
    });
    expect(reader.getAll().some((m: any) => m?.stale)).toBe(false);
    expect(reader.length).toBeGreaterThan(0); // the fenced writes are there
    reader.close();
  } finally {
    testSetup.setBoardWriteFence(old);
    await syncdb.close();
  }
});

test("a writer whose fence went stale retires instead of retrying its saves", async () => {
  const text = canonical(BOARD);
  const t = await setup(text);
  const old = testSetup.boardWriteFence;
  try {
    await until(() => itemText(t.browser, "a") === "hello world");
    let refusals = 0;
    t.syncdb.on("fence-refused", () => (refusals += 1));
    // The write service restarts: this writer's nonce is stale.
    testSetup.setBoardWriteFence({
      nonce: "1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e",
      assertWritable() {},
    });
    // A file change: the manager merges it and saves, and is refused.
    const changed = canonical({
      ...BOARD,
      title: "changed on disk",
    });
    await t.fs.writeFile(t.path, changed);
    await until(() => t.manager.isRetired(), 20_000);
    expect(refusals).toBe(1);
    // The merged change was the file's: it is kept there, and the status
    // says so (never "ok").
    expect(t.manager.getStatus()).toMatchObject({
      state: "refused",
      code: "instance",
      unsaved: { in: "file" },
    });
    // One attempt: a later save returns at once, never retrying, and with
    // the refusal, never as if it saved.
    const start = Date.now();
    expect(await t.syncdb.save()).toMatchObject({
      refused: { code: "instance" },
    });
    expect(Date.now() - start).toBeLessThan(1000);
  } finally {
    testSetup.setBoardWriteFence(old);
    await t.cleanup();
  }
}, 60_000);

// astra CORR-956-2: a user's unsaved edits are never discarded silently.
describe("a refused writer keeps its unsaved edits, and says where", () => {
  const STALE = {
    nonce: "2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f",
    assertWritable() {},
  };

  test("in the board's file: through the refusal, a close and a reopen", async () => {
    const text = canonical(BOARD);
    // (No save of its own before the refusal: the edit is only unsaved.)
    const t = await setup(text, { manager: { saveDelayMs: 600_000 } });
    const old = testSetup.boardWriteFence;
    try {
      await until(() => itemText(t.syncdb, "a") === "hello world");
      testSetup.setBoardWriteFence(STALE);
      // The user's edit, in the writer's own document: its save is refused.
      setText(t.syncdb, "a", "the user's unsaved edit");
      await until(() => t.manager.isRetired(), 20_000);
      expect(t.manager.getStatus()).toMatchObject({
        state: "refused",
        unsaved: { in: "file" },
        message: expect.stringContaining("kept in the board's file"),
      });
      expect(await t.read()).toContain("the user's unsaved edit");
    } finally {
      testSetup.setBoardWriteFence(old);
      await t.cleanup();
    }
    // Reopened (a new writer, the service's current fence): the edit is
    // the board's.
    const client = connect();
    const syncdb = await openBoardSyncdb({
      writer: true,
      client,
      project_id: t.project_id,
      path: t.path,
      service: fileserver.service,
    });
    const manager = new BoardManager({
      lib,
      syncdb: syncdb as any,
      file: fileOf(t.local, t.path),
      recordsToString,
    });
    try {
      await manager.start();
      await until(() => itemText(syncdb, "a") === "the user's unsaved edit");
      expect(manager.getStatus()).toMatchObject({ state: "ok" });
    } finally {
      await manager.close();
      await syncdb.close();
      client.close();
    }
  }, 60_000);

  test("in a copy beside it, when the file changed elsewhere", async () => {
    const text = canonical(BOARD);
    let conflict = false;
    const t = await setup(text, {
      manager: { saveDelayMs: 600_000 },
      wrap: (file) => ({
        ...file,
        // The file changed under the save that would keep the edit.
        replace: async (next: string, expected: string) =>
          conflict ? "conflict" : await file.replace(next, expected),
      }),
    });
    const old = testSetup.boardWriteFence;
    try {
      await until(() => itemText(t.syncdb, "a") === "hello world");
      testSetup.setBoardWriteFence(STALE);
      conflict = true;
      setText(t.syncdb, "a", "kept in a copy");
      await until(() => t.manager.isRetired(), 20_000);
      const status: any = t.manager.getStatus();
      expect(status).toMatchObject({
        state: "refused",
        unsaved: { in: "copy" },
      });
      expect(status.unsaved.path).toMatch(/\.board\.json\.unsaved-/);
      expect(status.message).toContain(status.unsaved.path);
      expect(`${await t.fs.readFile(status.unsaved.path, "utf8")}`).toContain(
        "kept in a copy",
      );
      // The board's own file is left as it was.
      expect(await t.read()).toBe(text);
    } finally {
      testSetup.setBoardWriteFence(old);
      await t.cleanup();
    }
  }, 60_000);

  test("the service shows the refusal on the board's next opens", async () => {
    const project_id = uuid();
    const client = connect();
    const fs: any = client.fs({ project_id, service: fileserver.service });
    const opts = {
      client,
      project_id,
      fs: localFs(project_id),
      service: fileserver.service,
    };
    const path = "refused.board.json";
    const old = testSetup.boardWriteFence;
    try {
      await fs.writeFile(path, canonical(BOARD));
      expect(await openBoard({ ...opts, path })).toMatchObject({ state: "ok" });
      testSetup.setBoardWriteFence(STALE);
      // A file change: merged, its save refused, the writer retired.
      await fs.writeFile(path, canonical({ ...BOARD, title: "elsewhere" }));
      await until(async () => openBoardCount() === 0, 20_000);
      testSetup.setBoardWriteFence(old);
      const next = await openBoard({ ...opts, path });
      expect(next).toMatchObject({
        state: "ok",
        lastRefusal: {
          unsaved: { in: "file" },
          message: expect.stringContaining("changed elsewhere"),
        },
      });
    } finally {
      testSetup.setBoardWriteFence(old);
      await closeBoards(project_id);
      client.close();
    }
  }, 60_000);
});
