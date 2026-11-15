/*
Finding 028 B-2: a stream a DEAD process left mid-write (its dirty record
remains) is opened only after a verified page-cache eviction (DESIGN v1.21
§3.2.6 H-b, §3.2.11).  A live process's record keeps refusing; a failed
verification refuses and is retried, never poisons.
*/

import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pstream } from "@cocalc/backend/conat/persist";
import {
  isWriterAlive,
  persistDurabilityRecords,
  persistRunDir,
  procStartTime,
  sha256Hex,
} from "@cocalc/backend/conat/persist-durability";
import {
  PAGECACHE_HELPER_PROGRAM,
  PAGECACHE_HELPER_SHA256,
  PYTHON,
  parseHelperOutput,
  readCheckedHelper,
  verifiedEviction,
  checkedVerifiedEviction,
  setPagecacheSelfTestForTests,
  pagecacheHelperHealth,
  startupPagecacheHelperCheck,
} from "@cocalc/backend/conat/persist-verified-eviction";
import * as context from "@cocalc/conat/persist/context";
import {
  classifyHelperRun,
  evictionIt,
  fstypeOf,
  probeEvictable,
} from "./evictable-probe";
import { createDurabilityRecords } from "@cocalc/conat/persist/durability-records";
import { DataEncoding } from "@cocalc/conat/core/client";
import {
  clearOpenBarrierPass,
  prepareDurableOpen,
} from "@cocalc/conat/persist/storage";

// Can this test directory's page cache be dropped at all (CI: "16 pages still
// resident")?  Decided here, at definition time, by the real helper on a dir
// under the same parent the tests use; only that outcome skips the tests
// below that need real eviction (itEvicts), any other probe failure fails
// them.  The slot-B DEV runs them in full.
const itEvicts = evictionIt(probeEvictable(tmpdir()));

const msg = (s: string) => ({
  encoding: DataEncoding.JsonCodec,
  raw: Buffer.from(s),
});

// a pid that existed and is gone
function deadPid(): number {
  const r = spawnSync(process.execPath, [
    "-e",
    "process.stdout.write(`${process.pid}`)",
  ]);
  const pid = Number(r.stdout.toString());
  expect(fs.existsSync(`/proc/${pid}`)).toBe(false);
  return pid;
}

// a dirty record for id, written by another process generation with pid
function plantDirtyRecord(
  id: string,
  pid: number,
  procStart?: string,
  owner?: string,
) {
  createDurabilityRecords({
    root: persistRunDir(),
    generation: `planted-${pid}-${Math.random()}`,
    fs: fs as any,
    sha256: sha256Hex,
    pid,
    procStart,
  }).arm(id, owner);
}

