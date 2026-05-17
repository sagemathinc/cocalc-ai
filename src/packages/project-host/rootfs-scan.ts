/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { gzipSync } from "node:zlib";

import {
  parseTrivyRootfsJsonReport,
  type TrivyJsonReport,
  type TrivyRootfsScanTarget,
} from "@cocalc/util/rootfs-scan";
import type { RootfsScanSummary } from "@cocalc/util/rootfs-images";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_REPORT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MEMORY_LIMIT = "4g";
const DEFAULT_CPU_LIMIT = "2";
const DEFAULT_TMPFS_SIZE = "512m";

export type RootfsTrivyPodmanOptions = {
  scan_run_id: string;
  rootfs_path: string;
  output_dir: string;
  trivy_cache_dir: string;
  scanner_image: string;
  memory_limit?: string;
  cpu_limit?: string;
  tmpfs_size?: string;
  podman_binary?: string;
};

export type RunRootfsTrivyScanOptions = {
  scan_run_id: string;
  target: TrivyRootfsScanTarget;
  rootfs_path: string;
  trivy_cache_dir: string;
  scanner_image: string;
  timeout_ms?: number;
  max_target_bytes?: number;
  max_report_bytes?: number;
  memory_limit?: string;
  cpu_limit?: string;
  tmpfs_size?: string;
  output_parent_dir?: string;
  podman_binary?: string;
  command_runner?: CommandRunner;
  cleanup_output_dir?: boolean;
};

export type RootfsTrivyScanResult = {
  summary: RootfsScanSummary;
  report_json: TrivyJsonReport;
  report: {
    path: string;
    bytes: number;
    compressed_bytes: number;
    sha256: string;
  };
  podman_args: string[];
  duration_ms: number;
};

export type CommandRunner = (
  command: string,
  args: string[],
  opts: { timeout_ms: number },
) => Promise<{ stdout: string; stderr: string }>;

function assertAbsolutePath(name: string, path: string): void {
  if (!isAbsolute(path)) {
    throw new Error(`${name} must be an absolute path`);
  }
}

function hashHex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function defaultCommandRunner(
  command: string,
  args: string[],
  opts: { timeout_ms: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: opts.timeout_ms,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          PODMAN_SYSTEMD_UNIT: "cocalc-rootfs-scan",
        },
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
          return;
        }
        const timedOut =
          (err as any)?.killed === true ||
          `${(err as any)?.code ?? ""}` === "ETIMEDOUT";
        const detail = `${stderr || stdout || ""}`.trim();
        reject(
          new Error(
            timedOut
              ? `podman rootfs scan timed out after ${opts.timeout_ms}ms${detail ? `: ${detail}` : ""}`
              : `podman rootfs scan failed${detail ? `: ${detail}` : ""}`,
          ),
        );
      },
    );
  });
}

export function buildRootfsTrivyPodmanArgs({
  scan_run_id,
  rootfs_path,
  output_dir,
  trivy_cache_dir,
  scanner_image,
  memory_limit = DEFAULT_MEMORY_LIMIT,
  cpu_limit = DEFAULT_CPU_LIMIT,
  tmpfs_size = DEFAULT_TMPFS_SIZE,
}: RootfsTrivyPodmanOptions): string[] {
  assertAbsolutePath("rootfs_path", rootfs_path);
  assertAbsolutePath("output_dir", output_dir);
  assertAbsolutePath("trivy_cache_dir", trivy_cache_dir);
  if (!scanner_image.trim()) {
    throw new Error("scanner_image must be specified");
  }
  return [
    "run",
    "--rm",
    "--name",
    `cocalc-rootfs-scan-${scan_run_id}`,
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=all",
    "--security-opt=no-new-privileges",
    "--pids-limit=512",
    `--memory=${memory_limit}`,
    `--cpus=${cpu_limit}`,
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,nodev,size=${tmpfs_size}`,
    "--mount",
    `type=bind,src=${rootfs_path},dst=/scan/rootfs,readonly=true`,
    "--mount",
    `type=bind,src=${output_dir},dst=/scan/out`,
    "--mount",
    `type=bind,src=${trivy_cache_dir},dst=/trivy-cache,readonly=true`,
    scanner_image,
    "trivy",
    "rootfs",
    "--format",
    "json",
    "--output",
    "/scan/out/report.json",
    "--scanners",
    "vuln",
    "--severity",
    "UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL",
    "--ignore-unfixed=false",
    "--offline-scan",
    "--skip-db-update",
    "--cache-dir",
    "/trivy-cache",
    "/scan/rootfs",
  ];
}

export async function runRootfsTrivyScan({
  scan_run_id,
  target,
  rootfs_path,
  trivy_cache_dir,
  scanner_image,
  timeout_ms = DEFAULT_TIMEOUT_MS,
  max_target_bytes,
  max_report_bytes = DEFAULT_MAX_REPORT_BYTES,
  memory_limit,
  cpu_limit,
  tmpfs_size,
  output_parent_dir = tmpdir(),
  podman_binary = "podman",
  command_runner = defaultCommandRunner,
  cleanup_output_dir = true,
}: RunRootfsTrivyScanOptions): Promise<RootfsTrivyScanResult> {
  if (
    max_target_bytes != null &&
    target.size_bytes != null &&
    target.size_bytes > max_target_bytes
  ) {
    throw new Error(
      `RootFS target ${target.release_id} is ${target.size_bytes} bytes, which exceeds scan limit ${max_target_bytes}`,
    );
  }
  const output_dir = await mkdtemp(join(output_parent_dir, "rootfs-scan-"));
  const reportPath = join(output_dir, "report.json");
  const startedAt = Date.now();
  const podman_args = buildRootfsTrivyPodmanArgs({
    scan_run_id,
    rootfs_path,
    output_dir,
    trivy_cache_dir,
    scanner_image,
    memory_limit,
    cpu_limit,
    tmpfs_size,
  });
  try {
    await command_runner(podman_binary, podman_args, { timeout_ms });
    const reportStat = await stat(reportPath);
    if (reportStat.size > max_report_bytes) {
      throw new Error(
        `Trivy report is ${reportStat.size} bytes, which exceeds scan report limit ${max_report_bytes}`,
      );
    }
    const raw = await readFile(reportPath);
    const compressed = gzipSync(raw);
    const report_json = JSON.parse(raw.toString("utf8")) as TrivyJsonReport;
    const duration_ms = Date.now() - startedAt;
    const summary = parseTrivyRootfsJsonReport({
      report: report_json,
      target,
      metadata: {
        started_at: new Date(startedAt).toISOString(),
        scanned_at: new Date().toISOString(),
        duration_ms,
        report: {
          format: "trivy-json",
          sha256: hashHex(raw),
          bytes: raw.length,
          compressed_bytes: compressed.length,
        },
      },
    });
    return {
      summary,
      report_json,
      report: {
        path: reportPath,
        bytes: raw.length,
        compressed_bytes: compressed.length,
        sha256: hashHex(raw),
      },
      podman_args,
      duration_ms,
    };
  } finally {
    if (cleanup_output_dir) {
      await rm(output_dir, { recursive: true, force: true });
    }
  }
}
