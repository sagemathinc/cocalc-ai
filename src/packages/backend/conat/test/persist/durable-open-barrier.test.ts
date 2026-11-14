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
} from "@cocalc/backend/conat/persist-open-barrier";
import { DataEncoding } from "@cocalc/conat/core/client";
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
    const realOpen = fs.openSync;
    jest.spyOn(fs, "openSync").mockImplementation(((p: any, ...rest: any[]) => {
      const fd = (realOpen as any)(p, ...rest);
      fds.set(fd, `${p}`);
      return fd;
    }) as any);
    const realFsync = fs.fsyncSync;
    const order: string[] = [];
    jest.spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
      order.push(fds.get(fd)!);
      return realFsync(fd);
    });
    expect(openBarrierSync(db).kind).toBe("ok");
    expect(order).toEqual([`${db}-wal`, db, dir]);
  });

  it("a symlink planted at the -wal is a discovery error: nothing is fsync'd through it, the stream is refused, nothing is poisoned", async () => {
    const target = join(dir, "victim");
    await writeFile(target, "x");
    const db = join(dir, "planted.db");
    await writeFile(db, "");
    await symlink(target, `${db}-wal`);
    const fsync = jest.spyOn(fs, "fsyncSync");
    const r = openBarrierSync(db);
    expect(r).toMatchObject({ kind: "discovery", path: `${db}-wal` });
    expect(fsync).not.toHaveBeenCalled();
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
