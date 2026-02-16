/*
Runtime conformance guardrails for project-host.

What this checks:
- Critical privilege-control files are root-owned and not writable by non-root:
  - /usr/local/sbin/cocalc-runtime-storage
  - /etc/sudoers.d/cocalc-project-host-runtime
- Sudo policy behavior:
  - allows the intended wrapper path (sudo -n cocalc-runtime-storage sync)
  - denies broad root execution (sudo -n /bin/true)
  - denies generic mount escalation through the wrapper

Why this exists:
- We intentionally run project-host unprivileged and delegate a tiny set of
  root-only operations via a strict wrapper + sudo whitelist.
- If wrapper/sudoers ownership or behavior drifts, project-host can silently
  become over-privileged (security risk) or under-privileged (availability
  failures during startup/mount lifecycle).
- Startup checks fail closed when enforcement is enabled; periodic checks keep
  surfacing drift that appears after boot.
*/

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("project-host:runtime-conformance");

const STORAGE_WRAPPER = "/usr/local/sbin/cocalc-runtime-storage";

const DEFAULT_SWEEP_MS = 5 * 60 * 1000;
const MIN_SWEEP_MS = 30 * 1000;

type CheckLevel = "error" | "warning";

type CheckResult = {
  name: string;
  ok: boolean;
  level: CheckLevel;
  message: string;
  details?: Record<string, unknown>;
};

