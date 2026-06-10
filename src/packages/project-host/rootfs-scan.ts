/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { gzipSync } from "node:zlib";

import getLogger from "@cocalc/backend/logger";
import { podmanEnv } from "@cocalc/backend/podman/env";
import {
  DEFAULT_TRIVY_CACHE_DIR,
  DEFAULT_TRIVY_SCANNER_IMAGE,
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
const DEFAULT_SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const TRIVY_DB_METADATA_RELATIVE_PATH = "db/metadata.json";
const logger = getLogger("project-host:rootfs-scan");

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

export type RootfsTrivyScannerSetupOptions = {
  trivy_cache_dir: string;
  scanner_image: string;
  memory_limit?: string;
  cpu_limit?: string;
  tmpfs_size?: string;
  timeout_ms?: number;
  podman_binary?: string;
  command_runner?: CommandRunner;
  refresh_image?: boolean;
  refresh_db?: boolean;
};

export type RootfsTrivyScannerProvisioningStatus = {
  enabled: boolean;
  scanner_image: string;
  trivy_cache_dir: string;
  cache_metadata_path: string;
  cache_present: boolean;
  prepared: boolean;
  last_prepare_reason?: string;
  last_prepare_started_at?: string;
  last_prepare_finished_at?: string;
  last_prepare_error?: string;
};

type RootfsTrivyScannerProvisioningState = {
  last_prepare_reason?: string;
  last_prepare_started_at?: string;
  last_prepare_finished_at?: string;
  last_prepare_error?: string;
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
  opts: { timeout_ms: number; error_context?: string },
) => Promise<{ stdout: string; stderr: string }>;

const provisioningState: RootfsTrivyScannerProvisioningState = {};

function assertAbsolutePath(name: string, path: string): void {
  if (!isAbsolute(path)) {
    throw new Error(`${name} must be an absolute path`);
  }
}

function hashHex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function scannerSetupKey({
  scanner_image,
  trivy_cache_dir,
}: {
  scanner_image: string;
  trivy_cache_dir: string;
}): string {
  return `${scanner_image}\n${trivy_cache_dir}`;
}

function scannerContainerName({
  prefix,
  scanner_image,
  trivy_cache_dir,
}: {
  prefix: string;
  scanner_image: string;
  trivy_cache_dir: string;
}): string {
  return `${prefix}-${hashHex(Buffer.from(scannerSetupKey({ scanner_image, trivy_cache_dir }))).slice(0, 24)}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function defaultCommandRunner(
  command: string,
  args: string[],
  opts: { timeout_ms: number; error_context?: string },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: opts.timeout_ms,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...podmanEnv(),
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
        const context = opts.error_context ?? "podman rootfs scan";
        reject(
          new Error(
            timedOut
              ? `${context} timed out after ${opts.timeout_ms}ms${detail ? `: ${detail}` : ""}`
              : `${context} failed${detail ? `: ${detail}` : ""}`,
          ),
        );
      },
    );
  });
}

export function buildRootfsTrivyDbSeedPodmanArgs({
  trivy_cache_dir,
  scanner_image,
  memory_limit = DEFAULT_MEMORY_LIMIT,
  cpu_limit = DEFAULT_CPU_LIMIT,
  tmpfs_size = DEFAULT_TMPFS_SIZE,
}: Omit<
  RootfsTrivyScannerSetupOptions,
  "timeout_ms" | "podman_binary" | "command_runner"
>): string[] {
  assertAbsolutePath("trivy_cache_dir", trivy_cache_dir);
  if (!scanner_image.trim()) {
    throw new Error("scanner_image must be specified");
  }
  return [
    "run",
    "--rm",
    "--name",
    scannerContainerName({
      prefix: "cocalc-rootfs-trivy-db",
      scanner_image,
      trivy_cache_dir,
    }),
    "--pull=never",
    "--network=host",
    "--read-only",
    "--cap-drop=all",
    "--security-opt=no-new-privileges",
    "--pids-limit=512",
    `--memory=${memory_limit}`,
    `--cpus=${cpu_limit}`,
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,nodev,size=${tmpfs_size}`,
    "--mount",
    `type=bind,src=${trivy_cache_dir},dst=/trivy-cache`,
    "--entrypoint=trivy",
    scanner_image,
    "image",
    "--download-db-only",
    "--cache-dir",
    "/trivy-cache",
  ];
}

const scannerSetupInFlight = new Map<string, Promise<void>>();

