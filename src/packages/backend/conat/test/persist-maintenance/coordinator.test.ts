import {
  copyFileSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runPersistMaintenanceWorker } from "@cocalc/backend/conat/persist-maintenance/compact-worker";
import { PersistMaintenanceCoordinator } from "@cocalc/backend/conat/persist-maintenance/coordinator";
import type { PersistMaintenanceWorkerResult } from "@cocalc/backend/conat/persist-maintenance/compact-worker";
import {
  createBloatedDatabase,
  maintenanceTestConfig,
  quickCheck,
} from "@cocalc/backend/conat/test/persist-maintenance/helpers";

const os: typeof import("node:os") = jest.requireActual("node:os");

describe("persist maintenance coordinator", () => {
  let root: string;
  let sourcePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "persist-maintenance-coordinator-"));
    sourcePath = join(root, "source.db");
    createBloatedDatabase(sourcePath);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("pauses dry-run scanning under host load and resumes afterward", async () => {
    const coordinator = new PersistMaintenanceCoordinator({
      expectedWorkerIds: ["0"],
      config: {
        ...maintenanceTestConfig({
          root,
          catalogPath: join(root, ".maintenance", "catalog.sqlite"),
          dryRun: true,
        }),
        maxLoadPerCpu: 0.75,
      },
    });
    coordinator.createLocalHooks("0");
    const scan = jest.spyOn(coordinator.scanner, "scanBatch");
    const load = jest.spyOn(os, "loadavg").mockReturnValue([1e6, 1e6, 1e6]);
    await coordinator.tick();
    expect(scan).not.toHaveBeenCalled();
    expect(coordinator.status().pauseReason).toBe("host-load");
    load.mockReturnValue([0, 0, 0]);
    await coordinator.tick();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(coordinator.catalog.getDatabase(sourcePath)?.presence_state).toBe(
      "present",
    );
    coordinator.close();
  });

  it("promotes a validated compact copy and records reclaimed bytes", async () => {
    const before = statSync(sourcePath).size;
    const coordinator = new PersistMaintenanceCoordinator({
      expectedWorkerIds: ["0"],
      config: maintenanceTestConfig({
        root,
        catalogPath: join(root, ".maintenance", "catalog.sqlite"),
      }),
    });
    coordinator.createLocalHooks("0");
    await coordinator.tick();

    expect(statSync(sourcePath).size).toBeLessThan(before);
    expect(quickCheck(sourcePath)).toBe("ok");
    expect(coordinator.status()).toMatchObject({
      trackingCoverage: true,
      successes: 1,
      failures: 0,
    });
    expect(coordinator.status().reclaimedBytes).toBeGreaterThan(0);
    coordinator.close();
  });

  it("discards a completed build if a worker opens the source", async () => {
    let releaseBuild!: () => void;
    let buildStarted!: () => void;
    const started = new Promise<void>((resolve) => (buildStarted = resolve));
    const release = new Promise<void>((resolve) => (releaseBuild = resolve));
    const controlledWorker = async (options: {
      sourcePath: string;
      outputPath?: string;
      timeoutMs: number;
    }): Promise<PersistMaintenanceWorkerResult> => {
      if (options.outputPath) {
        buildStarted();
        await release;
      }
      return await runPersistMaintenanceWorker(options);
    };
    const coordinator = new PersistMaintenanceCoordinator({
      expectedWorkerIds: ["0"],
      config: maintenanceTestConfig({
        root,
        catalogPath: join(root, ".maintenance", "catalog.sqlite"),
      }),
      runWorker: controlledWorker,
    });
    const hooks = coordinator.createLocalHooks("0");
    const before = statSync(sourcePath);
    const tick = coordinator.tick();
    await started;
    const handle = await hooks.beginOpen({
      logicalPath: "hub/source",
      physicalPath: sourcePath,
      scopeType: "hub",
    });
    releaseBuild();
    await tick;

    expect(statSync(sourcePath).ino).toBe(before.ino);
    expect(statSync(sourcePath).size).toBe(before.size);
    expect(coordinator.status()).toMatchObject({
      successes: 0,
      invalidations: 1,
    });
    handle?.onFinalClose(false);
    coordinator.close();
  });

  it("refreshes configured archive and backup from the compact immutable copy", async () => {
    const primaryRoot = join(root, "primary");
    require("node:fs").mkdirSync(primaryRoot);
    const primaryPath = join(primaryRoot, "source.db");
    createBloatedDatabase(primaryPath);
    const archivePath = join(root, "archive", "source.db");
    const backupPath = join(root, "backup", "source.db");
    require("node:fs").mkdirSync(join(root, "archive"));
    require("node:fs").mkdirSync(join(root, "backup"));
    copyFileSync(primaryPath, archivePath);
    copyFileSync(primaryPath, backupPath);
    const coordinator = new PersistMaintenanceCoordinator({
      expectedWorkerIds: ["0"],
      config: maintenanceTestConfig({
        root: primaryRoot,
        catalogPath: join(root, ".maintenance", "catalog.sqlite"),
      }),
    });
    const hooks = coordinator.createLocalHooks("0");
    const handle = await hooks.beginOpen({
      logicalPath: "hub/source",
      physicalPath: primaryPath,
      archivePath,
      backupPath,
      scopeType: "hub",
    });
    handle?.onFinalClose(false);
    await coordinator.tick();

    expect(quickCheck(archivePath)).toBe("ok");
    expect(quickCheck(backupPath)).toBe("ok");
    expect(statSync(archivePath).size).toBe(statSync(primaryPath).size);
    expect(statSync(backupPath).size).toBe(statSync(primaryPath).size);
    coordinator.close();
  });

  it("restores the original inode when post-promotion validation fails", async () => {
    const before = statSync(sourcePath);
    const config = maintenanceTestConfig({
      root,
      catalogPath: join(root, ".maintenance", "catalog.sqlite"),
    });
    config.promotionBarrierMs = -1;
    const coordinator = new PersistMaintenanceCoordinator({
      expectedWorkerIds: ["0"],
      config,
    });
    coordinator.createLocalHooks("0");
    await coordinator.tick();

    expect(statSync(sourcePath).ino).toBe(before.ino);
    expect(statSync(sourcePath).size).toBe(before.size);
    expect(quickCheck(sourcePath)).toBe("ok");
    expect(coordinator.status()).toMatchObject({ successes: 0, failures: 1 });
    coordinator.close();
  });

  it("inspects in dry-run mode but never creates a compact output", async () => {
    let builds = 0;
    const coordinator = new PersistMaintenanceCoordinator({
      expectedWorkerIds: ["0"],
      config: maintenanceTestConfig({
        root,
        catalogPath: join(root, ".maintenance", "catalog.sqlite"),
        dryRun: true,
      }),
      runWorker: async (options) => {
        if (options.outputPath) builds += 1;
        return await runPersistMaintenanceWorker(options);
      },
    });
    coordinator.createLocalHooks("0");
    const before = statSync(sourcePath);
    await coordinator.tick();
    expect(builds).toBe(0);
    expect(statSync(sourcePath).ino).toBe(before.ino);
    expect(coordinator.status().eligibleCandidates).toBe(1);
    coordinator.close();
  });

  it("blocks promotion whenever worker tracking coverage is unhealthy", async () => {
    let builds = 0;
    const coordinator = new PersistMaintenanceCoordinator({
      expectedWorkerIds: ["0"],
      config: maintenanceTestConfig({
        root,
        catalogPath: join(root, ".maintenance", "catalog.sqlite"),
      }),
      runWorker: async (options) => {
        if (options.outputPath) builds += 1;
        return await runPersistMaintenanceWorker(options);
      },
    });
    coordinator.createLocalHooks("0");
    coordinator.trackingUnavailable("0", new Error("test disconnect"));
    await coordinator.tick();
    expect(builds).toBe(0);
    expect(coordinator.status()).toMatchObject({
      trackingCoverage: false,
      pauseReason: "incomplete-worker-tracking",
    });
    coordinator.close();
  });

  it("persists and retries failed secondary refreshes", async () => {
    const blockedParent = join(root, "blocked");
    const archivePath = join(blockedParent, "source.db");
    writeFileSync(blockedParent, "not a directory");
    const coordinator = new PersistMaintenanceCoordinator({
      expectedWorkerIds: ["0"],
      config: maintenanceTestConfig({
        root,
        catalogPath: join(root, ".maintenance", "catalog.sqlite"),
      }),
    });
    const hooks = coordinator.createLocalHooks("0");
    const handle = await hooks.beginOpen({
      logicalPath: "hub/source",
      physicalPath: sourcePath,
      archivePath,
      scopeType: "hub",
    });
    handle?.onFinalClose(false);
    await coordinator.tick();
    expect(coordinator.catalog.getDatabase(sourcePath)?.last_error).toBeNull();
    expect(coordinator.status()).toMatchObject({
      successes: 1,
      failures: 0,
      invalidations: 0,
      pauseReason: undefined,
      eligibleCandidates: 0,
      secondaryRefreshBacklog: 1,
    });

    rmSync(blockedParent);
    mkdirSync(blockedParent);
    coordinator.catalog.setState("scan_completed_at", `${Date.now()}`);
    await coordinator.tick();
    expect(coordinator.status().secondaryRefreshBacklog).toBe(0);
    expect(quickCheck(archivePath)).toBe("ok");
    coordinator.close();
  });
});
