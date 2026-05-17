/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRootfsTrivyDbSeedPodmanArgs,
  buildRootfsTrivyPodmanArgs,
  ensureRootfsTrivyScannerPrepared,
  runRootfsTrivyScan,
  type CommandRunner,
} from "./rootfs-scan";

const target = {
  release_id: "rel-1",
  content_key: "content-1",
  runtime_image: "cocalc.local/rootfs/content-1",
  size_bytes: 1024,
};

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

describe("buildRootfsTrivyDbSeedPodmanArgs", () => {
  it("builds a constrained podman command that can update the Trivy DB cache", () => {
    const args = buildRootfsTrivyDbSeedPodmanArgs({
      trivy_cache_dir: "/cache/trivy",
      scanner_image: "registry.example/trivy@sha256:abc",
    });

    expect(args).toContain("--pull=never");
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop=all");
    expect(args).toContain("--entrypoint=trivy");
    expect(args).toContain("registry.example/trivy@sha256:abc");
    expect(args).toContain("image");
    expect(args).toContain("--download-db-only");
    expect(args.join("\n")).toContain(
      "type=bind,src=/cache/trivy,dst=/trivy-cache",
    );
  });
});

describe("ensureRootfsTrivyScannerPrepared", () => {
  it("pulls a missing scanner image and seeds the Trivy cache", async () => {
    const base = await mkdtemp(join(tmpdir(), "rootfs-scan-setup-test-"));
    const cache = join(base, "trivy-cache");
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "image" && args[1] === "exists") {
        throw new Error("image missing");
      }
      if (args.includes("--download-db-only")) {
        await mkdir(join(cache, "db"), { recursive: true });
        await writeFile(join(cache, "db", "metadata.json"), "{}");
      }
      return { stdout: "", stderr: "" };
    };

    await ensureRootfsTrivyScannerPrepared({
      trivy_cache_dir: cache,
      scanner_image: "scanner",
      command_runner: runner,
    });

    expect(calls.map(({ args }) => args.slice(0, 2))).toEqual([
      ["image", "exists"],
      ["pull", "scanner"],
      ["run", "--rm"],
    ]);
  });

  it("skips database seeding when the cache is already present", async () => {
    const base = await mkdtemp(join(tmpdir(), "rootfs-scan-setup-test-"));
    const cache = join(base, "trivy-cache");
    await mkdir(join(cache, "db"), { recursive: true });
    await writeFile(join(cache, "db", "metadata.json"), "{}");
    const calls: string[][] = [];
    const runner: CommandRunner = async (_command, args) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    };

    await ensureRootfsTrivyScannerPrepared({
      trivy_cache_dir: cache,
      scanner_image: "scanner",
      command_runner: runner,
    });

    expect(calls.map((args) => args.slice(0, 2))).toEqual([
      ["image", "exists"],
    ]);
  });
});

describe("runRootfsTrivyScan", () => {
  it("runs podman and parses the report from the output mount", async () => {
    const base = await mkdtemp(join(tmpdir(), "rootfs-scan-test-"));
    const rootfs = join(base, "rootfs");
    const cache = join(base, "trivy-cache");
    await mkdir(rootfs);
    await mkdir(cache);

    const runner: CommandRunner = async (_command, args) => {
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
      return { stdout: "", stderr: "" };
    };

    const result = await runRootfsTrivyScan({
      scan_run_id: "scan-1",
      target,
      rootfs_path: rootfs,
      trivy_cache_dir: cache,
      scanner_image: "scanner",
      output_parent_dir: base,
      command_runner: runner,
      cleanup_output_dir: false,
    });

    expect(result.summary.status).toBe("findings");
    expect(result.summary.severity_counts?.critical).toBe(1);
    expect(result.report.bytes).toBeGreaterThan(0);
    expect(result.report.compressed_bytes).toBeGreaterThan(0);
    expect(result.report.sha256).toHaveLength(64);
  });

  it("refuses targets over the configured size limit before running podman", async () => {
    const runner = jest.fn();

    await expect(
      runRootfsTrivyScan({
        scan_run_id: "scan-1",
        target: { ...target, size_bytes: 10_000 },
        rootfs_path: "/rootfs",
        trivy_cache_dir: "/trivy-cache",
        scanner_image: "scanner",
        max_target_bytes: 100,
        command_runner: runner,
      }),
    ).rejects.toThrow("exceeds scan limit");
    expect(runner).not.toHaveBeenCalled();
  });
});
