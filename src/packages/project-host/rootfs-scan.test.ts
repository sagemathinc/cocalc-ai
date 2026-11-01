/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ROOTFS_SCAN_BACKGROUND_PREPARE_ENV,
  buildRootfsTrivyPodmanArgs,
  ensureRootfsTrivyScannerPrepared,
  getRootfsTrivyScannerProvisioningStatus,
  rootfsScannerBackgroundPrepareEnabled,
  startRootfsScannerBackgroundPreparation,
  runRootfsTrivyScan,
  verifyScannerImage,
  type CommandRunner,
} from "./rootfs-scan";

const target = {
  release_id: "rel-1",
  content_key: "content-1",
  runtime_image: "cocalc.local/rootfs/content-1",
  size_bytes: 1024,
};

const tempDirs: string[] = [];

async function mkTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function mountDestination(args: string[], destination: string): string {
  const prefix = `dst=${destination}`;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--mount") continue;
    const spec = args[i + 1] ?? "";
    if (!spec.includes(prefix)) continue;
    const src = spec
      .split(",")
      .find((part) => part.startsWith("src="))
      ?.slice("src=".length);
    if (!src) break;
    return src;
  }
  throw new Error(`mount ${destination} not found`);
}

describe("buildRootfsTrivyPodmanArgs", () => {
  it("builds a locked-down no-network podman command", () => {
    const args = buildRootfsTrivyPodmanArgs({
      scan_run_id: "scan-1",
      rootfs_path: "/cache/rootfs",
      output_dir: "/tmp/out",
      trivy_cache_dir: "/cache/trivy",
      scanner_image: "registry.example/trivy@sha256:abc",
    });

    expect(args).toContain("--network=none");
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop=all");
    expect(args).toContain("--security-opt=no-new-privileges");
    expect(args).toContain("--pull=never");
    expect(args).toContain("--entrypoint=trivy");
    expect(args).toContain("--skip-db-update");
    expect(args).toContain("--offline-scan");
    expect(args).toContain("registry.example/trivy@sha256:abc");
    expect(args).toContain("/scan/rootfs");
    expect(args.join("\n")).toContain(
      "type=bind,src=/cache/rootfs,dst=/scan/rootfs,readonly=true",
    );
    expect(args.join("\n")).toContain(
      "type=bind,src=/cache/trivy,dst=/trivy-cache,readonly=true",
    );
  });

  it("requires absolute mount paths", () => {
    expect(() =>
      buildRootfsTrivyPodmanArgs({
        scan_run_id: "scan-1",
        rootfs_path: "relative",
        output_dir: "/tmp/out",
        trivy_cache_dir: "/cache/trivy",
        scanner_image: "scanner",
      }),
    ).toThrow("rootfs_path must be an absolute path");
  });
});

const DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;
const IMAGE_ID = "c".repeat(64);
const PINNED = `docker.io/aquasec/trivy:0.76.1@${DIGEST}`;

// The database as the host fetcher leaves it: metadata plus valid provenance.
async function writeFetchedDb(
  cache: string,
  fetched_at = new Date().toISOString(),
): Promise<void> {
  await mkdir(join(cache, "db"), { recursive: true });
  await writeFile(join(cache, "db", "metadata.json"), "{}");
  await writeFile(
    join(cache, "db", "cocalc-db-source.json"),
    JSON.stringify({
      source: "mirror.gcr.io/aquasec/trivy-db:2",
      manifest_digest: OTHER_DIGEST,
      layer_digest: DIGEST,
      fetched_at,
      integrity: "test",
    }),
  );
}

// podman as the scanner setup and scans see it: the pinned image is present
// with these repo digests.
function podmanStub({
  present = true,
  repoDigests = [`docker.io/aquasec/trivy@${DIGEST}`],
  onRun,
}: {
  present?: boolean;
  repoDigests?: string[];
  onRun?: (args: string[]) => Promise<void>;
} = {}) {
  const calls: string[][] = [];
  const runner: CommandRunner = async (_command, args) => {
    calls.push(args);
    if (args[0] === "image" && args[1] === "exists" && !present) {
      throw new Error("image missing");
    }
    if (args[0] === "image" && args[1] === "inspect") {
      return {
        stdout: JSON.stringify([{ Id: IMAGE_ID, RepoDigests: repoDigests }]),
        stderr: "",
      };
    }
    if (args[0] === "run") await onRun?.(args);
    return { stdout: "", stderr: "" };
  };
  return { calls, runner };
}

