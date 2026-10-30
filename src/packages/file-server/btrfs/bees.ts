/*
Automate running BEES on the btrfs pool.
*/

import { spawn, type ChildProcess } from "node:child_process";
import getLogger from "@cocalc/backend/logger";
import { sudo, STORAGE_WRAPPER } from "./util";
import { exists } from "@cocalc/backend/misc/async-utils-node";
import { join } from "node:path";
import { availableParallelism } from "node:os";

const logger = getLogger("file-server:btrfs:bees");
export const BEES_ALREADY_RUNNING_EXIT_CODE = 75;
const BEES_STARTING_MARKER = "BEES_STARTING";
const BEES_STARTUP_HANDSHAKE_TIMEOUT_MS = 10_000;

interface Options {
  // Explicit worker ceiling. Resource contention is handled by the dedicated
  // low-weight cgroup rather than BEES's host-wide load-average heuristic.
  workerCount?: number;
  // 0-8: default 1
  verbose?: number;
  // hash table size: default 1G
  size?: string;
  // run just before BEES is spawned (e.g. freeze its cgroup: bees-gate.ts)
  beforeSpawn?: () => Promise<void>;
}

const children: ChildProcess[] = [];

export type BeesStartResult =
  | { status: "started"; child: ChildProcess }
  | { status: "already-running"; detail: string }
  | { status: "disabled" };

function beesDisabledByEnv(): boolean {
  const value = `${process.env.COCALC_DISABLE_BEES ?? ""}`.trim().toLowerCase();
  if (!value) return false;
  return !["0", "false", "no", "off"].includes(value);
}

export default async function bees(
  mountpoint: string,
  {
    workerCount = Math.min(4, availableParallelism()),
    verbose = 1,
    size = "1G",
    beforeSpawn,
  }: Options = {},
): Promise<BeesStartResult> {
  if (beesDisabledByEnv()) {
    logger.debug(
      "bees: COCALC_DISABLE_BEES is set to not running bees",
      mountpoint,
    );
    return { status: "disabled" };
  }
  const beeshome = join(mountpoint, ".beeshome");
  if (!(await exists(beeshome))) {
    await sudo({ command: "btrfs", args: ["subvolume", "create", beeshome] });
    // disable COW
    await sudo({ command: "chattr", args: ["+C", beeshome] });
  }
  const dat = join(beeshome, "beeshash.dat");
  if (!(await exists(dat))) {
    await sudo({ command: "truncate", args: ["-s", size, dat] });
    await sudo({ command: "chmod", args: ["700", dat] });
  }

  const args: string[] = ["bees", "-v", `${verbose}`];
  if (workerCount > 0) {
    args.push("-c", `${Math.max(1, Math.floor(workerCount))}`);
  }
  args.push(mountpoint);
  await beforeSpawn?.();
  logger.debug(`Running 'sudo -n ${STORAGE_WRAPPER} ${args.join(" ")}'`);
  const child = spawn("sudo", ["-n", STORAGE_WRAPPER, ...args], {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.unref();
  let stderr = "";
  const startup = await new Promise<
    | { status: "starting" | "timeout" }
    | { status: "exit"; code: number | null; signal: NodeJS.Signals | null }
    | { status: "error"; error: Error }
  >((resolve) => {
    let settled = false;
    const finish = (result: Parameters<typeof resolve>[0]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      child.stderr.off("data", onData);
      resolve(result);
    };
    const onError = (error: Error) => finish({ status: "error", error });
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish({ status: "exit", code, signal });
    const onData = (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.includes(BEES_STARTING_MARKER)) {
        finish({ status: "starting" });
      }
    };
    const timer = setTimeout(
      () => finish({ status: "timeout" }),
      BEES_STARTUP_HANDSHAKE_TIMEOUT_MS,
    );
    timer.unref();
    child.once("error", onError);
    child.once("exit", onExit);
    child.stderr.on("data", onData);
  });
  if (
    startup.status === "exit" &&
    startup.code === BEES_ALREADY_RUNNING_EXIT_CODE
  ) {
    return { status: "already-running", detail: stderr.trim() };
  }
  if (startup.status === "error" || startup.status === "exit") {
    const error =
      startup.status === "error"
        ? `${startup.error}: ${stderr}`
        : `failed to start bees: exited with code ${startup.code}, signal ${startup.signal ?? "none"}: ${stderr}`;
    logger.debug("ERROR: ", error);
    signalBeesProcessGroup(child, "SIGKILL");
    throw new Error(error);
  }
  if (startup.status === "timeout") {
    logger.warn("BEES wrapper did not emit startup handshake", {
      mountpoint,
      timeout_ms: BEES_STARTUP_HANDSHAKE_TIMEOUT_MS,
    });
  }
  // The wrapper execs verbose BEES with the same stderr descriptor. Keep
  // draining it after the startup handshake so a full pipe cannot stall BEES.
  child.stderr.resume();
  children.push(child);
  return { status: "started", child };
}

export function signalBeesProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (_err) {
    try {
      child.kill(signal);
    } catch (_err) {
      // Process is already gone.
    }
  }
}

export function close() {
  for (const child of children) {
    signalBeesProcessGroup(child, "SIGINT");
    setTimeout(() => signalBeesProcessGroup(child, "SIGKILL"), 1000);
  }
  children.length = 0;
}

process.once("exit", close);
["SIGINT", "SIGTERM", "SIGQUIT"].forEach((sig) => {
  process.once(sig, () => {
    process.exit();
  });
});
