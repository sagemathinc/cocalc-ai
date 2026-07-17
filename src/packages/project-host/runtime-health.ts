/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { executeCode } from "@cocalc/backend/execute-code";
import getLogger from "@cocalc/backend/logger";
import { podmanEnv } from "@cocalc/backend/podman/env";

const logger = getLogger("project-host:runtime-health");

const DEFAULT_PROBE_TIMEOUT_SECONDS = 10;
const DIAGNOSTIC_TIMEOUT_SECONDS = 8;
const DIAGNOSTIC_COOLDOWN_MS = 10 * 60_000;
const DIAGNOSTIC_OUTPUT_LIMIT = 12_000;
const ERROR_LIMIT = 1000;

export type ProjectHostRuntimeHealthStatus = "starting" | "ready" | "degraded";
export type ProjectHostSyntheticProbeFailureKind = "port_bind_collision";

export interface ProjectHostRuntimeHealthSnapshot {
  synthetic_probe_supported: true;
  status: ProjectHostRuntimeHealthStatus;
  ready: boolean;
  checked_at?: string;
  podman_latency_ms?: number;
  consecutive_failures: number;
  error?: string;
  diagnostics_requested_at?: string;
  diagnostics_completed_at?: string;
  diagnostics_error?: string;
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
export type ProjectHostRuntimeDiagnostics = () => Promise<void>;

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

export async function probeProjectHostPodmanRuntime(): Promise<void> {
  const { exit_code, stderr, stdout } = await executeCode({
    command: "podman",
    args: ["ps", "-a", "--format", "json"],
    timeout: probeTimeoutSeconds(),
    env: podmanEnv(),
    err_on_exit: false,
  });
  if (exit_code !== 0) {
    throw new Error(
      `podman ps failed (exit ${exit_code}): ${`${stderr || stdout || ""}`.trim()}`,
    );
  }
}

function diagnosticOutput(value: unknown): string {
  return `${value ?? ""}`.trim().slice(0, DIAGNOSTIC_OUTPUT_LIMIT);
}

export async function captureProjectHostRuntimeDiagnostics(): Promise<void> {
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
        const result = await executeCode({
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
  logger.error("project-host runtime forensic snapshot", {
    captured_at: new Date().toISOString(),
    pid: process.pid,
    results,
  });
}

export function createProjectHostRuntimeHealthMonitor({
  isApplicationReady,
  probe = probeProjectHostPodmanRuntime,
  captureDiagnostics = captureProjectHostRuntimeDiagnostics,
}: {
  isApplicationReady: () => boolean;
  probe?: ProjectHostRuntimeProbe;
  captureDiagnostics?: ProjectHostRuntimeDiagnostics;
}) {
  let snapshot: ProjectHostRuntimeHealthSnapshot = {
    synthetic_probe_supported: true,
    status: "starting",
    ready: false,
    consecutive_failures: 0,
  };
  let inflight: Promise<ProjectHostRuntimeHealthSnapshot> | undefined;
  let diagnosticsInflight = false;
  let lastDiagnosticsAt = 0;

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
      .then(() => {
        snapshot = {
          ...snapshot,
          diagnostics_completed_at: new Date().toISOString(),
          diagnostics_error: undefined,
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
    if (inflight) {
      return await inflight;
    }
    inflight = (async () => {
      const started = Date.now();
      try {
        await probe();
        snapshot = {
          ...snapshot,
          status: "ready",
          ready: true,
          checked_at: new Date().toISOString(),
          podman_latency_ms: Date.now() - started,
          consecutive_failures: 0,
          error: undefined,
        };
      } catch (err) {
        const consecutiveFailures = snapshot.consecutive_failures + 1;
        const shouldCaptureDiagnostics =
          consecutiveFailures >= 2 &&
          !diagnosticsInflight &&
          Date.now() - lastDiagnosticsAt >= DIAGNOSTIC_COOLDOWN_MS;
        snapshot = {
          ...snapshot,
          status: "degraded",
          ready: false,
          checked_at: new Date().toISOString(),
          podman_latency_ms: Date.now() - started,
          consecutive_failures: consecutiveFailures,
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
      status: snapshot.consecutive_failures ? "degraded" : "ready",
      ready: snapshot.consecutive_failures === 0,
      error: snapshot.consecutive_failures ? snapshot.error : undefined,
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
    recordSyntheticProbe,
    getSnapshot: () => ({ ...snapshot }),
  };
}

export const _test = {
  classifySyntheticProbeFailure,
  errorText,
};
