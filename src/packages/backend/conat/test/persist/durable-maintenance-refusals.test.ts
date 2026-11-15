/*
Finding 028 B-2: every maintenance open of a persist database is refused
unless the stream's durability records are clean (DESIGN v1.21 §4A row 9,
§3.2.5 open check, vanta P1).  A poisoned file, or one a process left
mid-write, is never opened, copied or checkpointed by promotion, inspection,
compaction or the trim's offline reads.
*/

import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertPersistMaintenanceOpenAllowed,
  fsyncMaintenanceOutput,
  MaintenanceFsyncError,
  runArmedMaintenanceWrite,
  persistDurabilityRecords,
  persistRunDir,
  sha256Hex,
  runArmedMaintenanceWriteAsync,
  MaintenanceCompletionUnprovenError,
  withMaintenanceConnection,
} from "@cocalc/backend/conat/persist-durability";
import { workerOutcome } from "@cocalc/backend/conat/persist-maintenance/compact-worker";
import { createDurabilityRecords } from "@cocalc/conat/persist/durability-records";
import { syncFiles } from "@cocalc/conat/persist/context";
import { ownerOfLocalPath, resolveLocalPath } from "@cocalc/conat/persist/util";
import { maintenanceOwner } from "@cocalc/backend/conat/persist-maintenance/owner";

const packages = join(__dirname, "../../../..");

