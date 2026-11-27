/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { executePodman } from "@cocalc/backend/podman";
import { executeCode } from "@cocalc/backend/execute-code";
import getLogger from "@cocalc/backend/logger";
import { podmanEnv } from "@cocalc/backend/podman/env";
import type { HostStorageAdmissionMetrics } from "@cocalc/conat/hub/api/hosts";
import { mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getStorageAdmissionStatus } from "./storage-admission";

const logger = getLogger("project-host:runtime-health");

const DEFAULT_PROBE_TIMEOUT_SECONDS = 10;
const DIAGNOSTIC_TIMEOUT_SECONDS = 8;
const DIAGNOSTIC_COOLDOWN_MS = 10 * 60_000;
const DIAGNOSTIC_OUTPUT_LIMIT = 12_000;
const ERROR_LIMIT = 1000;
const RUNTIME_FAILURES_BEFORE_DEGRADED = 2;
const DIAGNOSTIC_HISTORY_LIMIT = 8;

export type ProjectHostRuntimeHealthStatus = "starting" | "ready" | "degraded";
export type ProjectHostSyntheticProbeFailureKind = "port_bind_collision";
export type ProjectHostRuntimeFailureKind =
  | "container_runtime"
  | "storage_pressure";

export interface ProjectHostRuntimeHealthSnapshot {
  synthetic_probe_supported: true;
  status: ProjectHostRuntimeHealthStatus;
  ready: boolean;
  checked_at?: string;
  podman_latency_ms?: number;
  consecutive_failures: number;
  failure_kind?: ProjectHostRuntimeFailureKind;
  error?: string;
  diagnostics_requested_at?: string;
  diagnostics_completed_at?: string;
  diagnostics_error?: string;
  diagnostics_path?: string;
  synthetic_probe?: {
    status: "running" | "passed" | "failed";
    checked_at: string;
    latency_ms?: number;
    consecutive_failures: number;
    failure_kind?: ProjectHostSyntheticProbeFailureKind;
    error?: string;
  };
}

export type ProjectHostRuntimeProbe = () => Promise<void>;
export type ProjectHostRuntimeDiagnostics = () => Promise<
  { path?: string } | undefined | void
>;

function probeTimeoutSeconds(): number {
  const value = Number(
    process.env.COCALC_PROJECT_HOST_RUNTIME_PROBE_TIMEOUT_SECONDS ??
      DEFAULT_PROBE_TIMEOUT_SECONDS,
  );
  return Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : DEFAULT_PROBE_TIMEOUT_SECONDS;
}

function errorText(err: unknown): string {
  const text = `${err}`.trim() || "unknown Podman runtime error";
  if (text.length <= ERROR_LIMIT) return text;
  const marker = "\n...[error middle omitted]...\n";
  const retained = ERROR_LIMIT - marker.length;
  const headLength = Math.ceil(retained / 2);
  return `${text.slice(0, headLength)}${marker}${text.slice(
    -(retained - headLength),
  )}`;
}

function classifySyntheticProbeFailure(
  err: unknown,
): ProjectHostSyntheticProbeFailureKind | undefined {
  const text = `${err ?? ""}`.toLowerCase();
  if (
    text.includes("address already in use") ||
    text.includes("failed to bind port") ||
    text.includes("port is already allocated") ||
    text.includes("exhausted project port leases")
  ) {
    return "port_bind_collision";
  }
  return undefined;
}

function classifyRuntimeProbeFailure(
  err: unknown,
  storage: HostStorageAdmissionMetrics | undefined,
): ProjectHostRuntimeFailureKind {
  const text = `${err ?? ""}`.toLowerCase();
  const timedOut =
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("killed command") ||
    text.includes("aborted");
  if (timedOut && storage?.pressure_state === "emergency") {
    return "storage_pressure";
  }
  return "container_runtime";
}

export async function probeProjectHostPodmanRuntime(): Promise<void> {
  const { exit_code, stderr, stdout } = await executePodman(
    ["ps", "-a", "--format", "json"],
    {
      timeout: probeTimeoutSeconds(),
      err_on_exit: false,
    },
  );
  if (exit_code !== 0) {
    throw new Error(
      `podman ps failed (exit ${exit_code}): ${`${stderr || stdout || ""}`.trim()}`,
    );
  }
}

function diagnosticOutput(value: unknown): string {
  return `${value ?? ""}`.trim().slice(0, DIAGNOSTIC_OUTPUT_LIMIT);
}

export async function captureProjectHostRuntimeDiagnostics(): Promise<
  { path?: string } | undefined
