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
      /this\.assertOpenAllowed\(checked\.path, row\);\s*const sourceDb = new DatabaseSync\(checked\.path\);/,
    ],
    // the quick_check of an output or source
    [
      "backend/conat/persist-maintenance/coordinator.ts",
      /const owner = this\.ownerOf\(databasePath\);\s*assertPersistMaintenanceOpenAllowed\(path, undefined, \(\) => owner\);\s*const db = new DatabaseSync\(path, \{ readOnly: true \}\);/,
    ],
    // the trim's offline compaction and read
    [
      "project-host/persist-storage.ts",
      /function compact\(path: string, owner: string\): void \{\s*assertPersistMaintenanceOpenAllowed\(`\$\{path\}\.db`, undefined, \(\) => owner\);\s*const db = new DatabaseSync/,
    ],
    [
      "project-host/persist-storage.ts",
      /assertPersistMaintenanceOpenAllowed\(`\$\{path\}\.db`, undefined, \(\) => owner\);\s*const db = new DatabaseSync\(`\$\{path\}\.db`\);\s*try \{\s*db\.exec\("PRAGMA busy_timeout=5000"\);\s*const row = db\s*\.prepare\("SELECT MAX\(seq\)/,
    ],
  ];
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