describe("028 B-2: maintenance opens check the durability records first", () => {
  let dir: string;
  beforeEach(async () => {
    // under the persist root, so the stream's owner can be derived (B2-M1):
    // a host-owned stream
    fs.mkdirSync(syncFiles.local, { recursive: true });
    dir = await mkdtemp(join(syncFiles.local, "persist-028-maint-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("clean records: allowed", () => {
    expect(() =>
      assertPersistMaintenanceOpenAllowed(join(dir, "clean.db")),
    ).not.toThrow();
  });

  it("a poisoned file is refused", () => {
    const id = join(dir, "poisoned");
    const records = persistDurabilityRecords();
    records.arm(id);
    records.poison(id, { where: "test" });
    expect(() => assertPersistMaintenanceOpenAllowed(`${id}.db`)).toThrow(
      "the stream is poisoned",
    );
  });

  it("a file another process holds (or left) mid-write is refused", () => {
    const id = join(dir, "other");
    createDurabilityRecords({
      root: persistRunDir(),
      generation: "another-process",
      fs: fs as any,
      sha256: sha256Hex,
      pid: 0, // unknown writer: counts as alive
    }).arm(id);
    expect(() => assertPersistMaintenanceOpenAllowed(`${id}.db`)).toThrow(
      "the stream is unverified",
    );
  });

  it("the key is the normalized path: a doubled slash or a dot segment does not wash a record off", () => {
    const id = join(dir, "norm");
    const records = persistDurabilityRecords();
    records.arm(id);
    records.poison(id, { where: "test" });
    const alias = `${dir}//./norm.db`;
    expect(() => assertPersistMaintenanceOpenAllowed(alias)).toThrow(
      "poisoned",
    );
  });

  // B2-M1 (ops0 3587): the records are checked WITH the stream's owner
  it("a stream of a project-POISONED project is refused, though it has no record of its own", () => {
    const project = "aaaaaaaa-0288-4000-8000-000000000001";
    const path = resolveLocalPath(`projects/${project}/b2m1-stream`, {
      ephemeral: true,
    });
    expect(ownerOfLocalPath(path)).toBe(project);
    expect(() => assertPersistMaintenanceOpenAllowed(`${path}.db`)).not.toThrow();
    const records = persistDurabilityRecords();
    records.poisonProject(project, { where: "test (B2-M1)" });
    try {
      expect(() => assertPersistMaintenanceOpenAllowed(`${path}.db`)).toThrow(
        "the stream is poisoned",
      );
      // another project's stream is not affected
      const other = resolveLocalPath(
        "projects/aaaaaaaa-0288-4000-8000-000000000002/b2m1-stream",
        { ephemeral: true },
      );
      expect(() => assertPersistMaintenanceOpenAllowed(`${other}.db`)).not.toThrow();
    } finally {
      records.clearProjectPoison?.(project);
    }
  });

  it("a path whose owner can't be derived is refused", () => {
    expect(ownerOfLocalPath(join(tmpdir(), "outside", "x"))).toBeUndefined();
    expect(() =>
      assertPersistMaintenanceOpenAllowed(join(tmpdir(), "outside", "x.db")),
    ).toThrow("owner can't be derived");
  });

  it("ownerOfLocalPath is the owner the open path keys (projectOfStoragePath, else host)", () => {
    const project = "aaaaaaaa-0288-4000-8000-000000000003";
    for (const [logical, owner] of [
      [`projects/${project}/a/b`, project],
      ["hub/x", "host"],
      ["accounts/bbbbbbbb-0000-4000-8000-000000000001/x", "host"],
      ["something/else", "host"],
    ] as const) {
      expect(ownerOfLocalPath(resolveLocalPath(logical, { ephemeral: true }))).toBe(owner);
    }
    // normalized: a dot segment can't move a project stream out of its project
    const p = resolveLocalPath(`projects/${project}/a`, { ephemeral: true });
    expect(ownerOfLocalPath(`${p}/../../${project}/a`)).toBe(project);
  });

  // Source pins: each maintenance opener calls the check before it opens.
  const pins: Array<[string, RegExp]> = [
    // promotion's exclusive checkpoint
    [
      "backend/conat/persist-maintenance/coordinator.ts",
      /const owner = this\.assertOpenAllowed\(checked\.path, row\);\s*\/\/ armed: a sync error here poisons the stream \(SA-B2-1\)\s*runArmedMaintenanceWrite\(checked\.path, owner, "promote:checkpoint", \(\) => \{\s*(\/\/[^\n]*\n\s*)*withMaintenanceConnection\(checked\.path, 1000, \(\) => \{\}\);/,
    ],
    // the quick_check of an output or source
    [
      "backend/conat/persist-maintenance/coordinator.ts",
      /const owner = this\.ownerOf\(databasePath\);\s*assertPersistMaintenanceOpenAllowed\(path, undefined, \(\) => owner\);\s*const db = new DatabaseSync\(path, \{ readOnly: true \}\);/,
    ],
    // the trim's offline compaction and read
    [
      "project-host/persist-storage.ts",
      /function compact\(path: string, owner: string\): void \{\s*assertPersistMaintenanceOpenAllowed\(`\$\{path\}\.db`, undefined, \(\) => owner\);\s*\/\/ armed: a sync error in the VACUUM, its checkpoints or the close poisons\s*\/\/ the stream \(SA-B2-1\)\s*runArmedMaintenanceWrite\(`\$\{path\}\.db`, owner, "trim:compact", \(\) => \{\s*(\/\/[^\n]*\n\s*)*withMaintenanceConnection\(`\$\{path\}\.db`, 5000, \(db\) => db\.exec\("VACUUM"\)\);/,
    ],
    // SA-B2-3: the trim's read is armed too (its read-write close is a write)
    [
      "project-host/persist-storage.ts",
      /assertPersistMaintenanceOpenAllowed\(`\$\{path\}\.db`, undefined, \(\) => owner\);\s*(\/\/[^\n]*\n\s*)*return runArmedMaintenanceWrite\(`\$\{path\}\.db`, owner, "trim:last-seq", \(\) => \{\s*(\/\/[^\n]*\n\s*)*const seq = withMaintenanceConnection\(`\$\{path\}\.db`, 5000, \(db\) => \{\s*const row = db\s*\.prepare\("SELECT MAX\(seq\)/,
    ],
    // SA-B2-3: the compaction worker's read-write source connection runs
    // armed (the parent arms around the worker)
    [
      "backend/conat/persist-maintenance/coordinator.ts",
      /const owner = this\.assertOpenAllowed\(checked\.path, row\);\s*(\/\/[^\n]*\n\s*)*const result = await runArmedMaintenanceWriteAsync\(\s*checked\.path,\s*owner,\s*"compact:vacuum-into",\s*\(\) =>\s*this\.runWorker\(\{\s*sourcePath: checked\.path,\s*outputPath,/,
    ],
  ];
  it("ownerOfLocalPath inverts every project-template form resolveLocalPath builds", () => {
    const id = "aaaaaaaa-0288-4000-8000-0000000000cc";
    const cases: Array<[any, string, string | undefined]> = [
      // [project_id] inside a segment, with a suffix (e.g. /mnt/cocalc/project-[project_id]-persist)
      [{ local: "/srv/sync", localProjects: "/mnt/cocalc/project-[project_id]-persist" }, `/mnt/cocalc/project-${id}-persist/a/b`, id],
      // [project_id] as a whole segment, with a sub-path after it
      [{ local: "/srv/sync", localProjects: "/btrfs/project-[project_id]/.local/share/cocalc/persist" }, `/btrfs/project-${id}/.local/share/cocalc/persist/x`, id],
      // no token: <template>/<id>
      [{ local: "/srv/sync", localProjects: "/data/projects" }, `/data/projects/${id}/x`, id],
      // the legacy <local>/projects/<id>/ layout
      [{ local: "/srv/sync" }, `/srv/sync/projects/${id}/x`, id],
      // host-owned roots
      [{ local: "/srv/sync" }, "/srv/sync/hub/x", "host"],
      [{ local: "/srv/sync", localHub: "/srv/hub" }, "/srv/hub/x", "host"],
      [{ local: "/srv/sync", localAccounts: "/srv/acct-[account_id]" }, "/srv/acct-bbbbbbbb-0000-4000-8000-000000000001/x", "host"],
      // outside every root, and a near-miss of a template prefix
      [{ local: "/srv/sync", localProjects: "/mnt/cocalc/project-[project_id]-persist" }, "/mnt/other/x", undefined],
      [{ local: "/srv/sync", localProjects: "/mnt/cocalc/project-[project_id]-persist" }, `/mnt/cocalc/project-${id}/x`, undefined],
    ];
    for (const [files, path, want] of cases) {
      expect([path, ownerOfLocalPath(path, files)]).toEqual([path, want]);
    }
  });

  describe("B2-M1: the maintained database's owner (logical primary, physical fallback, both must agree)", () => {
    const A = "aaaaaaaa-0288-4000-8000-00000000000a";
    const B = "aaaaaaaa-0288-4000-8000-00000000000b";
    const physical = (logical: string) => resolveLocalPath(logical, { ephemeral: true });
    it("logical and physical agree: that owner", () => {
      expect(
        maintenanceOwner({ logicalPath: `projects/${A}/x`, physicalPath: physical(`projects/${A}/x`), files: syncFiles }),
      ).toEqual({ owner: A });
      expect(
        maintenanceOwner({ logicalPath: "hub/x", physicalPath: physical("hub/x"), files: syncFiles }),
      ).toEqual({ owner: "host" });
    });
    it("logical says project A, physical says project B: REFUSED, naming both", () => {
      const r = maintenanceOwner({ logicalPath: `projects/${A}/x`, physicalPath: physical(`projects/${B}/x`), files: syncFiles }) as any;
      expect(r.owner).toBeUndefined();
      expect(r.refused).toContain(A);
      expect(r.refused).toContain(B);
      // a project's logical path over a host-owned physical path too
      expect((maintenanceOwner({ logicalPath: `projects/${A}/x`, physicalPath: physical("hub/x"), files: syncFiles }) as any).refused).toMatch(/ambiguous/);
    });
    it("no logical path: the physical path's owner; a physical path under no root: logical alone", () => {
      expect(maintenanceOwner({ physicalPath: physical(`projects/${B}/x`), files: syncFiles })).toEqual({ owner: B });
      expect(maintenanceOwner({ logicalPath: `projects/${A}/x`, physicalPath: join(tmpdir(), "outside", "x.db"), files: syncFiles })).toEqual({ owner: A });
    });
    it("neither: REFUSED", () => {
      expect((maintenanceOwner({ physicalPath: join(tmpdir(), "outside", "x.db"), files: syncFiles }) as any).refused).toMatch(/can't be derived/);
    });
    it("the coordinator takes the owner only from this rule, and refuses on a refusal", () => {
      const src = fs.readFileSync(join(packages, "backend/conat/persist-maintenance/coordinator.ts"), "utf8");
      expect(src).toMatch(/const r = maintenanceOwner\(\{/);
      expect(src).toMatch(/if \("refused" in r\) \{[\s\S]{0,240}throw new Error\(`persist maintenance open refused \(finding 028\): \$\{r\.refused\}`\);/);
      expect(src).toMatch(/assertPersistMaintenanceOpenAllowed\(path, undefined, \(\) => owner\);/);
      expect(src).not.toMatch(/projectOfStoragePath|ownerOfLocalPath/);
    });
  });

  it("B2-M1: the trim passes the project it built the path for as the owner", () => {
    const src = fs.readFileSync(join(packages, "project-host/persist-storage.ts"), "utf8");
    expect(src).toMatch(/lastSeqBefore\(path, policy\.since, ctx\.project_id\)/);
    expect(src).toMatch(/compact\(path, ctx\.project_id\);/);
  });

  describe("SA-B2-1: a maintenance WRITE runs with the stream's dirty record armed", () => {
    const fake = () => {
      const calls: string[] = [];
      return {
        calls,
        records: {
          arm: (id: string, owner?: string) => calls.push(`arm ${id} ${owner}`),
          disarm: (id: string) => calls.push(`disarm ${id}`),
          poison: (id: string, info: any) => calls.push(`poison ${id} ${info.where} ${info.errcode}`),
        } as any,
      };
    };
    it("success: armed around the write, then disarmed", () => {
      const f = fake();
      expect(runArmedMaintenanceWrite("/r/x.db", "P", "t", () => (f.calls.push("write"), 7), f.records)).toBe(7);
      expect(f.calls).toEqual(["arm /r/x P", "write", "disarm /r/x"]);
    });
    it("a SQLite sync error: the record becomes the poisoned-file record, never disarmed, rethrown", () => {
      const f = fake();
      const err = Object.assign(new Error("disk I/O error"), { errcode: 1034 });
      expect(() => runArmedMaintenanceWrite("/r/x.db", "P", "trim:compact", () => { throw err; }, f.records)).toThrow(err);
      expect(f.calls).toEqual(["arm /r/x P", "poison /r/x maintenance:trim:compact 1034"]);
    });
    it("a dir-fsync error too (1290)", () => {
      const f = fake();
      const err = Object.assign(new Error("x"), { errcode: 1290 });
      expect(() => runArmedMaintenanceWrite("/r/x.db", "P", "p", () => { throw err; }, f.records)).toThrow(err);
      expect(f.calls[1]).toBe("poison /r/x maintenance:p 1290");
    });
    it("any other error (no sync error consumed): disarmed, rethrown", () => {
      const f = fake();
      const err = Object.assign(new Error("database is locked"), { errcode: 5 });
      expect(() => runArmedMaintenanceWrite("/r/x.db", "P", "p", () => { throw err; }, f.records)).toThrow(err);
      expect(f.calls).toEqual(["arm /r/x P", "disarm /r/x"]);
    });
    it("an fsync of ours (MaintenanceFsyncError) is a sync error; EDQUOT/ENOSPC also poisons the PROJECT (Q-F)", () => {
      for (const [code, project] of [["EIO", false], ["EDQUOT", true], ["ENOSPC", true]] as const) {
        const calls: string[] = [];
        const records = {
          arm: () => {}, disarm: () => calls.push("disarm"),
          poison: (id: string, info: any) => calls.push(`poison ${id} ${info.errno}`),
          poisonProject: (owner: string, info: any) => calls.push(`project ${owner} ${info.errno}`),
        } as any;
        const err = new MaintenanceFsyncError("/r/x.db", Object.assign(new Error(code), { code }) as any);
        expect(() => runArmedMaintenanceWrite("/r/x.db", "P", "trim:compact", () => { throw err; }, records)).toThrow(err);
        expect(calls).toEqual(project ? [`poison /r/x ${code}`, `project P ${code}`] : [`poison /r/x ${code}`]);
      }
    });
    it("fsyncMaintenanceOutput fsyncs the file (O_NOFOLLOW), then its directory; an error is a MaintenanceFsyncError", () => {
      const calls: string[] = [];
      const fsx = {
        openSync: (p: string, flags: number) => (calls.push(`open ${p} ${flags & fs.constants.O_NOFOLLOW ? "nofollow" : ""}${flags & fs.constants.O_DIRECTORY ? "dir" : ""}`), calls.length),
        fsyncSync: (fd: number) => calls.push(`fsync ${fd}`),
        closeSync: (fd: number) => calls.push(`close ${fd}`),
      } as any;
      fsyncMaintenanceOutput("/r/sub/x.db", fsx);
      expect(calls).toEqual(["open /r/sub/x.db nofollow", "fsync 1", "close 1", "open /r/sub dir", "fsync 4", "close 4"]);
      const bad = { ...fsx, fsyncSync: () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); } };
      expect(() => fsyncMaintenanceOutput("/r/sub/x.db", bad)).toThrow(MaintenanceFsyncError);
    });
    it("the trim's compact and read, and promotion's checkpoint, fsync their output inside the armed write, after withMaintenanceConnection", () => {
      const trim = fs.readFileSync(join(packages, "project-host/persist-storage.ts"), "utf8");
      expect(trim).toMatch(/"trim:compact", \(\) => \{\s*(\/\/[^\n]*\n\s*)*withMaintenanceConnection\([^\n]*\n\s*(\/\/[^\n]*\n\s*)*fsyncMaintenanceOutput\(`\$\{path\}\.db`\);\s*\}\);/);
      expect(trim).toMatch(/"trim:last-seq", \(\) => \{[\s\S]{0,700}\}\);\s*(\/\/[^\n]*\n\s*)*fsyncMaintenanceOutput\(`\$\{path\}\.db`\);\s*return seq;/);
      const coord = fs.readFileSync(join(packages, "backend/conat/persist-maintenance/coordinator.ts"), "utf8");
      expect(coord).toMatch(/"promote:checkpoint", \(\) => \{\s*(\/\/[^\n]*\n\s*)*withMaintenanceConnection\(checked\.path, 1000, \(\) => \{\}\);\s*(\/\/[^\n]*\n\s*)*fsyncMaintenanceOutput\(checked\.path\);\s*\}\);/);
    });
    describe("SA-B2-3 / review: withMaintenanceConnection (open, fn, explicit TRUNCATE checkpoint, close)", () => {
      const fakeDb = (fail: Partial<Record<"fn" | "checkpoint" | "close", unknown>> = {}) => {
        const calls: string[] = [];
        const db = {
          exec: (sql: string) => {
            calls.push(sql);
            if (sql.includes("wal_checkpoint") && fail.checkpoint) throw fail.checkpoint;
          },
          close: () => {
            calls.push("close");
            if (fail.close) throw fail.close;
          },
        };
        return { calls, db };
      };
      const sync = () => Object.assign(new Error("disk I/O error"), { errcode: 1034 });
      it("success: fn, then the checkpoint, then the close", () => {
        const f = fakeDb();
        expect(withMaintenanceConnection("/r/x.db", 7, () => (f.calls.push("fn"), 3), () => f.db)).toBe(3);
        expect(f.calls).toEqual(["PRAGMA busy_timeout=7", "fn", "PRAGMA wal_checkpoint(TRUNCATE)", "close"]);
      });
      it("an ordinary exception after the open (e.g. the SELECT): completion UNPROVEN (the record stays armed); closed", () => {
        const f = fakeDb();
        expect(() => withMaintenanceConnection("/r/x.db", 7, () => { throw new Error("no such table"); }, () => f.db)).toThrow(MaintenanceCompletionUnprovenError);
        expect(f.calls).toEqual(["PRAGMA busy_timeout=7", "close"]);
      });
      it("a sync error in fn, the checkpoint or the close is rethrown as is (the runner poisons)", () => {
        const e1 = sync();
        expect(() => withMaintenanceConnection("/r/x.db", 7, () => { throw e1; }, () => fakeDb().db)).toThrow(e1);
        const e2 = sync();
        expect(() => withMaintenanceConnection("/r/x.db", 7, () => {}, () => fakeDb({ checkpoint: e2 }).db)).toThrow(e2);
        const e3 = sync();
        expect(() => withMaintenanceConnection("/r/x.db", 7, () => {}, () => fakeDb({ close: e3 }).db)).toThrow(e3);
        // a sync error at the close after an ordinary failure wins
        const e4 = sync();
        expect(() => withMaintenanceConnection("/r/x.db", 7, () => { throw new Error("x"); }, () => fakeDb({ close: e4 }).db)).toThrow(e4);
      });
      it("an ORDINARY error from the close after fn and the checkpoint succeeded: UNPROVEN, never a plain error (REVIEW-B2-CLOSE-1)", () => {
        const f = fakeDb({ close: Object.assign(new Error("database is locked"), { errcode: 5 }) });
        expect(() => withMaintenanceConnection("/r/x.db", 7, () => 1, () => f.db)).toThrow(MaintenanceCompletionUnprovenError);
        expect(f.calls).toEqual(["PRAGMA busy_timeout=7", "PRAGMA wal_checkpoint(TRUNCATE)", "close"]);
      });
      it("a failure to open: nothing was opened, the error as is (the runner disarms)", () => {
        const err = new Error("unable to open database file");
        expect(() => withMaintenanceConnection("/r/x.db", 7, () => 1, () => { throw err; })).toThrow(err);
      });
      it("in the runner: unproven -> stays ARMED; sync -> poisoned; open failure -> disarmed", () => {
        const run = (fn: () => unknown) => {
          const calls: string[] = [];
          const records = {
            arm: () => calls.push("arm"), disarm: () => calls.push("disarm"),
            poison: () => calls.push("poison"), poisonProject: () => calls.push("project"),
          } as any;
          try { runArmedMaintenanceWrite("/r/x.db", "P", "trim:last-seq", fn, records); } catch {}
          return calls;
        };
        expect(run(() => withMaintenanceConnection("/r/x.db", 7, () => { throw new Error("SELECT failed"); }, () => fakeDb().db))).toEqual(["arm"]);
        expect(run(() => withMaintenanceConnection("/r/x.db", 7, () => {}, () => fakeDb({ checkpoint: sync() }).db))).toEqual(["arm", "poison"]);
        expect(run(() => withMaintenanceConnection("/r/x.db", 7, () => 1, () => { throw new Error("ENOENT"); }))).toEqual(["arm", "disarm"]);
        // an ordinary close error after success: stays ARMED; a sync close error: poisoned
        expect(run(() => withMaintenanceConnection("/r/x.db", 7, () => 1, () => fakeDb({ close: new Error("close failed") }).db))).toEqual(["arm"]);
        expect(run(() => withMaintenanceConnection("/r/x.db", 7, () => 1, () => fakeDb({ close: sync() }).db))).toEqual(["arm", "poison"]);
      });
    });
    it("SA-B2-3: the worker checkpoints explicitly before its close, and reports its phase and any sync errcode on stdout", () => {
      const worker = fs.readFileSync(join(packages, "backend/conat/persist-maintenance/compact-worker.ts"), "utf8");
      expect(worker).toMatch(/phase = "source-open";\s*const db = new DatabaseSync\(options\.sourcePath\);\s*try \{\s*db\.exec\("PRAGMA busy_timeout=5000"\);\s*db\.prepare\("VACUUM INTO \?"\)\.run\(options\.outputPath\);\s*(\/\/[^\n]*\n\s*)*db\.exec\("PRAGMA wal_checkpoint\(TRUNCATE\)"\);\s*\} catch \(err\) \{[\s\S]{0,300}throw err;\s*\}\s*db\.close\(\);\s*phase = "source-closed";/);
      expect(worker).toMatch(/process\.stdout\.write\(JSON\.stringify\(\{ ok: false, phase, errcode \}\)\);/);
    });
    it("SA-B2-3 / review: workerOutcome is strict: only an exact report proves anything", () => {
      const base = { signal: null, timedOut: false, timeoutMs: 1000, stderr: "", sourcePath: "/r/x.db" };
      const ok = { beforeIdentity: {}, beforeStats: {} };
      expect(workerOutcome({ ...base, code: 0, stdout: JSON.stringify({ ok: true, result: ok }) })).toEqual({ result: ok });
      const err = (o: any) => (workerOutcome({ ...base, ...o }) as any).error;
      const unproven = (o: any) => expect(err(o)).toBeInstanceOf(MaintenanceCompletionUnprovenError);
      unproven({ code: null, signal: "SIGKILL", stdout: "" });
      unproven({ code: null, timedOut: true, stdout: "" });
      unproven({ code: 1, stdout: "" }); // no report
      unproven({ code: 1, stdout: '{"ok":false,"phase":"source-open","errcode":null}' }); // the close may have checkpointed
      unproven({ code: 1, stdout: '{"ok":false,"phase":"source-op' }); // truncated
      unproven({ code: 1, stdout: '{"ok":false,"phase":"before-open"}' }); // a missing field
      unproven({ code: 1, stdout: '{"ok":false,"phase":"before-open","errcode":null,"x":1}' }); // an extra field
      unproven({ code: 1, stdout: '{"ok":false,"phase":"elsewhere","errcode":null}' }); // an unknown phase
      unproven({ code: 1, stdout: '{"ok":false,"phase":"before-open","errcode":5}' }); // another errcode
      unproven({ code: 0, stdout: '{"ok":false,"phase":"before-open","errcode":null}' }); // a failure report with exit 0
      unproven({ code: 1, stdout: JSON.stringify({ ok: true, result: ok }) }); // success with exit 1
      unproven({ code: 0, stdout: "x" + JSON.stringify({ ok: true, result: ok }) });
      // a SQLite sync error keeps its errcode (in any phase)
      expect(err({ code: 1, stdout: '{"ok":false,"phase":"source-open","errcode":1034}' }).errcode).toBe(1034);
      expect(err({ code: 1, stdout: '{"ok":false,"phase":"source-closed","errcode":1290}' }).errcode).toBe(1290);
      // the source settled: plain errors (disarmed)
      for (const phase of ["before-open", "source-closed"]) {
        const e = err({ code: 1, stdout: JSON.stringify({ ok: false, phase, errcode: null }) });
        expect(e).not.toBeInstanceOf(MaintenanceCompletionUnprovenError);
        expect(e.errcode).toBeUndefined();
      }
    });
    describe("SA-B2-3: runArmedMaintenanceWriteAsync (the compaction worker)", () => {
      const fakeRecords = () => {
        const calls: string[] = [];
        return {
          calls,
          records: {
            arm: (id: string, owner?: string) => calls.push(`arm ${id} ${owner}`),
            disarm: (id: string) => calls.push(`disarm ${id}`),
            poison: (id: string, info: any) => calls.push(`poison ${id} ${info.where} ${info.errcode}`),
            poisonProject: (owner: string) => calls.push(`project ${owner}`),
          } as any,
        };
      };
      const outcomeError = (o: any) =>
        (workerOutcome({ signal: null, timedOut: false, timeoutMs: 1, stderr: "", sourcePath: "/r/x.db", code: 1, stdout: "", ...o }) as any).error;
      it("success: armed around the run, then disarmed", async () => {
        const f = fakeRecords();
        await expect(runArmedMaintenanceWriteAsync("/r/x.db", "P", "compact:vacuum-into", async () => (f.calls.push("run"), 1), f.records)).resolves.toBe(1);
        expect(f.calls).toEqual(["arm /r/x P", "run", "disarm /r/x"]);
      });
      it("a reported sync error: poisoned, never disarmed", async () => {
        const f = fakeRecords();
        const err = outcomeError({ stdout: '{"ok":false,"phase":"source-open","errcode":1034}' });
        await expect(runArmedMaintenanceWriteAsync("/r/x.db", "P", "compact:vacuum-into", async () => { throw err; }, f.records)).rejects.toBe(err);
        expect(f.calls).toEqual(["arm /r/x P", "poison /r/x maintenance:compact:vacuum-into 1034"]);
      });
      it("unproven (killed, timed out, an ordinary failure with the source open, no or a malformed report): the record stays ARMED", async () => {
        for (const o of [{ code: null, timedOut: true }, { code: null, signal: "SIGKILL" }, { stdout: '{"ok":false,"phase":"source-open","errcode":null}' }, { stdout: "" }, { stdout: "{" }]) {
          const f = fakeRecords();
          const err = outcomeError(o);
          await expect(runArmedMaintenanceWriteAsync("/r/x.db", "P", "compact:vacuum-into", async () => { throw err; }, f.records)).rejects.toBe(err);
          expect([o, f.calls]).toEqual([o, ["arm /r/x P"]]);
        }
      });
      it("a failure before the source was opened read-write, or after it was checkpointed and closed: disarmed", async () => {
        for (const phase of ["before-open", "source-closed"]) {
          const f = fakeRecords();
          const err = outcomeError({ stdout: JSON.stringify({ ok: false, phase, errcode: null }) });
          await expect(runArmedMaintenanceWriteAsync("/r/x.db", "P", "c", async () => { throw err; }, f.records)).rejects.toBe(err);
          expect(f.calls).toEqual(["arm /r/x P", "disarm /r/x"]);
        }
      });
    });
    it("the record can't be created: refused, the write never runs", () => {
      let ran = false;
      const records = { arm: () => { throw new Error("EROFS"); }, disarm: () => {}, poison: () => {} } as any;
      expect(() => runArmedMaintenanceWrite("/r/x.db", "P", "p", () => { ran = true; }, records)).toThrow("dirty record can't be created");
      expect(ran).toBe(false);
    });
  });

  it.each(pins)("%s checks before opening (%#)", (file, re) => {
    expect(fs.readFileSync(join(packages, file), "utf8")).toMatch(re);
  });

  it("both worker dispatches (inspection, compaction) check their source first", () => {
    const source = fs.readFileSync(
      join(packages, "backend/conat/persist-maintenance/coordinator.ts"),
      "utf8",
    );
    const dispatches = [...source.matchAll(/this\.runWorker\(\{/g)];
    expect(dispatches).toHaveLength(2);
    for (const d of dispatches) {
      const before = source.slice(Math.max(0, d.index! - 400), d.index);
      // the inspection directly; the compaction through the armed runner
      expect(before).toMatch(
        /this\.assertOpenAllowed\(checked\.path, row\);\s*(const \w+ = )?(await )?$|const owner = this\.assertOpenAllowed\(checked\.path, row\);\s*(\/\/[^\n]*\n\s*)*const result = await runArmedMaintenanceWriteAsync\([^)]*\(\) =>\s*$/,
      );
    }
  });

  it("no other DatabaseSync opener of persist files exists in these modules", () => {
    for (const [file, expected, rw] of [
      // [file, read-only DatabaseSync openers, read-write openers through
      // withMaintenanceConnection]
      ["backend/conat/persist-maintenance/coordinator.ts", 1, 1],
      ["project-host/persist-storage.ts", 0, 2],
    ] as const) {
      const source = fs.readFileSync(join(packages, file), "utf8");
      expect((source.match(/new DatabaseSync\(/g) ?? []).length).toBe(expected);
      expect((source.match(/new DatabaseSync\([^)]*readOnly: true/g) ?? []).length).toBe(expected);
      expect(source.match(/withMaintenanceConnection\(/g)).toHaveLength(rw);
      expect(source.match(/assertPersistMaintenanceOpenAllowed\(/g)!.length).toBeGreaterThanOrEqual(expected + rw);
    }
    // the worker: one read-only inspection opener, one read-write source
    // opener (the parent checks and arms, SA-B2-3)
    const worker = fs.readFileSync(join(packages, "backend/conat/persist-maintenance/compact-worker.ts"), "utf8");
    expect(worker.match(/new DatabaseSync\(/g)).toHaveLength(2);
    expect(worker).toMatch(/new DatabaseSync\(path, \{ readOnly \}\)/);
  });
});
