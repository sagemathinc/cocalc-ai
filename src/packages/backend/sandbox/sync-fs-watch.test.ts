import {
  SyncFsWatchStore,
  carryOverFsHeads,
  removeSnapshotStoreLater,
} from "./sync-fs-watch";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { tmpNameSync } from "tmp-promise";
import { decodePatchId, legacyPatchId } from "patchflow";

describe("SyncFsWatchStore", () => {
  it("stores content and computes a patch for external changes", async () => {
    const store = new SyncFsWatchStore();
    store.setContent("a.txt", "hello");

    const result = await store.handleExternalChange(
      "a.txt",
      async () => "hello world",
    );

    expect(result.deleted).toBe(false);
    expect(result.content).toBe("hello world");
    expect(result.patch).toBeDefined();
    store.close();
  });

  it("does not turn a read failure into empty content", async () => {
    const store = new SyncFsWatchStore();
    store.setContent("read-error.slides", "complete document");
    const err: NodeJS.ErrnoException = new Error("temporary read failure");
    err.code = "EIO";

    await expect(
      store.handleExternalChange("read-error.slides", async () => {
        throw err;
      }),
    ).rejects.toBe(err);

    expect(store.get("read-error.slides")).toMatchObject({
      content: "complete document",
      deleted: false,
    });
    store.close();
  });

  it("marks deletes without throwing", () => {
    const store = new SyncFsWatchStore();
    store.setContent("b.txt", "data");
    store.markDeleted("b.txt");

    const state = store.get("b.txt");
    expect(state?.deleted).toBe(true);
    store.close();
  });

  it("short-circuits structured diffs when the raw file hash matches", async () => {
    const store = new SyncFsWatchStore();
    store.setContent("same.chat", '{"a":1}\n');
    const codec = {
      fromString: jest.fn(() => {
        throw new Error("codec should not be used for exact-hash no-op");
      }),
      makePatch: jest.fn(),
    } as any;

    const result = await store.handleExternalChange(
      "same.chat",
      async () => '{"a":1}\n',
      false,
      codec,
    );

    expect(result.patch).toBeUndefined();
    expect(codec.fromString).not.toHaveBeenCalled();
    expect(store.getDebugStats()).toMatchObject({
      exactHashNoops: 1,
      emptyPatchNoops: 0,
    });
    store.close();
  });

  it("suppresses empty structured patches but still refreshes the stored snapshot", async () => {
    const store = new SyncFsWatchStore();
    store.setContent("noop.chat", '{"a":1}\n');
    const current = '{"a":1} \n';
    const codec = {
      fromString: jest.fn((text: string) => ({ text })),
      makePatch: jest.fn(() => [1, []]),
    } as any;

    const result = await store.handleExternalChange(
      "noop.chat",
      async () => current,
      false,
      codec,
    );

    expect(result.patch).toBeUndefined();
    expect(result.content).toBe(current);
    expect(store.get("noop.chat")?.content).toBe(current);
    expect(store.getDebugStats()).toMatchObject({
      exactHashNoops: 0,
      emptyPatchNoops: 1,
    });
    store.close();
  });

  it("persists fs heads with heads and lastSeq", () => {
    const dbPath = tmpNameSync({ prefix: "sync-fs-heads-", postfix: ".db" });
    const store1 = new SyncFsWatchStore(dbPath);
    store1.setFsHead({
      string_id: "s1",
      time: legacyPatchId(10),
      version: 3,
      heads: [legacyPatchId(8), legacyPatchId(10)],
      lastSeq: 42,
      formatVersion: 2,
    });
    store1.close();

    const store2 = new SyncFsWatchStore(dbPath);
    const head = store2.getFsHead("s1");
    expect(decodePatchId(head!.time).timeMs).toBe(10);
    expect(head?.version).toBe(3);
    expect(head?.lastSeq).toBe(42);
    expect(head?.formatVersion).toBe(2);
    expect(head?.heads?.map((h) => decodePatchId(h).timeMs)).toEqual([8, 10]);
    store2.close();
  });
});

