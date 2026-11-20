/*
 *  This file is part of CoCalc: Copyright (C) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshSqliteMirror } from "./sqlite-mirror";

describe("changed-only SQLite mirror", () => {
  let root: string;
  let sourceDir: string;
  let mirrorDir: string;
  let backups: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cocalc-sqlite-mirror-"));
    sourceDir = join(root, "source");
    mirrorDir = join(root, "mirror");
    backups = [];
    await mkdir(join(sourceDir, "nested"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const refresh = () =>
    refreshSqliteMirror({
      sourceDir,
      mirrorDir,
      backupDatabase: async (sourcePath, destinationPath) => {
        backups.push(sourcePath);
        await writeFile(
          destinationPath,
          `consistent:${await readFile(sourcePath, "utf8")}`,
        );
      },
      now: () => new Date("2026-08-05T12:00:00.000Z"),
    });

  it("[RULE7] never mirrors the persist's records marker (copy B) or its migration flag (028 ALT-D2)", async () => {
    const state = join(sourceDir, ".cocalc-persist-state");
    await mkdir(join(state, "poisoned"), { recursive: true });
    await writeFile(join(state, "records-marker.json"), "{}");
    await writeFile(join(state, "records-migrated.json"), "{}");
    await writeFile(join(state, "poisoned", "k"), "{}");
    const result = await refresh();
    expect(result.changed_files).toEqual([
      join(".cocalc-persist-state", "poisoned", "k"),
    ]);
    await expect(
      readFile(join(mirrorDir, ".cocalc-persist-state", "records-marker.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("backs up only changed databases and ignores WAL/SHM mirror files", async () => {
    const database = join(sourceDir, "nested", "stream.db");
    await writeFile(database, "v1");
    await writeFile(`${database}-wal`, "wal-v1");
    await writeFile(`${database}-shm`, "shm-v1");
    await writeFile(join(sourceDir, "metadata.json"), "metadata-v1");

    const initial = await refresh();
    expect(initial.sqlite_backups).toBe(1);
    expect(initial.copied_files).toBe(1);
    expect(initial.changed_files).toEqual([
      "metadata.json",
      join("nested", "stream.db"),
    ]);
    expect(await readFile(join(mirrorDir, "nested", "stream.db"), "utf8")).toBe(
      "consistent:v1",
    );
    await expect(
      readFile(join(mirrorDir, "nested", "stream.db-wal")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });

    backups = [];
    const unchanged = await refresh();
    expect(unchanged.changed_files).toEqual([]);
    expect(backups).toEqual([]);

    await writeFile(`${database}-wal`, "wal-v2-longer");
    const walChanged = await refresh();
    expect(walChanged.changed_files).toEqual([join("nested", "stream.db")]);
    expect(walChanged.sqlite_backups).toBe(1);
  });

  it("removes deleted files from the mirror and catalog", async () => {
    const database = join(sourceDir, "deleted.db");
    await writeFile(database, "v1");
    await refresh();
    await rm(database);

    const result = await refresh();
    expect(result.deleted_files).toEqual(["deleted.db"]);
    await expect(readFile(join(mirrorDir, "deleted.db"))).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
    const catalog = JSON.parse(
      await readFile(join(mirrorDir, ".cocalc-sqlite-mirror.json"), "utf8"),
    );
    expect(catalog.entries).toEqual({});
  });

  it("does not advance the catalog when a database backup fails", async () => {
    const database = join(sourceDir, "stream.db");
    await writeFile(database, "v1");
    await refresh();
    const catalogPath = join(mirrorDir, ".cocalc-sqlite-mirror.json");
    const before = await readFile(catalogPath, "utf8");
    // Changing the size avoids relying on sub-second mtime precision in CI.
    await writeFile(database, "v2-longer");

    await expect(
      refreshSqliteMirror({
        sourceDir,
        mirrorDir,
        backupDatabase: async () => {
          throw new Error("injected backup failure");
        },
      }),
    ).rejects.toThrow("injected backup failure");
    expect(await readFile(catalogPath, "utf8")).toBe(before);
  });
});