describe("028 B-2: the helper self-test is retried after a failure (SA 3350 A1)", () => {
  afterEach(() => {
    setPagecacheSelfTestForTests(undefined);
    jest.restoreAllMocks();
  });
  it("a failed self-test refuses and is NOT re-run within its backoff; after it, a pass lets verification proceed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "persist-028-selftest-"));
    const db = join(dir, "s.db");
    await writeFile(db, Buffer.alloc(8192, 1));
    let t = 1_800_000_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => t);
    let calls = 0;
    let pass = false;
    setPagecacheSelfTestForTests(async () => (calls++, pass));
    expect(await checkedVerifiedEviction(db)).toMatchObject({
      verified: false,
      why: "page-cache helper self-test failed",
    });
    t += 30_000; // within the 60 s backoff: refused, not re-run
    expect(await checkedVerifiedEviction(db)).toMatchObject({
      verified: false,
    });
    expect(calls).toBe(1);
    t += 31_000; // past it: re-run; it passes now
    pass = true;
    const r = await checkedVerifiedEviction(db);
    expect(calls).toBe(2);
    expect((r as any)?.why).not.toBe("page-cache helper self-test failed");
    // a pass is kept: no more self-tests
    await checkedVerifiedEviction(db);
    expect(calls).toBe(2);
    await rm(dir, { recursive: true, force: true });
  });
  it("concurrent callers past the backoff share ONE retry (SA 3367 advisory)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "persist-028-selftest-"));
    const db = join(dir, "s.db");
    await writeFile(db, Buffer.alloc(8192, 1));
    let t = 1_800_000_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => t);
    let calls = 0;
    let release!: () => void;
    let gate: Promise<void> = Promise.resolve();
    setPagecacheSelfTestForTests(async () => {
      calls++;
      await gate;
      return false;
    });
    await checkedVerifiedEviction(db);
    expect(calls).toBe(1);
    t += 61_000; // past the backoff
    gate = new Promise<void>((r) => (release = r));
    const all = [1, 2, 3, 4].map(() => checkedVerifiedEviction(db));
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(2); // one retry in flight, not four
    release();
    for (const r of await Promise.all(all)) {
      expect(r).toMatchObject({
        verified: false,
        why: "page-cache helper self-test failed",
      });
    }
    expect(calls).toBe(2);
    await rm(dir, { recursive: true, force: true });
  });
  it("the result is per filesystem: a failure on one does not refuse another, a pass on one does not vouch for another (SA 3575)", async () => {
    const a = await mkdtemp(join(tmpdir(), "persist-028-selftest-a-"));
    const b = await mkdtemp(join(tmpdir(), "persist-028-selftest-b-"));
    await writeFile(join(a, "s.db"), Buffer.alloc(8192, 1));
    await writeFile(join(b, "s.db"), Buffer.alloc(8192, 1));
    // two directories on "different filesystems" (the real lstat still runs:
    // a dir that can't be examined throws as before)
    const devOf = (d: string) => {
      const dev = fs.lstatSync(d).dev;
      return d === a ? 1001 : d === b ? 1002 : dev;
    };
    const seen: string[] = [];
    setPagecacheSelfTestForTests(async (d) => (seen.push(d), d === b), devOf);
    expect(await checkedVerifiedEviction(join(a, "s.db"))).toMatchObject({
      verified: false,
      why: "page-cache helper self-test failed",
    });
    const rb = await checkedVerifiedEviction(join(b, "s.db"));
    expect((rb as any)?.why).not.toBe("page-cache helper self-test failed");
    expect(seen).toEqual([a, b]); // each filesystem tested once, on its own dir
    expect(await checkedVerifiedEviction(join(a, "s.db"))).toMatchObject({
      why: "page-cache helper self-test failed",
    });
    expect(seen).toEqual([a, b]); // a's failure is in its backoff; b's pass is kept
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  });
  it("a directory that can't be examined is not verified", async () => {
    let calls = 0;
    setPagecacheSelfTestForTests(async () => (calls++, true));
    expect(
      await checkedVerifiedEviction(
        join(tmpdir(), "persist-028-no-such-dir", "s.db"),
      ),
    ).toMatchObject({
      verified: false,
      why: "lstat dir failed",
    });
    expect(calls).toBe(0);
  });
});

describe("028 B-2: the startup check of the page-cache helper (B' v8 finding: it needs /usr/bin/python3)", () => {
  afterEach(() => {
    setPagecacheSelfTestForTests(undefined);
    jest.restoreAllMocks();
  });
  it("a failure is a loud health state at start, and seeds the verifications' result for that filesystem", async () => {
    const dir = await mkdtemp(join(tmpdir(), "persist-028-startup-"));
    let calls = 0;
    setPagecacheSelfTestForTests(async () => (calls++, false));
    expect(pagecacheHelperHealth()).toEqual({ state: "pending" });
    expect(await startupPagecacheHelperCheck(dir)).toBe(false);
    expect(pagecacheHelperHealth()).toMatchObject({ state: "failed" });
    await writeFile(join(dir, "s.db"), Buffer.alloc(8192, 1));
    expect(await checkedVerifiedEviction(join(dir, "s.db"))).toMatchObject({
      verified: false,
      why: "page-cache helper self-test failed",
    });
    expect(calls).toBe(1); // the same result, not a second self-test inside the backoff
    await rm(dir, { recursive: true, force: true });
  });
  it("a pass is ok and kept", async () => {
    const dir = await mkdtemp(join(tmpdir(), "persist-028-startup-"));
    let calls = 0;
    setPagecacheSelfTestForTests(async () => (calls++, true));
    expect(await startupPagecacheHelperCheck(dir)).toBe(true);
    expect(pagecacheHelperHealth()).toMatchObject({ state: "ok" });
    await writeFile(join(dir, "s.db"), Buffer.alloc(8192, 1));
    const r = await checkedVerifiedEviction(join(dir, "s.db"));
    expect((r as any)?.why).not.toBe("page-cache helper self-test failed");
    expect(calls).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });
  it("a store dir that can't be examined is failed, not ok", async () => {
    setPagecacheSelfTestForTests(async () => true);
    expect(
      await startupPagecacheHelperCheck(
        join(tmpdir(), "persist-028-no-such-store"),
      ),
    ).toBe(false);
    expect(pagecacheHelperHealth()).toMatchObject({ state: "failed" });
  });
  it("the page-cache helper's interpreter exists on this test host: /usr/bin/python3", () => {
    expect(fs.existsSync(PYTHON)).toBe(true);
  });
  itEvicts(
    "the real self-test passes where /usr/bin/python3 exists (it does on this test host)",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "persist-028-startup-real-"));
      setPagecacheSelfTestForTests(undefined);
      expect(fs.existsSync(PYTHON)).toBe(true);
      expect(await startupPagecacheHelperCheck(dir)).toBe(true);
      expect(pagecacheHelperHealth()).toMatchObject({ state: "ok" });
      await rm(dir, { recursive: true, force: true });
    },
  );
});