> {
  const uid =
    typeof process.getuid === "function" ? `${process.getuid()}` : "unknown";
  let runtimeEnv: NodeJS.ProcessEnv;
  try {
    runtimeEnv = podmanEnv();
  } catch (err) {
    runtimeEnv = { ...process.env };
    logger.error("unable to construct Podman environment for diagnostics", {
      err: errorText(err),
    });
  }
  const commands = [
    {
      name: "podman-info",
      command: "podman",
      args: ["--log-level=debug", "info"],
      env: runtimeEnv,
    },
    {
      name: "podman-ps",
      command: "podman",
      args: ["--log-level=debug", "ps", "-a", "--no-trunc"],
      env: runtimeEnv,
    },
    {
      name: "process-wait-state",
      command: "ps",
      args: ["-eo", "pid,ppid,uid,stat,wchan:32,comm,args"],
    },
    {
      name: "user-systemd",
      command: "systemctl",
      args: ["--user", "--no-pager", "--full", "status"],
    },
    {
      name: "login-session",
      command: "loginctl",
      args: ["user-status", uid, "--no-pager"],
    },
    {
      name: "cgroup-state",
      command: "bash",
      args: [
        "-lc",
        "printf '%s\\n' '--- self cgroup ---'; cat /proc/self/cgroup; printf '%s\\n' '--- project pool ---'; find /sys/fs/cgroup/cocalc-project-pool -maxdepth 2 -type f \\( -name cgroup.events -o -name cgroup.procs -o -name memory.events \\) -print -exec cat {} \\; 2>/dev/null | head -2000",
      ],
    },
  ];
  const results = await Promise.all(
    commands.map(async ({ name, ...opts }) => {
      try {
        // podman goes through its wrapper (the launch rules)
        const result =
          opts.command === "podman"
            ? await executePodman(opts.args, {
                env: opts.env,
                timeout: DIAGNOSTIC_TIMEOUT_SECONDS,
                err_on_exit: false,
              })
            : await executeCode({
                ...opts,
                timeout: DIAGNOSTIC_TIMEOUT_SECONDS,
                err_on_exit: false,
              });
        return {
          name,
          exit_code: result.exit_code,
          stdout: diagnosticOutput(result.stdout),
          stderr: diagnosticOutput(result.stderr),
        };
      } catch (err) {
        return { name, error: errorText(err) };
      }
    }),
  );
  const payload = {
    captured_at: new Date().toISOString(),
    pid: process.pid,
    storage_admission: getStorageAdmissionStatus(),
    results,
  };
  const diagnosticDir =
    process.env.COCALC_PROJECT_HOST_RUNTIME_DIAGNOSTIC_DIR?.trim() ||
    "/mnt/cocalc/data/runtime-forensics/project-host";
  let path: string | undefined;
  try {
    await mkdir(diagnosticDir, { recursive: true, mode: 0o700 });
    const stamp = payload.captured_at.replace(/[:.]/g, "-");
    path = join(diagnosticDir, `${stamp}.json`);
    const content = `${JSON.stringify(payload, null, 2)}\n`;
    const tmp = join(
      diagnosticDir,
      `.runtime-diagnostics-${process.pid}-${Date.now()}.tmp`,
    );
    await writeFile(tmp, content, { mode: 0o600 });
    await rename(tmp, path);
    const latestTmp = join(
      diagnosticDir,
      `.latest-${process.pid}-${Date.now()}.tmp`,
    );
    await writeFile(latestTmp, content, { mode: 0o600 });
    await rename(latestTmp, join(diagnosticDir, "latest.json"));
    const history = (await readdir(diagnosticDir))
      .filter((name) => name.endsWith(".json") && name !== "latest.json")
      .sort()
      .reverse();
    await Promise.all(
      history
        .slice(DIAGNOSTIC_HISTORY_LIMIT)
        .map(async (name) => await unlink(join(diagnosticDir, name))),
    );
  } catch (err) {
    logger.error("unable to persist project-host runtime forensic snapshot", {
      diagnostic_dir: diagnosticDir,
      err: errorText(err),
    });
  }
  logger.error("project-host runtime forensic snapshot", { ...payload, path });
  return path ? { path } : undefined;
}

