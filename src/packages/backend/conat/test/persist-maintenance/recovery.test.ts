import {
  copyFileSync,
  existsSync,
  lstatSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { createPersistMaintenanceCoordinator } from "@cocalc/backend/conat/persist-maintenance/coordinator";
import {
  createBloatedDatabase,
  maintenanceTestConfig,
  quickCheck,
} from "@cocalc/backend/conat/test/persist-maintenance/helpers";

describe("persist maintenance catalog recovery", () => {
  it("preserves a corrupt catalog and rebuilds disposable state", async () => {
    const root = await mkdtemp(join(tmpdir(), "persist-maintenance-recovery-"));
    const catalogPath = join(root, "catalog.sqlite");
    writeFileSync(catalogPath, "not a sqlite database");
    const coordinator = createPersistMaintenanceCoordinator({
      expectedWorkerIds: ["0"],
      config: maintenanceTestConfig({ root, catalogPath, dryRun: true }),
    });
    coordinator.createLocalHooks("0");
    expect(coordinator.status()).toMatchObject({
      catalogHealthy: true,
      trackingCoverage: true,
    });
    expect(existsSync(catalogPath)).toBe(true);
    expect(
      (await readdir(root)).some((name) =>
        name.startsWith(`${basename(catalogPath)}.corrupt-`),
      ),
    ).toBe(true);
    coordinator.close();
    await rm(root, { recursive: true, force: true });
  });

  it("restores an exact rollback when the coordinator died mid-promotion", async () => {
    const root = await mkdtemp(join(tmpdir(), "persist-maintenance-recovery-"));
    const sourcePath = join(root, "source.db");
    const catalogPath = join(root, "catalog", "catalog.sqlite");
    createBloatedDatabase(sourcePath, 32);
    const config = maintenanceTestConfig({ root, catalogPath, dryRun: true });
    const first = createPersistMaintenanceCoordinator({
      expectedWorkerIds: ["0"],
      config,
    });
    const stat = lstatSync(sourcePath);
    first.catalog.observeFile(sourcePath, {
      device: Number(stat.dev),
      inode: Number(stat.ino),
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      walSizeBytes: 0,
    });
    const row = first.catalog.getDatabase(sourcePath)!;
    const runId = first.catalog.createRun(row, "promoting");
    const rollbackPath = join(root, `.source.db.rollback-${runId}`);
    const outputPath = join(root, `.source.db.compact-${runId}.tmp`);
    copyFileSync(sourcePath, rollbackPath);
    copyFileSync(sourcePath, outputPath);
    rmSync(sourcePath);
    first.close();

    const second = createPersistMaintenanceCoordinator({
      expectedWorkerIds: ["0"],
      config,
    });
    expect(quickCheck(sourcePath)).toBe("ok");
    expect(existsSync(rollbackPath)).toBe(false);
    expect(existsSync(outputPath)).toBe(false);
    second.close();
    await rm(root, { recursive: true, force: true });
  });

  it("clears only owners whose PID start token is stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "persist-maintenance-recovery-"));
    const sourcePath = join(root, "source.db");
    const catalogPath = join(root, "catalog", "catalog.sqlite");
    createBloatedDatabase(sourcePath, 8);
    const config = maintenanceTestConfig({ root, catalogPath, dryRun: true });
    const first = createPersistMaintenanceCoordinator({
      expectedWorkerIds: ["0"],
      config,
    });
    first.catalog.beginOpen({
      logicalPath: "hub/source",
      physicalPath: sourcePath,
      scopeType: "hub",
      ownerId: "dead-owner",
      workerId: "0",
      pid: 2_000_000_000,
      processStartToken: "old-process",
    });
    expect(first.catalog.getDatabase(sourcePath)?.open_owners).toBe(1);
    first.close();

    const second = createPersistMaintenanceCoordinator({
      expectedWorkerIds: ["0"],
      config,
    });
    expect(second.catalog.getDatabase(sourcePath)?.open_owners).toBe(0);
    second.close();
    await rm(root, { recursive: true, force: true });
  });
});