describe("SyncFsWatchStore snapshot retention", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "sync-fs-retention-")));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const waitFor = async (check: () => boolean, ms = 5_000) => {
    for (const end = Date.now() + ms; !check() && Date.now() < end; ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return check();
  };

  const makeOldStore = (file: string) => {
    const old = new DatabaseSync(file);
    old.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA wal_autocheckpoint=0;
      CREATE TABLE files (path TEXT PRIMARY KEY, content TEXT NOT NULL);
    `);
    old
      .prepare("INSERT INTO files VALUES(?, ?)")
      .run("/p/a", "x".repeat(1 << 20));
    expect(existsSync(`${file}-wal`)).toBe(true);
    return old;
  };

  it("removes an old store file in the background after the delay", async () => {
    const file = join(dir, "sync-fs.sqlite");
    makeOldStore(file).close();
    removeSnapshotStoreLater(file, 300);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existsSync(file)).toBe(true);
    expect(await waitFor(() => !existsSync(file))).toBe(true);
    expect(existsSync(`${file}-wal`)).toBe(false);
    expect(existsSync(`${file}-shm`)).toBe(false);
  });

  it("waits while another process has the old store open", async () => {
    const file = join(dir, "sync-fs.sqlite");
    makeOldStore(file).close();
    // An idle SQLite connection in another process, as a preserved worker
    // from the previous release would have.
    const holder = spawn(
      process.execPath,
      [
        "-e",
        `const { DatabaseSync } = require("node:sqlite");
         const db = new DatabaseSync(process.argv[1]);
         db.prepare("SELECT count(*) FROM files").get();
         console.log("open");
         setTimeout(() => {}, 60000);`,
        file,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      await new Promise((resolve) => holder.stdout!.once("data", resolve));
      removeSnapshotStoreLater(file, 10, 100);
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(existsSync(file)).toBe(true);
    } finally {
      holder.kill("SIGKILL");
    }
    expect(await waitFor(() => !existsSync(file))).toBe(true);
  });

  it("leaves a file alone when its state can't be determined", async () => {
    const file = join(dir, "sync-fs.sqlite");
    writeFileSync(file, "not a database, but not ours to guess about");
    removeSnapshotStoreLater(file, 10, 100);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(existsSync(file)).toBe(true);
  });

  it("prunes old snapshots of unwatched paths only, in batches", () => {
    const file = join(dir, "sync-fs.sqlite");
    const store = new SyncFsWatchStore(file);
    for (const name of ["a", "b", "c", "d"]) {
      store.setContent(`/p/${name}`, name);
    }
    const keep = new Set(["/p/b"]);
    // Nothing is old enough yet.
    expect(
      store.pruneSnapshots({ olderThan: 0, keep, watchedSince: 0 }),
    ).toEqual({
      deleted: 0,
      more: false,
    });
    const olderThan = Date.now() + 1;
    const first = store.pruneSnapshots({
      olderThan,
      keep,
      watchedSince: 0,
      maxRows: 2,
    });
    expect(first).toEqual({ deleted: 2, more: true });
    const second = store.pruneSnapshots({
      olderThan,
      keep,
      watchedSince: 0,
      maxRows: 2,
    });
    expect(second.deleted).toBe(1);
    expect(store.get("/p/b")?.content).toBe("b");
    for (const name of ["a", "c", "d"]) {
      expect(store.get(`/p/${name}`)).toBeUndefined();
    }
    store.close();
  });
});

describe("SyncFsWatchStore prune batches", () => {
  it("stops a batch at the byte budget and reports what is left", () => {
    const store = new SyncFsWatchStore();
    try {
      store.setContent("/p/keep", "k");
      for (const name of ["a", "b", "c"]) {
        store.setContent(`/p/${name}`, name.repeat(1000));
      }
      const prune = (maxBytes: number) =>
        store.pruneSnapshots({
          olderThan: Date.now() + 1,
          keep: new Set(["/p/keep", "/p/elsewhere"]),
          watchedSince: 0,
          maxRows: 10,
          maxBytes,
        });
      // Always at least one row, even over the budget.
      expect(prune(10)).toEqual({ deleted: 1, more: true });
      expect(prune(2000)).toEqual({ deleted: 2, more: false });
      expect(store.get("/p/keep")?.content).toBe("k");
    } finally {
      store.close();
    }
  });

  it("reports more when kept rows did not fill the limit", () => {
    const store = new SyncFsWatchStore();
    try {
      for (const name of ["a", "b", "c"]) store.setContent(`/p/${name}`, name);
      // limit = maxRows + keep.size = 4 > 3 candidates; 2 removable remain
      const result = store.pruneSnapshots({
        olderThan: Date.now() + 1,
        keep: new Set(["/p/x", "/p/y", "/p/z"]),
        watchedSince: 0,
        maxRows: 1,
      });
      expect(result).toEqual({ deleted: 1, more: true });
    } finally {
      store.close();
    }
  });
});

describe("SyncFsWatchStore watches shared between processes", () => {
  it("holds the write lock from selecting candidates to deleting them", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sync-fs-lock-")));
    const file = join(dir, "sync-fs-snapshots.sqlite");
    const store = new SyncFsWatchStore(file);
    const other = new DatabaseSync(file);
    other.exec("PRAGMA busy_timeout=0");
    try {
      store.setContent("/p/a", "a");
      let blocked: unknown;
      store.onPruneCandidatesForTests = () => {
        // Another process starting to watch /p/a right now has to wait.
        try {
          other
            .prepare(
              "INSERT INTO watching(path, owner, seenAt) VALUES('/p/a', 'other', ?)",
            )
            .run(Date.now());
        } catch (err) {
          blocked = err;
        }
      };
      const result = store.pruneSnapshots({
        olderThan: Date.now() + 1,
        keep: new Set(),
        watchedSince: 0,
      });
      expect(`${blocked}`).toMatch(/locked|busy/i);
      expect(result.deleted).toBe(1);
    } finally {
      other.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-checks a candidate when it is deleted", () => {
    const store = new SyncFsWatchStore();
    try {
      store.setContent("/p/a", "a");
      store.setContent("/p/b", "b");
      // Simulates a row that changed after it was selected (e.g. by a
      // connection that held the lock first): rewritten and now watched.
      store.onPruneCandidatesForTests = () => {
        store.onPruneCandidatesForTests = undefined;
        store.markWatching("other", "/p/a", 100);
      };
      const result = store.pruneSnapshots({
        olderThan: Date.now() + 1,
        keep: new Set(),
        watchedSince: 50,
      });
      expect(result.deleted).toBe(1);
      expect(store.get("/p/a")?.content).toBe("a");
      expect(store.get("/p/b")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("does not prune a path another process is watching", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sync-fs-shared-")));
    const file = join(dir, "sync-fs-snapshots.sqlite");
    const main = new SyncFsWatchStore(file);
    const worker = new SyncFsWatchStore(file);
    try {
      main.setContent("/p/open.ipynb", "open");
      main.setContent("/p/closed.ipynb", "closed");
      main.markWatching("main", "/p/open.ipynb", 1_000);
      const prune = (watchedSince: number) =>
        worker.pruneSnapshots({
          olderThan: Date.now() + 1,
          keep: new Set(),
          watchedSince,
        });
      expect(prune(1_000).deleted).toBe(1);
      expect(worker.get("/p/open.ipynb")?.content).toBe("open");
      expect(worker.get("/p/closed.ipynb")).toBeUndefined();
      // A watch not refreshed since watchedSince belongs to a dead process.
      expect(prune(1_001).deleted).toBe(1);
      expect(worker.get("/p/open.ipynb")).toBeUndefined();

      main.markWatching("main", "/p/a", 5);
      main.markWatching("main", "/p/b", 5);
      worker.markWatching("worker", "/p/c", 5);
      main.refreshWatching({
        owner: "main",
        paths: ["/p/b"],
        now: 10,
        expireBefore: 6,
      });
      // main's /p/a is gone, /p/b refreshed, the stale worker watch expired
      main.setContent("/p/a", "a");
      main.setContent("/p/b", "b");
      main.setContent("/p/c", "c");
      expect(prune(10).deleted).toBe(2);
      expect(main.get("/p/b")?.content).toBe("b");
      main.unmarkWatching("main");
      expect(prune(0).deleted).toBe(1);
    } finally {
      main.close();
      worker.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("carryOverFsHeads", () => {
  it("copies fs_heads from the old store once, keeping newer rows", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sync-fs-heads-")));
    const oldPath = join(dir, "sync-fs.sqlite");
    const old = new DatabaseSync(oldPath);
    // fs_heads from before its column migrations, with a large WAL
    old.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA wal_autocheckpoint=0;
      CREATE TABLE files (path TEXT PRIMARY KEY, content TEXT NOT NULL);
      CREATE TABLE fs_heads (string_id TEXT PRIMARY KEY,
        time INTEGER NOT NULL, version INTEGER NOT NULL);
    `);
    const ins = old.prepare("INSERT INTO fs_heads VALUES(?, ?, ?)");
    old.exec("BEGIN");
    for (let i = 0; i < 1200; i++) ins.run(`sid${i}`, i, i);
    old.exec("COMMIT");
    const store = new SyncFsWatchStore(join(dir, "sync-fs-snapshots.sqlite"));
    try {
      store.setFsHead({ string_id: "sid1", time: "99" as any, version: 99 });
      await expect(carryOverFsHeads(store, oldPath)).resolves.toBe(1200);
      expect(store.getFsHead("sid7")).toMatchObject({ time: 7, version: 7 });
      expect(store.getFsHead("sid1")?.version).toBe(99);
      expect(store.fsHeadsCarriedOver()).toBe(true);
      // once only
      await expect(carryOverFsHeads(store, oldPath)).resolves.toBe(0);
      // the old store was only read
      expect(old.prepare("SELECT count(*) AS n FROM fs_heads").get()).toEqual({
        n: 1200,
      });
    } finally {
      store.close();
      old.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks a store without an old one as done", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sync-fs-heads-")));
    const store = new SyncFsWatchStore(join(dir, "sync-fs-snapshots.sqlite"));
    try {
      await expect(
        carryOverFsHeads(store, join(dir, "sync-fs.sqlite")),
      ).resolves.toBe(0);
      expect(store.fsHeadsCarriedOver()).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects without marking when the old store can't be checked", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sync-fs-heads-")));
    const store = new SyncFsWatchStore(join(dir, "sync-fs-snapshots.sqlite"));
    try {
      // a path that is too long: ENAMETOOLONG, not a missing file
      const oldPath = join(dir, "x".repeat(5000));
      await expect(carryOverFsHeads(store, oldPath)).rejects.toThrow(
        /ENAMETOOLONG/,
      );
      expect(store.fsHeadsCarriedOver()).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects without marking when the old store can't be read", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sync-fs-heads-")));
    const oldPath = join(dir, "sync-fs.sqlite");
    writeFileSync(oldPath, "not a database");
    const store = new SyncFsWatchStore(join(dir, "sync-fs-snapshots.sqlite"));
    try {
      await expect(carryOverFsHeads(store, oldPath)).rejects.toThrow();
      expect(store.fsHeadsCarriedOver()).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