describe("028 B-2 tests: the eviction probe skips ONLY on pages still resident (SA 3593)", () => {
  const run = (o: any) => ({
    signal: null,
    status: 0,
    stdout: Buffer.from(""),
    stderr: Buffer.from(""),
    ...o,
  });
  const line = (resident: number) =>
    Buffer.from(
      `{"v":1,"page_size":4096,"pages":16,"resident_after":${resident}}\n`,
    );
  it("a clean run with 0 resident is evictable; with N resident it is not-evictable, with that why", () => {
    expect(classifyHelperRun(run({ stdout: line(0) }), "ext4")).toEqual({
      kind: "evictable",
      fstype: "ext4",
    });
    expect(classifyHelperRun(run({ stdout: line(16) }), "overlay")).toEqual({
      kind: "not-evictable",
      fstype: "overlay",
      why: "16 pages still resident",
    });
  });
  it.each([
    ["a spawn error", { error: new Error("ENOENT") }],
    ["a timeout or signal", { signal: "SIGTERM", status: null }],
    ["a nonzero exit", { status: 1, stdout: line(16) }],
    ["stderr text", { stdout: line(16), stderr: Buffer.from("Traceback") }],
    ["an unparsable line", { stdout: Buffer.from("garbage\n") }],
    [
      "the wrong page count",
      {
        stdout: Buffer.from(
          '{"v":1,"page_size":4096,"pages":3,"resident_after":3}\n',
        ),
      },
    ],
  ])("%s is an error, never a skip", (_name, o) => {
    expect(classifyHelperRun(run(o), "ext4").kind).toBe("error");
  });
  it("the reason line's fstype is read from /proc/self/mountinfo", () => {
    expect(fstypeOf(tmpdir())).toMatch(/^[a-z0-9._-]+$/);
    expect(fstypeOf(tmpdir())).not.toBe("unknown");
  });
});

