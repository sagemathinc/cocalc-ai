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

const packages = join(__dirname, "../../../..");

describe("028 B-2: maintenance opens check the durability records first", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "persist-028-maint-"));
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

  // Source pins: each maintenance opener calls the check before it opens.
  const pins: Array<[string, RegExp]> = [
    // promotion's exclusive checkpoint
    [
      "backend/conat/persist-maintenance/coordinator.ts",
      /assertPersistMaintenanceOpenAllowed\(checked\.path\);\s*const sourceDb = new DatabaseSync\(checked\.path\);/,
    ],
    // the quick_check of an output or source
    [
      "backend/conat/persist-maintenance/coordinator.ts",
      /assertPersistMaintenanceOpenAllowed\(path\);\s*const db = new DatabaseSync\(path, \{ readOnly: true \}\);/,
    ],
    // the trim's offline compaction and read
    [
      "project-host/persist-storage.ts",
      /function compact\(path: string\): void \{\s*assertPersistMaintenanceOpenAllowed\(`\$\{path\}\.db`\);\s*const db = new DatabaseSync/,
    ],
    [
      "project-host/persist-storage.ts",
      /assertPersistMaintenanceOpenAllowed\(`\$\{path\}\.db`\);\s*const db = new DatabaseSync\(`\$\{path\}\.db`\);\s*try \{\s*db\.exec\("PRAGMA busy_timeout=5000"\);\s*const row = db\s*\.prepare\("SELECT MAX\(seq\)/,
    ],
  ];
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
        /assertPersistMaintenanceOpenAllowed\(checked\.path\);\s*(const \w+ = )?$/,
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
