import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import getLogger from "@cocalc/backend/logger";
import { getFileServerRuntimeStatus } from "./file-server";

const logger = getLogger("project-host:runtime-posture");

const DEFAULT_SWEEP_MS = 10 * 60 * 1000;
const MIN_SWEEP_MS = 30 * 1000;
const DEFAULT_APT_STALE_HOURS = 7 * 24;

function enabled(): boolean {
  const raw = `${process.env.COCALC_RUNTIME_POSTURE_MONITOR ?? "yes"}`
    .trim()
    .toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

function sweepMs(): number {
  const raw = Number(process.env.COCALC_RUNTIME_POSTURE_SWEEP_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SWEEP_MS;
  return Math.max(MIN_SWEEP_MS, Math.floor(raw));
}

function aptStaleHours(): number {
  const raw = Number(process.env.COCALC_RUNTIME_APT_STALE_HOURS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_APT_STALE_HOURS;
  return Math.floor(raw);
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

async function checkAptTimer(name: string): Promise<boolean | undefined> {
  try {
    const enabledRes = await run("systemctl", ["is-enabled", name]);
    if (enabledRes.exitCode !== 0) return false;
    const activeRes = await run("systemctl", ["is-active", name]);
    return activeRes.exitCode === 0;
  } catch {
    return undefined;
  }
}

async function checkAptFreshness(): Promise<{
  stale: boolean;
  ageHours?: number;
  path: string;
}> {
  const stampPath = "/var/lib/apt/periodic/update-success-stamp";
  try {
    const st = await stat(stampPath);
    const ageMs = Date.now() - st.mtimeMs;
    const ageHours = ageMs / (1000 * 60 * 60);
    return {
      stale: ageHours > aptStaleHours(),
      ageHours,
      path: stampPath,
    };
  } catch {
    return {
      stale: true,
      path: stampPath,
    };
  }
}

async function postureSweep(context: "startup" | "periodic"): Promise<void> {
  try {
    const aptDaily = await checkAptTimer("apt-daily.timer");
    const aptUpgrade = await checkAptTimer("apt-daily-upgrade.timer");
    const aptFreshness = await checkAptFreshness();

    if (aptDaily === false || aptUpgrade === false) {
      logger.warn("runtime posture: unattended apt timers not fully active", {
        context,
        aptDaily,
        aptUpgrade,
      });
    } else if (aptDaily == null || aptUpgrade == null) {
      logger.warn("runtime posture: unable to verify apt timer status", {
        context,
        aptDaily,
        aptUpgrade,
      });
    }

    if (aptFreshness.stale) {
      logger.warn("runtime posture: apt update freshness is stale", {
        context,
        stampPath: aptFreshness.path,
        ageHours: aptFreshness.ageHours,
        staleThresholdHours: aptStaleHours(),
      });
    }

    try {
      const podman = await run("podman", ["--version"]);
      if (podman.exitCode === 0) {
        logger.debug("runtime posture: podman version", {
          context,
          version: podman.stdout.trim() || podman.stderr.trim(),
        });
      } else {
        logger.warn("runtime posture: unable to read podman version", {
          context,
          exitCode: podman.exitCode,
          stderr: podman.stderr.trim(),
        });
      }
    } catch (err) {
      logger.warn("runtime posture: podman version check failed", {
        context,
        err: `${err}`,
      });
    }

    const fileServerStatus = getFileServerRuntimeStatus();
    const bees = fileServerStatus?.bees;
    if (!fileServerStatus || !bees) {
      logger.debug("runtime posture: file-server not initialized yet", {
        context,
      });
    } else if (!bees.enabled) {
      logger.warn("runtime posture: BEES dedup disabled", {
        context,
        status: bees,
      });
    } else if (!bees.running) {
      logger.warn("runtime posture: BEES dedup not running", {
        context,
        status: bees,
      });
    } else {
      logger.debug("runtime posture: BEES dedup running", {
        context,
        status: bees,
      });
    }
  } catch (err) {
    logger.warn("runtime posture sweep failed", {
      context,
      err: `${err}`,
    });
  }
}

export function startRuntimePostureMonitor(): () => void {
  if (!enabled()) {
    logger.info("runtime posture monitor disabled");
    return () => {};
  }

  void postureSweep("startup");
  const interval = setInterval(() => {
    void postureSweep("periodic");
  }, sweepMs());
  interval.unref();

  logger.info("started runtime posture monitor", {
    sweepMs: sweepMs(),
    aptStaleHours: aptStaleHours(),
  });

  return () => clearInterval(interval);
}