describe("verifyScannerImage", () => {
  it("returns the image id when the host's image has the pinned digest", async () => {
    const { runner } = podmanStub();
    await expect(
      verifyScannerImage({ scanner_image: PINNED, command_runner: runner }),
    ).resolves.toEqual({ image: PINNED, digest: DIGEST, image_id: IMAGE_ID });
  });

  it("fails closed when the image's digest differs", async () => {
    const { runner } = podmanStub({
      repoDigests: [`docker.io/aquasec/trivy@${OTHER_DIGEST}`],
    });
    await expect(
      verifyScannerImage({ scanner_image: PINNED, command_runner: runner }),
    ).rejects.toThrow("does not match its pinned digest");
  });

  it("fails closed when the digest belongs to another repository", async () => {
    const { runner } = podmanStub({
      repoDigests: [`docker.io/evil/trivy@${DIGEST}`],
    });
    await expect(
      verifyScannerImage({ scanner_image: PINNED, command_runner: runner }),
    ).rejects.toThrow("does not match its pinned digest");
  });

  it("refuses a tag-only image without running podman", async () => {
    const { runner, calls } = podmanStub();
    await expect(
      verifyScannerImage({
        scanner_image: "docker.io/aquasec/trivy:latest",
        command_runner: runner,
      }),
    ).rejects.toThrow("not pinned by digest");
    expect(calls).toEqual([]);
  });
});