export async function ensureRootfsTrivyScannerPrepared({
  trivy_cache_dir,
  scanner_image,
  memory_limit,
  cpu_limit,
  tmpfs_size,
  timeout_ms = DEFAULT_SETUP_TIMEOUT_MS,
  podman_binary = "podman",
  command_runner = defaultCommandRunner,
  refresh_image = false,
  refresh_db = false,
}: RootfsTrivyScannerSetupOptions): Promise<void> {
  assertAbsolutePath("trivy_cache_dir", trivy_cache_dir);
  if (!scanner_image.trim()) {
    throw new Error("scanner_image must be specified");
  }

  const key = scannerSetupKey({ scanner_image, trivy_cache_dir });
  const existing = scannerSetupInFlight.get(key);
  if (existing) {
    await existing;
    return;
  }

  const task = (async () => {
    await mkdir(trivy_cache_dir, { recursive: true, mode: 0o755 });
    let imagePresent = true;
    try {
      await command_runner(podman_binary, ["image", "exists", scanner_image], {
        timeout_ms,
        error_context: "podman scanner image check",
      });
    } catch {
      imagePresent = false;
    }
    if (!imagePresent || refresh_image) {
      await command_runner(podman_binary, ["pull", scanner_image], {
        timeout_ms,
        error_context: "podman scanner image pull",
      });
    }

    const metadataPath = join(trivy_cache_dir, TRIVY_DB_METADATA_RELATIVE_PATH);
    if (!refresh_db && (await pathExists(metadataPath))) {
      return;
    }

    await command_runner(
      podman_binary,
      buildRootfsTrivyDbSeedPodmanArgs({
        trivy_cache_dir,
        scanner_image,
        memory_limit,
        cpu_limit,
        tmpfs_size,
      }),
      {
        timeout_ms,
        error_context: "podman Trivy database seed",
      },
    );

    if (!(await pathExists(metadataPath))) {
      throw new Error(
        `Trivy database seed completed but ${metadataPath} was not created`,
      );
    }
  })().finally(() => {
    scannerSetupInFlight.delete(key);
  });
  scannerSetupInFlight.set(key, task);
  await task;
}

export function defaultRootfsTrivyScannerConfig(): {
  scanner_image: string;
  trivy_cache_dir: string;
  timeout_ms: number;
} {
  return {
    scanner_image:
      `${process.env.COCALC_ROOTFS_SCAN_TRIVY_IMAGE ?? ""}`.trim() ||
      DEFAULT_TRIVY_SCANNER_IMAGE,
    trivy_cache_dir:
      `${process.env.COCALC_ROOTFS_SCAN_TRIVY_CACHE_DIR ?? ""}`.trim() ||
      DEFAULT_TRIVY_CACHE_DIR,
    timeout_ms: DEFAULT_SETUP_TIMEOUT_MS,
  };
}

export function getRootfsTrivyScannerProvisioningStatus(): RootfsTrivyScannerProvisioningStatus {
  const config = defaultRootfsTrivyScannerConfig();
  const cacheMetadataPath = join(
    config.trivy_cache_dir,
    TRIVY_DB_METADATA_RELATIVE_PATH,
  );
  const cachePresent = existsSync(cacheMetadataPath);
  return {
    enabled: true,
    scanner_image: config.scanner_image,
    trivy_cache_dir: config.trivy_cache_dir,
    cache_metadata_path: cacheMetadataPath,
    cache_present: cachePresent,
    prepared: cachePresent && !provisioningState.last_prepare_error,
    ...provisioningState,
  };
}

export async function prepareDefaultRootfsTrivyScanner({
  reason,
  refresh_image = true,
  refresh_db = true,
}: {
  reason: string;
  refresh_image?: boolean;
  refresh_db?: boolean;
}): Promise<RootfsTrivyScannerProvisioningStatus> {
  const config = defaultRootfsTrivyScannerConfig();
  provisioningState.last_prepare_reason = reason;
  provisioningState.last_prepare_started_at = new Date().toISOString();
  delete provisioningState.last_prepare_finished_at;
  delete provisioningState.last_prepare_error;
  try {
    await ensureRootfsTrivyScannerPrepared({
      ...config,
      refresh_image,
      refresh_db,
    });
    provisioningState.last_prepare_finished_at = new Date().toISOString();
    logger.info("RootFS Trivy scanner prepared", {
      reason,
      scanner_image: config.scanner_image,
      trivy_cache_dir: config.trivy_cache_dir,
      refresh_image,
      refresh_db,
    });
  } catch (err) {
    provisioningState.last_prepare_error = `${err}`;
    provisioningState.last_prepare_finished_at = new Date().toISOString();
    logger.warn("RootFS Trivy scanner preparation failed", {
      reason,
      scanner_image: config.scanner_image,
      trivy_cache_dir: config.trivy_cache_dir,
      err,
    });
    throw err;
  }
  return getRootfsTrivyScannerProvisioningStatus();
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
    "--entrypoint=trivy",
    scanner_image,
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
      `RootFS target ${target.release_id ?? target.project_id ?? target.runtime_image} is ${target.size_bytes} bytes, which exceeds scan limit ${max_target_bytes}`,
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
    await command_runner(podman_binary, podman_args, {
      timeout_ms,
      error_context: "podman rootfs scan",
    });
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