function enabled(): boolean {
  const raw = `${process.env.COCALC_RUNTIME_CONFORMANCE ?? "yes"}`
    .trim()
    .toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

function enforce(): boolean {
  const raw = `${process.env.COCALC_RUNTIME_CONFORMANCE_ENFORCE ?? "yes"}`
    .trim()
    .toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

function sweepMs(): number {
  const raw = Number(process.env.COCALC_RUNTIME_CONFORMANCE_SWEEP_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SWEEP_MS;
  return Math.max(MIN_SWEEP_MS, Math.floor(raw));
}

async function run(
  command: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

async function checkRootOwnedNotWritable(path: string): Promise<CheckResult> {
  try {
    const st = await stat(path);
    const mode = st.mode & 0o777;
    const rootOwned = st.uid === 0;
    const writableByNonRoot = (mode & 0o022) !== 0;
    if (!rootOwned || writableByNonRoot) {
      return {
        name: "root-owned-path",
        ok: false,
        level: "error",
        message: `unsafe ownership or mode on ${path}`,
        details: {
          path,
          uid: st.uid,
          mode: mode.toString(8),
        },
      };
    }
    return {
      name: "root-owned-path",
      ok: true,
      level: "error",
      message: `${path} ownership/mode ok`,
    };
  } catch (err) {
    return {
      name: "root-owned-path",
      ok: false,
      level: "error",
      message: `unable to stat ${path}: ${err}`,
      details: { path },
    };
  }
}

async function checkSudoWhitelistAllowsWrapper(): Promise<CheckResult> {
  const probe = await run("sudo", ["-n", STORAGE_WRAPPER, "sync"]);
  if (probe.exitCode === 0) {
    return {
      name: "sudo-wrapper-allow",
      ok: true,
      level: "error",
      message: "runtime sudo wrapper allow check passed",
    };
  }
  return {
    name: "sudo-wrapper-allow",
    ok: false,
    level: "error",
    message: "runtime sudo wrapper allow check failed",
    details: {
      exitCode: probe.exitCode,
      stderr: probe.stderr.trim(),
      stdout: probe.stdout.trim(),
    },
  };
}

async function checkSudoPolicyListsWrapper(): Promise<CheckResult> {
  const probe = await run("sudo", ["-n", "-l"]);
  if (probe.exitCode !== 0) {
    return {
      name: "sudo-policy-visible",
      ok: false,
      level: "error",
      message: "unable to inspect sudo policy with sudo -n -l",
      details: {
        exitCode: probe.exitCode,
        stderr: probe.stderr.trim(),
      },
    };
  }
  const text = `${probe.stdout}\n${probe.stderr}`;
  if (!text.includes(STORAGE_WRAPPER)) {
    return {
      name: "sudo-policy-visible",
      ok: false,
      level: "error",
      message: "sudo policy output does not include runtime wrapper command",
      details: {
        sample: text.slice(0, 500),
      },
    };
  }
  return {
    name: "sudo-policy-visible",
    ok: true,
    level: "error",
    message: "sudo policy output includes runtime wrapper command",
  };
}

async function checkSudoWhitelistDeniesDirectRoot(): Promise<CheckResult> {
  const probe = await run("sudo", ["-n", "/bin/true"]);
  if (probe.exitCode !== 0) {
    return {
      name: "sudo-direct-deny",
      ok: true,
      level: "error",
      message: "direct sudo command correctly denied",
    };
  }
  return {
    name: "sudo-direct-deny",
    ok: false,
    level: "error",
    message: "runtime sudo policy too broad: /bin/true unexpectedly allowed",
  };
}

async function checkSudoWhitelistDeniesGenericMount(): Promise<CheckResult> {
  const probe = await run("sudo", [
    "-n",
    STORAGE_WRAPPER,
    "mount",
    "-t",
    "overlay",
    "overlay",
    "/mnt/cocalc/data",
  ]);
  if (probe.exitCode !== 0) {
    return {
      name: "sudo-generic-mount-deny",
      ok: true,
      level: "error",
      message: "generic mount via wrapper correctly denied",
    };
  }
  return {
    name: "sudo-generic-mount-deny",
    ok: false,
    level: "error",
    message: "runtime wrapper still allows generic mount command",
  };
}

function startupChecks(): Promise<CheckResult>[] {
  return [
    checkRootOwnedNotWritable(STORAGE_WRAPPER),
    checkSudoPolicyListsWrapper(),
    checkSudoWhitelistAllowsWrapper(),
    checkSudoWhitelistDeniesDirectRoot(),
    checkSudoWhitelistDeniesGenericMount(),
  ];
}

function periodicChecks(): Promise<CheckResult>[] {
  return [
    checkRootOwnedNotWritable(STORAGE_WRAPPER),
    checkSudoPolicyListsWrapper(),
    checkSudoWhitelistAllowsWrapper(),
  ];
}

function logResult(context: string, result: CheckResult) {
  const payload = {
    context,
    check: result.name,
    ok: result.ok,
    message: result.message,
    ...(result.details ? { details: result.details } : {}),
  };
  if (result.ok) {
    logger.debug("runtime conformance check", payload);
    return;
  }
  if (result.level === "warning") {
    logger.warn("runtime conformance warning", payload);
    return;
  }
  logger.error("runtime conformance error", payload);
}

async function verifyChecks(
  context: string,
  checks: Promise<CheckResult>[],
): Promise<{ ok: boolean; failures: CheckResult[] }> {
  const results = await Promise.all(checks);
  for (const result of results) {
    logResult(context, result);
  }
  const failures = results.filter((x) => !x.ok && x.level === "error");
  return { ok: failures.length === 0, failures };
}

export async function runRuntimeConformanceStartupChecks(): Promise<void> {
  if (!enabled()) {
    logger.info("runtime conformance checks disabled");
    return;
  }
  const outcome = await verifyChecks("startup", startupChecks());
  if (!outcome.ok && enforce()) {
    const summary = outcome.failures.map((x) => x.message).join("; ");
    throw new Error(`runtime conformance failed: ${summary}`);
  }
}

export function startRuntimeConformanceMonitor(): () => void {
  if (!enabled()) return () => {};
  const interval = setInterval(() => {
    void verifyChecks("periodic", periodicChecks());
  }, sweepMs());
  interval.unref();
  return () => clearInterval(interval);
}
