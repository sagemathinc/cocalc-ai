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
} from "@cocalc/backend/conat/persist-durability";
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
      /const owner = this\.assertOpenAllowed\(checked\.path, row\);\s*\/\/ armed: a sync error here poisons the stream \(SA-B2-1\)\s*runArmedMaintenanceWrite\(checked\.path, owner, "promote:checkpoint", \(\) => \{\s*const sourceDb = new DatabaseSync\(checked\.path\);/,
    ],
    // the quick_check of an output or source
    [
      "backend/conat/persist-maintenance/coordinator.ts",
      /const owner = this\.ownerOf\(databasePath\);\s*assertPersistMaintenanceOpenAllowed\(path, undefined, \(\) => owner\);\s*const db = new DatabaseSync\(path, \{ readOnly: true \}\);/,
    ],
    // the trim's offline compaction and read
    [
      "project-host/persist-storage.ts",
      /function compact\(path: string, owner: string\): void \{\s*assertPersistMaintenanceOpenAllowed\(`\$\{path\}\.db`, undefined, \(\) => owner\);\s*\/\/ armed: a sync error in the VACUUM, its checkpoints or the close poisons\s*\/\/ the stream \(SA-B2-1\)\s*runArmedMaintenanceWrite\(`\$\{path\}\.db`, owner, "trim:compact", \(\) => \{\s*const db = new DatabaseSync/,
    ],
    [
      "project-host/persist-storage.ts",
      /assertPersistMaintenanceOpenAllowed\(`\$\{path\}\.db`, undefined, \(\) => owner\);\s*const db = new DatabaseSync\(`\$\{path\}\.db`\);\s*try \{\s*db\.exec\("PRAGMA busy_timeout=5000"\);\s*const row = db\s*\.prepare\("SELECT MAX\(seq\)/,
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
    it("the trim's compact and promotion's checkpoint fsync their output inside the armed write", () => {
      const trim = fs.readFileSync(join(packages, "project-host/persist-storage.ts"), "utf8");
      expect(trim).toMatch(/runArmedMaintenanceWrite\(`\$\{path\}\.db`, owner, "trim:compact", \(\) => \{[\s\S]{0,400}db\.close\(\);\s*\}\s*\/\/[^\n]*\n\s*fsyncMaintenanceOutput\(`\$\{path\}\.db`\);\s*\}\);/);
      const coord = fs.readFileSync(join(packages, "backend/conat/persist-maintenance/coordinator.ts"), "utf8");
      expect(coord).toMatch(/runArmedMaintenanceWrite\(checked\.path, owner, "promote:checkpoint", \(\) => \{[\s\S]{0,400}sourceDb\.close\(\);\s*\}\s*\/\/[^\n]*\n\s*fsyncMaintenanceOutput\(checked\.path\);\s*\}\);/);
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
    const dispatches = [...source.matchAll(/await this\.runWorker\(\{/g)];
    expect(dispatches).toHaveLength(2);
    for (const d of dispatches) {
      const before = source.slice(Math.max(0, d.index! - 200), d.index);
      expect(before).toMatch(
        /this\.assertOpenAllowed\(checked\.path, row\);\s*(const \w+ = )?$/,
      );
    }
  });

  it("no other DatabaseSync opener of persist files exists in these modules", () => {
    for (const [file, expected] of [
      ["backend/conat/persist-maintenance/coordinator.ts", 2],
      ["project-host/persist-storage.ts", 2],
    ] as const) {
      const source = fs.readFileSync(join(packages, file), "utf8");
      expect(source.match(/new DatabaseSync\(/g)).toHaveLength(expected);
      expect(source.match(/assertPersistMaintenanceOpenAllowed\(/g)!.length).toBeGreaterThanOrEqual(expected);
    }
  });
});