describe("ensureRootfsTrivyScannerPrepared", () => {
  it("pulls a missing pinned image, verifies it and fetches the database on the host", async () => {
    const base = await mkTempDir("rootfs-scan-setup-test-");
    const cache = join(base, "trivy-cache");
    const { runner, calls } = podmanStub({ present: false });
    const fetch_db = jest.fn(async ({ trivy_cache_dir }) => {
      await writeFetchedDb(trivy_cache_dir);
    });

    await ensureRootfsTrivyScannerPrepared({
      trivy_cache_dir: cache,
      scanner_image: PINNED,
      command_runner: runner,
      fetch_db,
    });

    expect(calls.map((args) => args.slice(0, 2))).toEqual([
      ["image", "exists"],
      ["pull", PINNED],
      ["image", "inspect"],
    ]);
    // the scanner image never runs during setup: no container gets a network
    expect(calls.some((args) => args[0] === "run")).toBe(false);
    expect(fetch_db).toHaveBeenCalledWith({ trivy_cache_dir: cache });
  });

  it("skips the database fetch when a fresh fetched cache is present", async () => {
    const base = await mkTempDir("rootfs-scan-setup-test-");
    const cache = join(base, "trivy-cache");
    await writeFetchedDb(cache);
    const { runner, calls } = podmanStub();
    const fetch_db = jest.fn();

    await ensureRootfsTrivyScannerPrepared({
      trivy_cache_dir: cache,
      scanner_image: PINNED,
      command_runner: runner,
      fetch_db,
    });

    expect(calls.map((args) => args.slice(0, 2))).toEqual([
      ["image", "exists"],
      ["image", "inspect"],
    ]);
    expect(fetch_db).not.toHaveBeenCalled();
  });

  it("refreshes the image and the database when requested", async () => {
    const base = await mkTempDir("rootfs-scan-setup-test-");
    const cache = join(base, "trivy-cache");
    await writeFetchedDb(cache);
    const { runner, calls } = podmanStub();
    const fetch_db = jest.fn(async () => {});

    await ensureRootfsTrivyScannerPrepared({
      trivy_cache_dir: cache,
      scanner_image: PINNED,
      command_runner: runner,
      refresh_image: true,
      refresh_db: true,
      fetch_db,
    });

    expect(calls.map((args) => args.slice(0, 2))).toEqual([
      ["image", "exists"],
      ["pull", PINNED],
      ["image", "inspect"],
    ]);
    expect(fetch_db).toHaveBeenCalledTimes(1);
  });

  it("replaces a legacy cache (metadata without provenance) and a stale one", async () => {
    for (const prepareCache of [
      async (cache: string) => {
        await mkdir(join(cache, "db"), { recursive: true });
        await writeFile(join(cache, "db", "metadata.json"), "{}");
      },
      async (cache: string) => {
        await writeFetchedDb(cache);
        await writeFile(
          join(cache, "db", "cocalc-db-source.json"),
          "{not json",
        );
      },
      async (cache: string) =>
        await writeFetchedDb(
          cache,
          new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        ),
    ]) {
      const base = await mkTempDir("rootfs-scan-setup-test-");
      const cache = join(base, "trivy-cache");
      await prepareCache(cache);
      const { runner } = podmanStub();
      const fetch_db = jest.fn(async ({ trivy_cache_dir }) => {
        await writeFetchedDb(trivy_cache_dir);
      });
      await ensureRootfsTrivyScannerPrepared({
        trivy_cache_dir: cache,
        scanner_image: PINNED,
        command_runner: runner,
        fetch_db,
      });
      expect(fetch_db).toHaveBeenCalledTimes(1);
    }
  });

  it("fails when a fetch leaves no valid provenance", async () => {
    const base = await mkTempDir("rootfs-scan-setup-test-");
    const cache = join(base, "trivy-cache");
    const { runner } = podmanStub();
    await expect(
      ensureRootfsTrivyScannerPrepared({
        trivy_cache_dir: cache,
        scanner_image: PINNED,
        command_runner: runner,
        fetch_db: async ({ trivy_cache_dir }) => {
          await mkdir(join(trivy_cache_dir, "db"), { recursive: true });
          await writeFile(join(trivy_cache_dir, "db", "metadata.json"), "{}");
        },
      }),
    ).rejects.toThrow("provenance is missing");
  });

  it("never fetches into one cache concurrently, even for two images", async () => {
    const base = await mkTempDir("rootfs-scan-setup-test-");
    const cache = join(base, "trivy-cache");
    const other = `registry.example/trivy@${DIGEST}`;
    const { runner } = podmanStub({
      repoDigests: [
        `docker.io/aquasec/trivy@${DIGEST}`,
        `registry.example/trivy@${DIGEST}`,
      ],
    });
    let active = 0;
    let maxActive = 0;
    const fetch_db = jest.fn(async ({ trivy_cache_dir }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await writeFetchedDb(trivy_cache_dir);
      active -= 1;
    });
    await Promise.all(
      [PINNED, other].map((scanner_image) =>
        ensureRootfsTrivyScannerPrepared({
          trivy_cache_dir: cache,
          scanner_image,
          command_runner: runner,
          refresh_db: true,
          fetch_db,
        }),
      ),
    );
    expect(fetch_db).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });

  it("fails closed for a tag-only image before pulling anything", async () => {
    const base = await mkTempDir("rootfs-scan-setup-test-");
    const { runner, calls } = podmanStub();
    const fetch_db = jest.fn();
    await expect(
      ensureRootfsTrivyScannerPrepared({
        trivy_cache_dir: join(base, "trivy-cache"),
        scanner_image: "docker.io/aquasec/trivy:latest",
        command_runner: runner,
        fetch_db,
      }),
    ).rejects.toThrow("not pinned by digest");
    expect(calls).toEqual([]);
    expect(fetch_db).not.toHaveBeenCalled();
  });

  it("fails closed when the pulled image doesn't match its digest", async () => {
    const base = await mkTempDir("rootfs-scan-setup-test-");
    const { runner } = podmanStub({
      present: false,
      repoDigests: [`docker.io/aquasec/trivy@${OTHER_DIGEST}`],
    });
    const fetch_db = jest.fn();
    await expect(
      ensureRootfsTrivyScannerPrepared({
        trivy_cache_dir: join(base, "trivy-cache"),
        scanner_image: PINNED,
        command_runner: runner,
        fetch_db,
      }),
    ).rejects.toThrow("does not match its pinned digest");
    expect(fetch_db).not.toHaveBeenCalled();
  });
});

