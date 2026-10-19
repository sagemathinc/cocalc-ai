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
import { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import { from_str as immerFromStr } from "@cocalc/sync/editor/immer-db/doc";
import {
  BOARD_PRIMARY_KEYS,
  BOARD_STRING_COLS,
} from "@cocalc/util/board/names";
import { BoardManager, type BoardFile } from "./manager";
import {
  type ReplaceHooks,
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
  const browser = await openBoardSyncdb({
    client: connect(),
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
    file: fileOf(t.local, t.path),
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
    const { t } = await opened({ maxBytes: bytes + 20 });
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
      expect(names.filter((n) => n.includes(".sage-board-"))).toEqual([]);
    } finally {
      await t.cleanup();
    }
  });

  test("a write into the old file after the check is kept as a conflict copy", async () => {
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
      hook = async () => {
        // A writer that had the old file open writes into it.
        await t.fs.writeFile(await asideOf(t.fs, t.path), late);
      };
      setText(t.browser, "b", "local");
      await until(() => hook === undefined);
      await t.manager.settled();
      const names: string[] = await t.fs.readdir(".");
      const copies = names.filter((n) => n.startsWith(`${t.path}.conflict-`));
      expect(copies.length).toBe(1);
      expect(`${await t.fs.readFile(copies[0], "utf8")}`).toBe(late);
      expect(await t.read()).toContain('"local"');
      expect(names.filter((n) => n.includes(".sage-board-"))).toEqual([]);
    } finally {
      await t.cleanup();
    }
  });

  test("a version found aside after a crash goes back to the board's name", async () => {
    const t = await setup(canonical(BOARD));
    try {
      await t.manager.close();
      const aside = `.${t.path}.${uuid()}.sage-board-aside`;
      await t.fs.rename(t.path, aside);
      const info = await fileOf(t.local, `/home/user/${t.path}`).info();
      expect(info?.size).toBe(Buffer.byteLength(canonical(BOARD)));
      expect(await t.read()).toBe(canonical(BOARD));
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
