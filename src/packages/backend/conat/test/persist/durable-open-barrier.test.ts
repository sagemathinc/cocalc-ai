/*
Finding 028 B-2: the open barrier (DESIGN v1.21 §3.2.6, §3.1).

Before a disk-backed stream serves anything, its -wal, .db and directory are
fsync'd, in that order, with hostile-path checks.  A check failure is a
discovery error (refused, retried, never a poison); an fsync error poisons
the file.
*/

import * as fs from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sqlite from "node:sqlite";

import { pstream } from "@cocalc/backend/conat/persist";
import { persistDurabilityRecords } from "@cocalc/backend/conat/persist-durability";
import {
  createFairLimiter,
  openBarrier,
  openBarrierSync,
  persistOpenBarrier,
  setBarrierFsForTests,
} from "@cocalc/backend/conat/persist-open-barrier";
import { DataEncoding } from "@cocalc/conat/core/client";
import { setUnregisteredStreamOwnerForTests } from "@cocalc/conat/persist/context";
import {
  clearOpenBarrierPass,
  prepareDurableOpen,
} from "@cocalc/conat/persist/storage";

const msg = (s: string) => ({
  encoding: DataEncoding.JsonCodec,
  raw: Buffer.from(s),
});

describe("028 B-2: the open barrier", () => {
  let dir: string;
  let streams: any[] = [];
  const open = (name: string, opts: object = {}) => {
    const s = pstream({ path: join(dir, name), ...opts });
    streams.push(s);
    return s;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "persist-028-barrier-"));
    streams = [];
  });

  afterEach(async () => {
    for (const s of streams) {
      try {
        if (!s.isPoisoned?.()) s.close();
      } catch {}
    }
    jest.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("syncs the existing -wal, then the .db, then the directory; an absent -wal means db-only", async () => {
    const db = join(dir, "s.db");
    await writeFile(db, "");
    expect(openBarrierSync(db)).toEqual({ kind: "ok", synced: [db, dir] });
    await writeFile(`${db}-wal`, "");
    expect(openBarrierSync(db)).toEqual({
      kind: "ok",
      synced: [`${db}-wal`, db, dir],
    });
    expect(await openBarrier(db, "host")).toEqual({
      kind: "ok",
      synced: [`${db}-wal`, db, dir],
    });
  });

  it("the fsyncs run in that order (sync form)", async () => {
    const db = join(dir, "order.db");
    await writeFile(db, "");
    await writeFile(`${db}-wal`, "");
    const fds = new Map<number, string>();
    const order: string[] = [];
    setBarrierFsForTests({
      ...fs,
      openSync: ((p: any, ...rest: any[]) => {
        const fd = (fs.openSync as any)(p, ...rest);
        fds.set(fd, `${p}`);
        return fd;
      }) as any,
      fsyncSync: (fd: number) => {
        order.push(fds.get(fd)!);
        return fs.fsyncSync(fd);
      },
    });
    try {
      expect(openBarrierSync(db).kind).toBe("ok");
    } finally {
      setBarrierFsForTests(fs);
    }
    expect(order).toEqual([`${db}-wal`, db, dir]);
  });

  it("a symlink planted at the -wal is a discovery error: nothing is fsync'd through it, the stream is refused, nothing is poisoned", async () => {
    const target = join(dir, "victim");
    await writeFile(target, "x");
    const db = join(dir, "planted.db");
    await writeFile(db, "");
    await symlink(target, `${db}-wal`);
    let fsyncs = 0;
    setBarrierFsForTests({
      ...fs,
      fsyncSync: (fd: number) => {
        fsyncs += 1;
        return fs.fsyncSync(fd);
      },
    });
    let r;
    try {
      r = openBarrierSync(db);
    } finally {
      setBarrierFsForTests(fs);
    }
    expect(r).toMatchObject({ kind: "discovery", path: `${db}-wal` });
    expect(fsyncs).toBe(0);
    expect(() => open("planted")).toThrow("could not be verified yet");
    const records = persistDurabilityRecords();
    expect(records.check(join(dir, "planted"))).toBe("ok");
  });

  it("a non-regular file at the db path is a discovery error", async () => {
    const db = join(dir, "dirdb.db");
    fs.mkdirSync(db);
    expect(openBarrierSync(db)).toMatchObject({ kind: "discovery", path: db });
  });

  it("an fsync error poisons the file: refused now and at every later open in this boot", () => {
    const s = open("poison-at-open");
    s.set(msg("a"));
    s.close();
    streams = [];
    jest.spyOn(persistOpenBarrier, "runSync").mockReturnValue({
      kind: "sync-error",
      path: join(dir, "poison-at-open.db"),
      errno: "EIO",
      synced: [],
    });
    expect(() => open("poison-at-open")).toThrow("had a sync error");
    jest.restoreAllMocks();
    // the record refuses even though the barrier would now pass
    expect(() => open("poison-at-open")).toThrow("had a sync error");
    expect(persistDurabilityRecords().check(join(dir, "poison-at-open"))).toBe(
      "poisoned",
    );
  });

  it("the dirty record exists while the barrier's fsyncs run, and is gone after an ok barrier", () => {
    const records = persistDurabilityRecords();
    const id = join(dir, "armed");
    const seen: boolean[] = [];
    const real = persistOpenBarrier.runSync;
    jest.spyOn(persistOpenBarrier, "runSync").mockImplementation((p) => {
      seen.push(fs.existsSync(records.dirtyPath(id)));
      return real(p);
    });
    open("armed");
    expect(seen).toEqual([true]);
    expect(fs.existsSync(records.dirtyPath(id))).toBe(false);
  });

  it("the server's asynchronous pass is consumed by the construction: no second (synchronous) barrier", async () => {
    const path = join(dir, "pass");
    const sync = jest.spyOn(persistOpenBarrier, "runSync");
    await prepareDurableOpen(path, "host");
    const s = pstream({ path });
    streams.push(s);
    clearOpenBarrierPass(path);
    expect(sync).not.toHaveBeenCalled();
    // a pass is good for one construction only
    s.close();
    streams = [];
    const again = pstream({ path });
    streams.push(again);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("an unused pass (cleared after the get) does not serve a later construction", async () => {
    const path = join(dir, "unused");
    const sync = jest.spyOn(persistOpenBarrier, "runSync");
    await prepareDurableOpen(path, "host");
    clearOpenBarrierPass(path);
    const s = pstream({ path });
    streams.push(s);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("a live cached connection needs no barrier for another reference", async () => {
    const path = join(dir, "cached");
    const first = pstream({ path });
    streams.push(first);
    const run = jest.spyOn(persistOpenBarrier, "run");
    await prepareDurableOpen(path, "host");
    expect(run).not.toHaveBeenCalled();
  });

  it("rows committed by an earlier process under synchronous=OFF are fsync'd before the stream serves them", () => {
    // an "old code" writer: OFF, no barrier, then gone
    const path = join(dir, "off-era");
    const raw = new sqlite.DatabaseSync(`${path}.db`);
    raw.exec("PRAGMA journal_mode=WAL");
    raw.exec("PRAGMA synchronous=OFF");
    raw.exec("CREATE TABLE t(a)");
    raw.exec("INSERT INTO t VALUES(1)");
    // no close: the WAL stays, as after a crash (the process kept it)
    const order: string[] = [];
    const real = persistOpenBarrier.runSync;
    jest.spyOn(persistOpenBarrier, "runSync").mockImplementation((p) => {
      const r = real(p);
      order.push(`barrier ${r.kind} ${(r as any).synced?.length}`);
      return r;
    });
    let stream: any;
    try {
      stream = open("off-era");
    } catch {
      // the foreign schema may be refused; the barrier must still have run
      // first
    }
    expect(order[0]).toMatch(/^barrier ok 3$/);
    raw.close();
    if (stream) stream.close();
    streams = [];
  });

  it("Q-F: a quota errno returned by the barrier's fsync on a project path poisons every stream of that project", async () => {
    const project = "11111111-2222-4333-8444-555555555555";
    const a = join(dir, "qf-a");
    const b = join(dir, "qf-b");
    // b is open in this process, owned by the project
    await prepareDurableOpen(b, project);
    const sb = pstream({ path: b });
    streams.push(sb);
    clearOpenBarrierPass(b);
    jest.spyOn(persistOpenBarrier, "run").mockResolvedValue({
      kind: "sync-error",
      path: `${a}.db`,
      errno: "EDQUOT",
      synced: [],
    });
    await expect(prepareDurableOpen(a, project)).rejects.toThrow(
      "had a sync error",
    );
    jest.restoreAllMocks();
    // the open connection of the same project is poisoned too
    expect(sb.isPoisoned()).toBe(true);
    // and a third stream of the project is refused at open
    const c = join(dir, "qf-c");
    await expect(prepareDurableOpen(c, project)).rejects.toThrow(
      "had a sync error",
    );
    // another project is not affected
    const other = join(dir, "qf-other");
    await prepareDurableOpen(other, "99999999-2222-4333-8444-555555555555");
    const so = pstream({ path: other });
    streams.push(so);
    clearOpenBarrierPass(other);
    expect(so.isPoisoned()).toBe(false);
  });

  it("an EIO (not quota) from the barrier poisons only that file, and a host path never poisons a project", async () => {
    const project = "22222222-2222-4333-8444-555555555555";
    const a = join(dir, "eio-a");
    jest.spyOn(persistOpenBarrier, "run").mockResolvedValue({
      kind: "sync-error",
      path: `${a}.db`,
      errno: "EIO",
      synced: [],
    });
    await expect(prepareDurableOpen(a, project)).rejects.toThrow(
      "had a sync error",
    );
    jest.restoreAllMocks();
    const b = join(dir, "eio-b");
    await prepareDurableOpen(b, project);
    const sb = pstream({ path: b });
    streams.push(sb);
    clearOpenBarrierPass(b);
    expect(sb.isPoisoned()).toBe(false);
  });

  describe("AS-B2-SYNC-OWNER: the SYNCHRONOUS barrier (a newer archive copied at open) settles with the stream's owner", () => {
    // the archive-copy path: the server's pass was consumed, but initArchive
    // copied a newer archive over the file, so the constructor runs the
    // barrier again, synchronously
    const makeArchive = (name: string) => {
      const archive = join(dir, `archive-${name}`);
      const sa = pstream({ path: archive, noCache: true });
      sa.set(msg("from the archive"));
      sa.close();
      return archive;
    };
    const openAfterArchiveCopy = async (
      name: string,
      owner: string,
      archive: string,
    ) => {
      const path = join(dir, name);
      await prepareDurableOpen(path, owner);
      try {
        const s = pstream({ path, archive });
        streams.push(s);
        return s;
      } finally {
        clearOpenBarrierPass(path);
      }
    };
    const syncError = (errno: string) =>
      jest
        .spyOn(persistOpenBarrier, "runSync")
        .mockImplementation((dbPath: string) => ({
          kind: "sync-error",
          path: dbPath,
          errno,
          synced: [],
        }));

    it("a quota errno poisons the project: the open sibling, and a later stream of the project, are refused", async () => {
      const project = "5b2c0001-2222-4333-8444-555555555555";
      const sibling = join(dir, "sync-qf-sibling");
      await prepareDurableOpen(sibling, project);
      const sb = pstream({ path: sibling });
      streams.push(sb);
      clearOpenBarrierPass(sibling);
      const archive = makeArchive("sync-qf-a");
      const spy = syncError("EDQUOT");
      await expect(
        openAfterArchiveCopy("sync-qf-a", project, archive),
      ).rejects.toThrow(
        "had a sync error",
      );
      // it really was the synchronous barrier, on the copied file
      expect(spy).toHaveBeenCalledWith(join(dir, "sync-qf-a.db"));
      jest.restoreAllMocks();
      expect(sb.isPoisoned()).toBe(true);
      await expect(
        prepareDurableOpen(join(dir, "sync-qf-c"), project),
      ).rejects.toThrow("had a sync error");
      // another project is not affected
      const other = join(dir, "sync-qf-other");
      await prepareDurableOpen(other, "5b2c0003-2222-4333-8444-555555555555");
      const so = pstream({ path: other });
      streams.push(so);
      clearOpenBarrierPass(other);
      expect(so.isPoisoned()).toBe(false);
    });

    it("control: a non-quota errno (EIO) there poisons only that file", async () => {
      const project = "5b2c0002-2222-4333-8444-555555555555";
      const sibling = join(dir, "sync-eio-sibling");
      await prepareDurableOpen(sibling, project);
      const sb = pstream({ path: sibling });
      streams.push(sb);
      clearOpenBarrierPass(sibling);
      const archive = makeArchive("sync-eio-a");
      syncError("EIO");
      await expect(
        openAfterArchiveCopy("sync-eio-a", project, archive),
      ).rejects.toThrow(
        "had a sync error",
      );
      jest.restoreAllMocks();
      expect(sb.isPoisoned()).toBe(false);
      const c = join(dir, "sync-eio-c");
      await prepareDurableOpen(c, project);
      const sc = pstream({ path: c });
      streams.push(sc);
      clearOpenBarrierPass(c);
      expect(sc.isPoisoned()).toBe(false);
      // the file itself stays refused
      await expect(
        prepareDurableOpen(join(dir, "sync-eio-a"), project),
      ).rejects.toThrow("had a sync error");
    });

    it("the test-only owner fallback is set nowhere outside tests (SA 3381)", () => {
      // every non-test source of the persist packages: only context.ts (the
      // definition) and test-durability.ts (the test context) set it
      const packages = join(__dirname, "../../../..");
      // (storage.ts READS it, through the import; nothing else may set it)
      const allowed = new Set([
        "conat/persist/context.ts",
        "conat/persist/test-durability.ts",
      ]);
      const hits: string[] = [];
      const walk = (rel: string) => {
        for (const e of fs.readdirSync(join(packages, rel), { withFileTypes: true })) {
          const r = `${rel}/${e.name}`;
          if (e.isDirectory()) {
            if (["node_modules", "dist", "test", "tests", "__tests__"].includes(e.name)) continue;
            walk(r);
          } else if (/\.(ts|js)$/.test(e.name) && !/\.test\.(ts|js)$/.test(e.name)) {
            const src = fs.readFileSync(join(packages, r), "utf8");
            // a setter call, or the context option (`unregisteredStreamOwner:`)
            if (/setUnregisteredStreamOwnerForTests\(|unregisteredStreamOwner\s*:/.test(src) && !allowed.has(r)) hits.push(r);
          }
        }
      };
      for (const dir of ["conat", "backend", "project-host", "hub", "server"]) {
        if (fs.existsSync(join(packages, dir))) walk(dir);
      }
      expect(hits).toEqual([]);
      // and the production context never sets it
      const persist = fs.readFileSync(join(packages, "backend/conat/persist.ts"), "utf8");
      expect(persist).not.toMatch(/unregisteredStreamOwner/);
    });

    it("a stream whose owner is not known (no server registration, no fallback) is refused before anything is armed", async () => {
      const records = persistDurabilityRecords();
      const path = join(dir, "sync-no-owner");
      const armSpy = jest.spyOn(records, "arm");
      const runSpy = jest.spyOn(persistOpenBarrier, "runSync");
      setUnregisteredStreamOwnerForTests(undefined);
      try {
        expect(() => pstream({ path, noCache: true })).toThrow(
          "this stream's owner is not known",
        );
      } finally {
        setUnregisteredStreamOwnerForTests(() => "host");
      }
      expect(armSpy).not.toHaveBeenCalled();
      expect(runSpy).not.toHaveBeenCalled();
      // nothing was left behind: with an owner it opens normally
      const s = pstream({ path, noCache: true });
      streams.push(s);
      expect(s.isPoisoned()).toBe(false);
    });
  });

  it("the fair limiter caps concurrency and serves owners round-robin", async () => {
    const limiter = createFairLimiter(1);
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const job = (name: string, wait?: Promise<void>) => async () => {
      order.push(name);
      await wait;
    };
    const all = [
      limiter.run("a", job("a1", gate)),
      limiter.run("a", job("a2")),
      limiter.run("a", job("a3")),
      limiter.run("b", job("b1")),
    ];
    expect(limiter.stats()).toEqual({ running: 1, waiting: 3 });
    release();
    await Promise.all(all);
    // owners take turns: b1 is not stuck behind all of a's
    expect(order).toEqual(["a1", "a2", "b1", "a3"]);
  });
});