describe("runRootfsTrivyScan", () => {
  it("runs the verified image by id and records the scanner and database", async () => {
    const base = await mkTempDir("rootfs-scan-test-");
    const rootfs = join(base, "rootfs");
    const cache = join(base, "trivy-cache");
    await mkdir(rootfs);
    await writeFetchedDb(cache);

    let runArgs: string[] = [];
    const { runner } = podmanStub({
      onRun: async (args) => {
        runArgs = args;
        const output = mountDestination(args, "/scan/out");
        await writeFile(
          join(output, "report.json"),
          JSON.stringify({
            Results: [
              {
                Vulnerabilities: [
                  { VulnerabilityID: "CVE-1", Severity: "CRITICAL" },
                ],
              },
            ],
          }),
        );
      },
    });

    const result = await runRootfsTrivyScan({
      scan_run_id: "scan-1",
      target,
      rootfs_path: rootfs,
      trivy_cache_dir: cache,
      scanner_image: PINNED,
      output_parent_dir: base,
      command_runner: runner,
      cleanup_output_dir: false,
    });

    expect(runArgs).toContain(IMAGE_ID);
    expect(runArgs).toContain("--network=none");
    expect(runArgs).not.toContain(PINNED);
    expect(result.summary.status).toBe("findings");
    expect(result.summary.severity_counts?.critical).toBe(1);
    expect(result.summary.metadata?.scanner).toEqual({
      image: PINNED,
      digest: DIGEST,
      image_id: IMAGE_ID,
    });
    expect(result.summary.metadata?.trivy_db?.manifest_digest).toBe(
      OTHER_DIGEST,
    );
    expect(result.report.bytes).toBeGreaterThan(0);
    expect(result.report.compressed_bytes).toBeGreaterThan(0);
    expect(result.report.sha256).toHaveLength(64);
  });

  it("fails closed without running a scan when the image digest differs", async () => {
    const base = await mkTempDir("rootfs-scan-test-");
    await writeFetchedDb(join(base, "trivy-cache"));
    const { runner, calls } = podmanStub({
      repoDigests: [`docker.io/aquasec/trivy@${OTHER_DIGEST}`],
    });
    await expect(
      runRootfsTrivyScan({
        scan_run_id: "scan-1",
        target,
        rootfs_path: join(base, "rootfs"),
        trivy_cache_dir: join(base, "trivy-cache"),
        scanner_image: PINNED,
        output_parent_dir: base,
        command_runner: runner,
      }),
    ).rejects.toThrow("does not match its pinned digest");
    expect(calls.some((args) => args[0] === "run")).toBe(false);
  });

  it("refuses a tag-only image without running podman", async () => {
    const { runner, calls } = podmanStub();
    await expect(
      runRootfsTrivyScan({
        scan_run_id: "scan-1",
        target,
        rootfs_path: "/rootfs",
        trivy_cache_dir: "/trivy-cache",
        scanner_image: "docker.io/aquasec/trivy:latest",
        command_runner: runner,
      }),
    ).rejects.toThrow("not pinned by digest");
    expect(calls).toEqual([]);
  });

  it("doesn't let a database refresh swap db/ while a scan reads it", async () => {
    const base = await mkTempDir("rootfs-scan-test-");
    const rootfs = join(base, "rootfs");
    const cache = join(base, "trivy-cache");
    await mkdir(rootfs);
    await writeFetchedDb(cache, new Date().toISOString());
    const oldManifest = OTHER_DIGEST;

    let releaseScan!: () => void;
    const scanPaused = new Promise<void>((resolve) => (releaseScan = resolve));
    let scanRunning!: () => void;
    const scanStarted = new Promise<void>((resolve) => (scanRunning = resolve));
    const events: string[] = [];
    const { runner } = podmanStub({
      onRun: async (args) => {
        events.push("scan running");
        scanRunning();
        await scanPaused;
        const output = mountDestination(args, "/scan/out");
        await writeFile(join(output, "report.json"), JSON.stringify({}));
        events.push("scan done");
      },
    });
    const scan = runRootfsTrivyScan({
      scan_run_id: "scan-1",
      target,
      rootfs_path: rootfs,
      trivy_cache_dir: cache,
      scanner_image: PINNED,
      output_parent_dir: base,
      command_runner: runner,
    });
    await scanStarted;

    const newManifest = `sha256:${"d".repeat(64)}`;
    const refresh = ensureRootfsTrivyScannerPrepared({
      trivy_cache_dir: cache,
      scanner_image: PINNED,
      command_runner: podmanStub().runner,
      refresh_db: true,
      fetch_db: async ({ trivy_cache_dir }) => {
        events.push("refresh");
        await writeFetchedDb(trivy_cache_dir);
        await writeFile(
          join(trivy_cache_dir, "db", "cocalc-db-source.json"),
          JSON.stringify({
            source: "mirror.gcr.io/aquasec/trivy-db:2",
            manifest_digest: newManifest,
            layer_digest: DIGEST,
            fetched_at: new Date().toISOString(),
            integrity: "test",
          }),
        );
      },
    });
    // give the refresh every chance to run early
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toEqual(["scan running"]);

    releaseScan();
    const result = await scan;
    await refresh;
    expect(events).toEqual(["scan running", "scan done", "refresh"]);
    expect(result.summary.metadata?.trivy_db?.manifest_digest).toBe(
      oldManifest,
    );
  });

  it("refuses to scan with a database that has no valid provenance", async () => {
    const base = await mkTempDir("rootfs-scan-test-");
    const cache = join(base, "trivy-cache");
    await mkdir(join(cache, "db"), { recursive: true });
    await writeFile(join(cache, "db", "metadata.json"), "{}");
    const { runner, calls } = podmanStub();
    await expect(
      runRootfsTrivyScan({
        scan_run_id: "scan-1",
        target,
        rootfs_path: join(base, "rootfs"),
        trivy_cache_dir: cache,
        scanner_image: PINNED,
        output_parent_dir: base,
        command_runner: runner,
      }),
    ).rejects.toThrow("no valid provenance");
    expect(calls).toEqual([]);
  });

  it("refuses targets over the configured size limit before running podman", async () => {
    const runner = jest.fn();

    await expect(
      runRootfsTrivyScan({
        scan_run_id: "scan-1",
        target: { ...target, size_bytes: 10_000 },
        rootfs_path: "/rootfs",
        trivy_cache_dir: "/trivy-cache",
        scanner_image: PINNED,
        max_target_bytes: 100,
        command_runner: runner,
      }),
    ).rejects.toThrow("exceeds scan limit");
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("background scanner preparation", () => {
  afterEach(() => {
    jest.useRealTimers();
    delete process.env[ROOTFS_SCAN_BACKGROUND_PREPARE_ENV];
  });

  it("is off unless the host explicitly enables it", () => {
    expect(rootfsScannerBackgroundPrepareEnabled({})).toBe(false);
    expect(
      rootfsScannerBackgroundPrepareEnabled({
        [ROOTFS_SCAN_BACKGROUND_PREPARE_ENV]: "true",
      }),
    ).toBe(false);
    expect(
      rootfsScannerBackgroundPrepareEnabled({
        [ROOTFS_SCAN_BACKGROUND_PREPARE_ENV]: "1",
      }),
    ).toBe(true);
  });

  it("prepares nothing at startup or on the interval when off (the default)", async () => {
    jest.useFakeTimers();
    // the real setup, so any call would reach podman (image exists, inspect,
    // pull) or the database fetcher
    const { runner, calls } = podmanStub();
    const fetch_db = jest.fn();
    const prepare = jest.fn(async ({ reason }: { reason: string }) => {
      void reason;
      await ensureRootfsTrivyScannerPrepared({
        trivy_cache_dir: "/nonexistent/trivy-cache",
        scanner_image: PINNED,
        command_runner: runner,
        refresh_image: true,
        refresh_db: true,
        fetch_db,
      });
    });
    const stop = startRootfsScannerBackgroundPreparation({
      intervalMs: 60_000,
      prepare,
    });
    jest.advanceTimersByTime(10 * 60_000);
    await Promise.resolve();
    expect(prepare).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(fetch_db).not.toHaveBeenCalled();
    stop();
  });

  it("prepares at startup and on the interval only when enabled", () => {
    jest.useFakeTimers();
    const prepare = jest.fn(async () => {});
    const stop = startRootfsScannerBackgroundPreparation({
      intervalMs: 60_000,
      enabled: true,
      prepare,
    });
    expect(prepare).toHaveBeenCalledWith({ reason: "startup" });
    jest.advanceTimersByTime(2 * 60_000);
    expect(prepare).toHaveBeenCalledTimes(3);
    stop();
    jest.advanceTimersByTime(5 * 60_000);
    expect(prepare).toHaveBeenCalledTimes(3);
  });

  it("reports background preparation as disabled by default, with the pinned image", () => {
    const status = getRootfsTrivyScannerProvisioningStatus();
    expect(status.enabled).toBe(false);
    expect(status.scanner_image).toMatch(/@sha256:[0-9a-f]{64}$/);
    process.env[ROOTFS_SCAN_BACKGROUND_PREPARE_ENV] = "1";
    expect(getRootfsTrivyScannerProvisioningStatus().enabled).toBe(true);
  });
});