describe("028 B-2: verified eviction of a stream left mid-write", () => {
  let dir: string;
  let streams: any[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "persist-028-evict-"));
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

  it("the shipped program equals persist-pagecache-helper.py and its pinned sha256", () => {
    const file = fs.readFileSync(
      join(__dirname, "../../persist-pagecache-helper.py"),
      "utf8",
    );
    expect(PAGECACHE_HELPER_PROGRAM).toBe(file);
    expect(sha256Hex(file)).toBe(PAGECACHE_HELPER_SHA256);
    expect(readCheckedHelper()).toEqual(Buffer.from(file));
    // a changed byte: refused
    expect(readCheckedHelper(file + " ")).toBeUndefined();
  });

  it("parses only the exact line, with the parent's page count", () => {
    const ok = '{"v":1,"page_size":4096,"pages":3,"resident_after":0}\n';
    expect(parseHelperOutput(ok, 3)).toEqual({ resident: 0 });
    expect(parseHelperOutput(ok, 4)).toBeUndefined();
    expect(parseHelperOutput(ok + "x", 3)).toBeUndefined();
    expect(
      parseHelperOutput(
        '{"v":1,"page_size":8192,"pages":3,"resident_after":0}\n',
        3,
      ),
    ).toBeUndefined();
    expect(
      parseHelperOutput(
        '{"v":1,"page_size":4096,"pages":3,"resident_after":4}\n',
        3,
      ),
    ).toBeUndefined();
    expect(parseHelperOutput("", 0)).toBeUndefined();
  });

  itEvicts(
    "evicts a real file: fsync, DONTNEED, mincore = 0, and removes the -shm",
    async () => {
      const db = join(dir, "real.db");
      await writeFile(db, Buffer.alloc(256 * 1024, 7));
      await writeFile(`${db}-wal`, Buffer.alloc(64 * 1024, 7));
      await writeFile(`${db}-shm`, Buffer.alloc(32 * 1024, 0));
      fs.readFileSync(db); // resident now
      const r = await verifiedEviction(db);
      expect(r).toEqual({ verified: true, files: [`${db}-wal`, db] });
      expect(fs.existsSync(`${db}-shm`)).toBe(false);
    },
  );

  it("spawns exactly /usr/bin/python3 -I -S - with an empty env, no shell, the program on stdin and the file on fd 3", async () => {
    const db = join(dir, "spy.db");
    await writeFile(db, Buffer.alloc(4096, 1));
    const calls: any[] = [];
    const real = require("node:child_process").spawn;
    const spy = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return real(cmd, args, opts);
    };
    const r = await verifiedEviction(db, { spawnFn: spy as any });
    // the spawn contract, whatever this directory's eviction outcome
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe(PYTHON);
    expect(calls[0].args).toEqual(["-I", "-S", "-"]);
    expect(calls[0].opts.shell).toBe(false);
    expect(calls[0].opts.env).toEqual({});
    expect(calls[0].opts.stdio.slice(0, 3)).toEqual(["pipe", "pipe", "pipe"]);
    expect(typeof calls[0].opts.stdio[3]).toBe("number");
    // the helper ran and answered: verified, or (only) pages still resident
    if (!r.verified)
      expect((r as any).why).toMatch(/^\d+ pages still resident$/);
  });

  itEvicts(
    "the spawned helper verifies a real file (the spawn contract, end to end)",
    async () => {
      const db = join(dir, "spy2.db");
      await writeFile(db, Buffer.alloc(4096, 1));
      const real = require("node:child_process").spawn;
      let n = 0;
      const r = await verifiedEviction(db, {
        spawnFn: ((cmd, args, opts) => (n++, real(cmd, args, opts))) as any,
      });
      expect(n).toBe(1);
      expect(r.verified).toBe(true);
    },
  );

  // a fake child: whatever output, exit code, stderr
  const fakeSpawn =
    ({ stdout = "", stderr = "", code = 0, readStdin = true }) =>
    () => {
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        on: () => {},
        write: (_b, cb) => cb(readStdin ? undefined : new Error("EPIPE")),
        end: () => {},
      };
      child.kill = () => {};
      setImmediate(() => {
        if (stdout) child.stdout.emit("data", Buffer.from(stdout));
        if (stderr) child.stderr.emit("data", Buffer.from(stderr));
        child.emit("close", code, null);
      });
      return child;
    };

  it.each([
    [
      "extra output",
      { stdout: '{"v":1,"page_size":4096,"pages":1,"resident_after":0}\nmore' },
    ],
    [
      "a non-zero exit",
      {
        stdout: '{"v":1,"page_size":4096,"pages":1,"resident_after":0}\n',
        code: 1,
      },
    ],
    [
      "stderr text",
      {
        stdout: '{"v":1,"page_size":4096,"pages":1,"resident_after":0}\n',
        stderr: "x",
      },
    ],
    [
      "pages still resident",
      { stdout: '{"v":1,"page_size":4096,"pages":1,"resident_after":1}\n' },
    ],
    [
      "a failed delivery of the program",
      {
        stdout: '{"v":1,"page_size":4096,"pages":1,"resident_after":0}\n',
        readStdin: false,
      },
    ],
  ])("%s → not verified", async (_name, fake) => {
    const db = join(dir, "fake.db");
    await writeFile(db, Buffer.alloc(4096, 1));
    const r = await verifiedEviction(db, {
      spawnFn: fakeSpawn(fake as any) as any,
    });
    expect(r.verified).toBe(false);
  });

  it("a sha mismatch of the program → not verified, nothing spawned", async () => {
    const db = join(dir, "sha.db");
    await writeFile(db, Buffer.alloc(4096, 1));
    const spawnFn = jest.fn();
    const r = await verifiedEviction(db, {
      program: readCheckedHelper("tampered", PAGECACHE_HELPER_SHA256),
      spawnFn: spawnFn as any,
    });
    expect(r.verified).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("a symlink planted at the -wal → not verified, the helper never runs on it", async () => {
    const target = join(dir, "victim");
    await writeFile(target, Buffer.alloc(4096, 1));
    const db = join(dir, "planted.db");
    await writeFile(db, Buffer.alloc(4096, 1));
    await symlink(target, `${db}-wal`);
    const spawnFn = jest.fn();
    const r = await verifiedEviction(db, { spawnFn: spawnFn as any });
    expect(r).toMatchObject({ verified: false, path: `${db}-wal` });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("writer liveness: a gone pid is dead; this process is alive; a reused pid (other start time) is dead", () => {
    expect(isWriterAlive(deadPid())).toBe(false);
    const mine = procStartTime("self");
    expect(mine).toMatch(/^\d+$/);
    expect(isWriterAlive(process.pid, mine)).toBe(true);
    expect(isWriterAlive(process.pid, "1")).toBe(false);
    // no start time recorded and the pid exists: fail closed (alive)
    expect(isWriterAlive(process.pid)).toBe(true);
  });

  itEvicts(
    "a dead writer's record: the server's open verifies, removes it and serves the stream",
    async () => {
      const path = join(dir, "left");
      const s0 = pstream({ path });
      s0.set(msg("committed"));
      s0.close();
      const records = persistDurabilityRecords();
      plantDirtyRecord(path, deadPid());
      expect(records.check(path)).toBe("leftover");
      // a direct construction can't verify: refused
      expect(() => pstream({ path })).toThrow("not verified yet");
      await prepareDurableOpen(path, "host");
      const s = pstream({ path });
      streams.push(s);
      clearOpenBarrierPass(path);
      expect(records.check(path)).toBe("ok");
      expect(Buffer.from(s.get({ seq: 1 })!.raw).toString()).toBe("committed");
    },
  );

  itEvicts(
    "a failed verification refuses (retryable), keeps the record and poisons nothing; a later retry admits",
    async () => {
      const path = join(dir, "retry");
      const s0 = pstream({ path });
      s0.set(msg("x"));
      s0.close();
      const records = persistDurabilityRecords();
      plantDirtyRecord(path, deadPid());
      const ctx = context as any;
      const real = ctx.verifiedEviction;
      ctx.verifiedEviction = async (db: string) => ({
        verified: false,
        path: db,
        why: "mincore says 3 pages resident",
      });
      try {
        await expect(prepareDurableOpen(path, "host")).rejects.toThrow(
          "not verified yet",
        );
      } finally {
        ctx.verifiedEviction = real;
      }
      expect(records.check(path)).toBe("leftover");
      expect(records.check(path)).not.toBe("poisoned");
      await prepareDurableOpen(path, "host");
      const s = pstream({ path });
      streams.push(s);
      clearOpenBarrierPass(path);
      expect(records.check(path)).toBe("ok");
    },
  );

  itEvicts(
    "a project's leftovers are verified together: opening one stream verifies every file the project left mid-write first",
    async () => {
      const project = "33333333-2222-4333-8444-555555555555";
      const a = join(dir, "proj-a");
      const b = join(dir, "proj-b");
      for (const p of [a, b]) {
        const s0 = pstream({ path: p });
        s0.set(msg(p));
        s0.close();
      }
      const pid = deadPid();
      plantDirtyRecord(a, pid, undefined, project);
      plantDirtyRecord(b, pid, undefined, project);
      const ctx = context as any;
      const real = ctx.verifiedEviction;
      const verified: string[] = [];
      ctx.verifiedEviction = async (db: string) => {
        verified.push(db);
        return real(db);
      };
      try {
        await prepareDurableOpen(a, project);
        const s = pstream({ path: a });
        streams.push(s);
        clearOpenBarrierPass(a);
      } finally {
        ctx.verifiedEviction = real;
      }
      expect(verified.sort()).toEqual([`${a}.db`, `${b}.db`].sort());
      const records = persistDurabilityRecords();
      expect(records.check(a)).toBe("ok");
      expect(records.check(b)).toBe("ok");
    },
  );

  it("if one file of the project fails verification, no stream of the project is served", async () => {
    const project = "44444444-2222-4333-8444-555555555555";
    const a = join(dir, "projf-a");
    const b = join(dir, "projf-b");
    for (const p of [a, b]) {
      const s0 = pstream({ path: p });
      s0.set(msg(p));
      s0.close();
    }
    const pid = deadPid();
    plantDirtyRecord(a, pid, undefined, project);
    plantDirtyRecord(b, pid, undefined, project);
    const ctx = context as any;
    const real = ctx.verifiedEviction;
    ctx.verifiedEviction = async (db: string) =>
      db === `${b}.db`
        ? { verified: false, path: db, why: "resident pages" }
        : real(db);
    try {
      await expect(prepareDurableOpen(a, project)).rejects.toThrow(
        "not verified yet",
      );
    } finally {
      ctx.verifiedEviction = real;
    }
    expect(persistDurabilityRecords().check(b)).toBe("leftover");
  });

  it("a LIVE writer's record keeps refusing: no verification, no removal", async () => {
    const path = join(dir, "live");
    const s0 = pstream({ path });
    s0.set(msg("x"));
    s0.close();
    plantDirtyRecord(path, process.pid, procStartTime("self"));
    const records = persistDurabilityRecords();
    expect(records.check(path)).toBe("unverified");
    await expect(prepareDurableOpen(path, "host")).rejects.toThrow(
      "not verified yet",
    );
    expect(() => pstream({ path })).toThrow("not verified yet");
    expect(records.check(path)).toBe("unverified");
  });
});
