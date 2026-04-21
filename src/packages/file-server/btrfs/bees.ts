/*
Automate running BEES on the btrfs pool.
*/

import { spawn, type ChildProcess } from "node:child_process";
import { delay } from "awaiting";
import getLogger from "@cocalc/backend/logger";
import { sudo, STORAGE_WRAPPER } from "./util";
import { exists } from "@cocalc/backend/misc/async-utils-node";
import { join } from "node:path";

const logger = getLogger("file-server:btrfs:bees");
const BEES_ALREADY_RUNNING_EXIT_CODE = 75;

interface Options {
  // average load target: default=1
  loadavgTarget?: number;
  // 0-8: default 1
  verbose?: number;
  // hash table size: default 1G
  size?: string;
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
  { loadavgTarget = 1, verbose = 1, size = "1G" }: Options = {},
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
  if (loadavgTarget) {
    args.push("-g", `${loadavgTarget}`);
  }
  args.push(mountpoint);
  logger.debug(`Running 'sudo -n ${STORAGE_WRAPPER} ${args.join(" ")}'`);
  const child = spawn("sudo", ["-n", STORAGE_WRAPPER, ...args], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.unref();
  let error: string = "";
  child.once("error", (err) => {
    error = `${err}`;
  });
  let stderr = "";
  const f = (chunk: Buffer) => {
    stderr += chunk.toString();
  };
  child.stderr.on("data", f);
  await delay(1000);
  if (error) {
    error += stderr;
  } else if (child.exitCode === BEES_ALREADY_RUNNING_EXIT_CODE) {
    child.stderr.removeListener("data", f);
    return { status: "already-running", detail: stderr.trim() };
  } else if (child.exitCode != null) {
    error = `failed to start bees: exited with code ${child.exitCode}: ${stderr}`;
  }
  if (error) {
    logger.debug("ERROR: ", error);
    signalBeesProcessGroup(child, "SIGKILL");
    throw new Error(error);
  }
  child.stderr.removeListener("data", f);
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
