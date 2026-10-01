import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PersistMaintenanceCatalog } from "@cocalc/backend/conat/persist-maintenance/catalog";
import { PersistMaintenancePathSafety } from "@cocalc/backend/conat/persist-maintenance/path-safety";
import { PersistMaintenanceScanner } from "@cocalc/backend/conat/persist-maintenance/scanner";
import { maintenanceTestConfig } from "@cocalc/backend/conat/test/persist-maintenance/helpers";

const fsPromises: typeof import("node:fs/promises") =
  jest.requireActual("node:fs/promises");

describe("persist maintenance bounded scanner", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "persist-maintenance-scanner-"));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  function makeScanner(scanEntryLimit: number, scanTimeLimitMs = 60_000) {
    const data = join(root, "data");
    mkdirSync(data, { recursive: true });
    const catalogPath = join(root, "catalog", "catalog.sqlite");
    const config = {
      ...maintenanceTestConfig({ root: data, catalogPath, dryRun: true }),
      scanEntryLimit,
      scanTimeLimitMs,
    };
    const catalog = new PersistMaintenanceCatalog(catalogPath);
    const scanner = new PersistMaintenanceScanner(
      catalog,
      new PersistMaintenancePathSafety({ rootTemplates: [data], catalogPath }),
      config,
    );
    return { data, catalog, scanner, config, catalogPath };
  }

  // The read-count assertions measure complexity; allow slow CI filesystem I/O.
  it("enumerates a wide directory once per batch, not once per entry", async () => {
    const { data, catalog, scanner } = makeScanner(256);
    for (let i = 0; i < 1025; i++) {
      writeFileSync(join(data, `${String(i).padStart(4, "0")}.db`), "");
    }
    const reads = jest.spyOn(fsPromises, "readdir");
    let result;
    let batches = 0;
    do {
      result = await scanner.scanBatch();
      batches++;
    } while (!result.complete && batches < 10);
    expect(result.complete).toBe(true);
    expect(result.entries).toBe(1025);
    expect(catalog.listDatabases()).toHaveLength(1025);
    expect(reads).toHaveBeenCalledTimes(5);
    catalog.close();
  }, 30_000);

  it("resumes template-root discovery within the entry budget after restart", async () => {
    const { data, catalog, config, catalogPath } = makeScanner(2);
    config.rootTemplates = [join(data, "project-[project_id]", "persist")];
    for (const name of ["project-a", "project-b", "project-c", "unrelated"]) {
      mkdirSync(join(data, name, "persist"), { recursive: true });
      writeFileSync(join(data, name, "persist", "a.db"), "");
    }
    symlinkSync(join(data, "unrelated"), join(data, "project-link"));
    const scanner = () =>
      new PersistMaintenanceScanner(
        catalog,
        new PersistMaintenancePathSafety({
          rootTemplates: config.rootTemplates,
          catalogPath,
        }),
        config,
      );
    let result = await scanner().scanBatch();
    expect(result.complete).toBe(false);
    expect(result.entries).toBe(2);
    expect(result.files).toBe(0);
    const reads = jest.spyOn(fsPromises, "readdir");
    let previous = result.entries;
    do {
      result = await scanner().scanBatch();
      expect(result.entries - previous).toBeLessThanOrEqual(2);
      previous = result.entries;
    } while (!result.complete);
    expect(result.files).toBe(3);
    expect(catalog.listDatabases()).toHaveLength(3);
    expect(reads.mock.calls.filter(([path]) => path === data)).toHaveLength(2);
    catalog.close();
  });

  it("starts the time budget before template discovery, not after expansion", async () => {
    const { data, catalog, config, catalogPath } = makeScanner(1000, 10);
    config.rootTemplates = [join(data, "project-[project_id]", "persist")];
    for (const name of ["project-a", "project-b"]) {
      mkdirSync(join(data, name, "persist"), { recursive: true });
      writeFileSync(join(data, name, "persist", "a.db"), "");
    }
    let now = Date.now();
    jest.spyOn(Date, "now").mockImplementation(() => now);
    const read = fsPromises.readdir;
    const reads = jest.spyOn(fsPromises, "readdir").mockImplementation((async (
      ...args: any[]
    ) => {
      const entries = await (read as any)(...args);
      now += 20;
      return entries;
    }) as typeof fsPromises.readdir);
    const scanner = new PersistMaintenanceScanner(
      catalog,
      new PersistMaintenancePathSafety({
        rootTemplates: config.rootTemplates,
        catalogPath,
      }),
      config,
    );
    const result = await scanner.scanBatch();
    expect(result.complete).toBe(false);
    expect(result.files).toBe(0);
    expect(result.entries).toBe(1);
    expect(reads).toHaveBeenCalledTimes(1);
    catalog.close();
  });

  it("resumes by name across scanner restart and directory changes", async () => {
    const { data, catalog, scanner, config, catalogPath } = makeScanner(1);
    for (const name of ["a.db", "b.db", "c.db"]) {
      writeFileSync(join(data, name), "");
    }
    expect((await scanner.scanBatch()).entries).toBe(1);
    rmSync(join(data, "a.db"));
    writeFileSync(join(data, "aa.db"), "");
    const restarted = new PersistMaintenanceScanner(
      catalog,
      new PersistMaintenancePathSafety({ rootTemplates: [data], catalogPath }),
      config,
    );
    let result;
    do {
      result = await restarted.scanBatch();
    } while (!result.complete);
    for (const name of ["aa.db", "b.db", "c.db"]) {
      expect(catalog.getDatabase(join(data, name))?.presence_state).toBe(
        "present",
      );
    }
    catalog.close();
  });

  it("safely restarts an old positional directory cursor", async () => {
    const { data, catalog, scanner } = makeScanner(10);
    writeFileSync(join(data, "a.db"), "");
    catalog.setState(
      "scan_cursor",
      JSON.stringify({
        startedAt: Date.now(),
        roots: [data],
        rootIndex: 1,
        stack: [],
        current: { path: data, index: 5000 },
        files: 0,
        entries: 5000,
        bytes: 0,
      }),
    );
    expect((await scanner.scanBatch()).complete).toBe(true);
    expect(catalog.getDatabase(join(data, "a.db"))?.presence_state).toBe(
      "present",
    );
    catalog.close();
  });

  it("yields after the time budget and resumes on the next batch", async () => {
    const { data, catalog, scanner } = makeScanner(1000, 10);
    for (const name of ["a.db", "b.db"]) writeFileSync(join(data, name), "");
    let now = Date.now();
    jest.spyOn(Date, "now").mockImplementation(() => now);
    const read = fsPromises.readdir;
    jest.spyOn(fsPromises, "readdir").mockImplementation((async (
      ...args: any[]
    ) => {
      const entries = await (read as any)(...args);
      now += 20;
      return entries;
    }) as typeof fsPromises.readdir);
    const first = await scanner.scanBatch();
    expect(first.complete).toBe(false);
    expect(first.entries).toBe(1);
    jest.restoreAllMocks();
    let result;
    do {
      result = await scanner.scanBatch();
    } while (!result.complete);
    expect(result.files).toBe(2);
    catalog.close();
  });

  it("resumes bounded scans, ignores symlinks, and marks vanished files missing", async () => {
    const data = join(root, "data");
    const outside = join(root, "outside");
    mkdirSync(join(data, "nested"), { recursive: true });
    mkdirSync(outside);
    for (const path of [join(data, "a.db"), join(data, "nested", "b.db")]) {
      const db = new DatabaseSync(path);
      db.exec("CREATE TABLE t(x)");
      db.close();
    }
    symlinkSync(outside, join(data, "outside-link"));
    const catalogPath = join(root, "catalog", "catalog.sqlite");
    const config = {
      ...maintenanceTestConfig({ root: data, catalogPath, dryRun: true }),
      scanEntryLimit: 1,
    };
    const catalog = new PersistMaintenanceCatalog(catalogPath);
    const scanner = new PersistMaintenanceScanner(
      catalog,
      new PersistMaintenancePathSafety({
        rootTemplates: [data],
        catalogPath,
      }),
      config,
    );
    let result;
    do {
      result = await scanner.scanBatch();
    } while (!result.complete);
    expect(catalog.listDatabases()).toHaveLength(2);

    rmSync(join(data, "a.db"));
    catalog.setState("scan_completed_at", "0");
    do {
      result = await scanner.scanBatch();
    } while (!result.complete);
    expect(catalog.getDatabase(join(data, "a.db"))?.presence_state).toBe(
      "missing",
    );
    expect(
      catalog.getDatabase(join(data, "nested", "b.db"))?.presence_state,
    ).toBe("present");
    catalog.close();
  });
});