export function createProjectHostRuntimeHealthMonitor({
  isApplicationReady,
  probe = probeProjectHostPodmanRuntime,
  captureDiagnostics = captureProjectHostRuntimeDiagnostics,
  getStorageStatus = getStorageAdmissionStatus,
}: {
  isApplicationReady: () => boolean;
  probe?: ProjectHostRuntimeProbe;
  captureDiagnostics?: ProjectHostRuntimeDiagnostics;
  getStorageStatus?: () => HostStorageAdmissionMetrics | undefined;
}) {
  let snapshot: ProjectHostRuntimeHealthSnapshot = {
    synthetic_probe_supported: true,
    status: "starting",
    ready: false,
    consecutive_failures: 0,
  };
  let inflight: Promise<ProjectHostRuntimeHealthSnapshot> | undefined;
  let runtimeDiagnosticCount = 0;
  let diagnosticsInflight = false;
  let lastDiagnosticsAt = 0;
  let hasSuccessfulProbe = false;

  const requestDiagnostics = () => {
    if (
      diagnosticsInflight ||
      Date.now() - lastDiagnosticsAt < DIAGNOSTIC_COOLDOWN_MS
    ) {
      return;
    }
    diagnosticsInflight = true;
    lastDiagnosticsAt = Date.now();
    snapshot = {
      ...snapshot,
      diagnostics_requested_at: new Date().toISOString(),
      diagnostics_completed_at: undefined,
      diagnostics_error: undefined,
    };
    void captureDiagnostics()
      .then((result) => {
        const diagnosticsPath =
          result && typeof result === "object" ? result.path : undefined;
        snapshot = {
          ...snapshot,
          diagnostics_completed_at: new Date().toISOString(),
          diagnostics_error: undefined,
          diagnostics_path: diagnosticsPath,
        };
      })
      .catch((diagnosticErr) => {
        const diagnosticsError = errorText(diagnosticErr);
        snapshot = {
          ...snapshot,
          diagnostics_completed_at: new Date().toISOString(),
          diagnostics_error: diagnosticsError,
        };
        logger.error("unable to capture project-host runtime diagnostics", {
          err: diagnosticsError,
        });
      })
      .finally(() => {
        diagnosticsInflight = false;
      });
  };

  const refresh = async (): Promise<ProjectHostRuntimeHealthSnapshot> => {
    if (!isApplicationReady()) {
      snapshot = {
        ...snapshot,
        status: "starting",
        ready: false,
      };
      return snapshot;
    }
    if (runtimeDiagnosticCount > 0) {
      return snapshot;
    }
    if (inflight) {
      return await inflight;
    }
    inflight = (async () => {
      const started = Date.now();
      try {
        await probe();
        hasSuccessfulProbe = true;
        snapshot = {
          ...snapshot,
          status: "ready",
          ready: true,
          checked_at: new Date().toISOString(),
          podman_latency_ms: Date.now() - started,
          consecutive_failures: 0,
          failure_kind: undefined,
          error: undefined,
        };
      } catch (err) {
        const consecutiveFailures = snapshot.consecutive_failures + 1;
        const tolerateTransientFailure =
          hasSuccessfulProbe &&
          consecutiveFailures < RUNTIME_FAILURES_BEFORE_DEGRADED;
        const shouldCaptureDiagnostics =
          consecutiveFailures >= RUNTIME_FAILURES_BEFORE_DEGRADED &&
          !diagnosticsInflight &&
          Date.now() - lastDiagnosticsAt >= DIAGNOSTIC_COOLDOWN_MS;
        snapshot = {
          ...snapshot,
          status: tolerateTransientFailure ? "ready" : "degraded",
          ready: tolerateTransientFailure,
          checked_at: new Date().toISOString(),
          podman_latency_ms: Date.now() - started,
          consecutive_failures: consecutiveFailures,
          failure_kind: classifyRuntimeProbeFailure(err, getStorageStatus()),
          error: errorText(err),
        };
        logger.warn("project-host Podman runtime probe failed", snapshot);
        if (shouldCaptureDiagnostics) {
          requestDiagnostics();
        }
      }
      return snapshot;
    })();
    try {
      return await inflight;
    } finally {
      inflight = undefined;
    }
  };

  const assertReady = async (): Promise<void> => {
    const current = await refresh();
    if (!current.ready) {
      throw new Error(
        `project host runtime is ${current.status}: ${current.error ?? "Podman is not ready"}`,
      );
    }
  };

  const runRuntimeDiagnostic = async <T>(fn: () => Promise<T>): Promise<T> => {
    runtimeDiagnosticCount += 1;
    try {
      if (inflight) {
        await inflight;
      }
      return await fn();
    } finally {
      runtimeDiagnosticCount -= 1;
    }
  };

  const recordSyntheticProbe = ({
    startedAt,
    error,
  }: {
    startedAt: number;
    error?: unknown;
  }): ProjectHostRuntimeHealthSnapshot => {
    const failed = error != null;
    const consecutiveFailures = failed
      ? (snapshot.synthetic_probe?.consecutive_failures ?? 0) + 1
      : 0;
    const syntheticError = failed ? errorText(error) : undefined;
    const failureKind = failed
      ? classifySyntheticProbeFailure(error)
      : undefined;
    snapshot = {
      ...snapshot,
      synthetic_probe: {
        status: failed ? "failed" : "passed",
        checked_at: new Date().toISOString(),
        latency_ms: Math.max(0, Date.now() - startedAt),
        consecutive_failures: consecutiveFailures,
        failure_kind: failureKind,
        error: syntheticError,
      },
    };
    if (failed) {
      logger.warn("project-host synthetic runtime probe failed", snapshot);
      requestDiagnostics();
    }
    return { ...snapshot };
  };

  return {
    refresh,
    assertReady,
    runRuntimeDiagnostic,
    recordSyntheticProbe,
    getSnapshot: () => ({ ...snapshot }),
  };
}

export const _test = {
  classifyRuntimeProbeFailure,
  classifySyntheticProbeFailure,
  errorText,
};
