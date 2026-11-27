/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Keeps the host's runtime uid state current without waiting for a project
start: at daemon startup, every minute, and after each project start or
stop, it evaluates the configured mode (the decision a start would make) and
runs the self-check over the host's processes (runtime-uid-check.ts). The
heartbeat reports both.

At daemon startup on a host configured for separate (or misconfigured), side
containers left from an earlier mode are stopped: they would run project
code as the host-services uid. Projects are never stopped here; they are left
to the operator's drain (see the transition label in runtime-host.ts).
*/

import { join } from "node:path";
import getLogger from "@cocalc/backend/logger";
import { configuredContainerRuntimeCurrent } from "@cocalc/backend/podman/env";
import { podman } from "@cocalc/backend/podman";
import { SHARED_BROWSER_APP_ID } from "@cocalc/util/shared-browser";
import { hostRuntimeUidMode } from "./podman-launch";
import {
  liveRuntimeUidMap,
  noteRuntimeUidCheck,
  RUNTIME_UID_CHECK_INTERVAL_MS,
  runtimeIdentityForStart,
} from "./runtime-host";
import {
  judgeProcesses,
  readProcessTable,
  runtimeUidCheckContext,
  type RuntimeUidCheck,
} from "./runtime-uid-check";

const logger = getLogger("project-runner:runtime-uid-monitor");

// Containers that run project code beside the project's own (side
// containers), by name prefix. Selecting by name only chooses what to stop;
// the self-check measures the result by kernel facts.
export const SIDE_CONTAINER_PREFIXES = [
  "acp-",
  "claude-controller-",
  "codex-",
  "sandbox-",
  "cocalc-rootfs-scan-",
  `${SHARED_BROWSER_APP_ID}-`,
];

export function isSideContainerName(name: string): boolean {
  return SIDE_CONTAINER_PREFIXES.some((prefix) => name.startsWith(prefix));
}

// pasta's binaries in the container-runtime bundle (pasta may be its own
// file or a link to passt; the CPU-specific builds are what runs)
const PASTA_NAMES = ["passt", "pasta"].flatMap((name) => [
  name,
  `${name}.avx2`,
  `${name}.avx512`,
]);

export function pastaBinaries(
  runtime = configuredContainerRuntimeCurrent(),
): string[] {
  return runtime ? PASTA_NAMES.map((x) => join(runtime, "bin", x)) : [];
}

let lastViolations = 0;

/** Read the host's processes and judge them; never throws. */
export async function runRuntimeUidCheck(): Promise<
  RuntimeUidCheck | undefined
> {
  try {
    const { state } = hostRuntimeUidMode();
    const ctx = await runtimeUidCheckContext({
      configured: state,
      pastaBinaries: pastaBinaries(),
      liveUidMap: await liveRuntimeUidMap(),
    });
    const table = await readProcessTable({
      wantNs: (ruid) => ruid === ctx.runtimeUid,
    });
    const check = judgeProcesses(table, ctx);
    noteRuntimeUidCheck(check);
    const violations = check.violations ?? 0;
    if (violations > 0 && violations !== lastViolations) {
      // content-free: counts and namespace shapes, no names or arguments
      logger.error("runtime uid self-check found violations", {
        violations,
        unknown: check.unknown,
        old_mode_containers: check.old_mode_containers,
        detail: check.detail,
      });
    }
    lastViolations = violations;
    return check;
  } catch (err) {
    logger.warn("runtime uid self-check failed", { err: `${err}` });
    return undefined;
  }
}

/** The decision a start would make now (reported while idle); never throws. */
export async function evaluateRuntimeUidMode(): Promise<void> {
  try {
    await runtimeIdentityForStart();
  } catch (err) {
    logger.warn("evaluating the runtime uid mode failed", { err: `${err}` });
  }
}

/** Stop side containers left from an earlier mode (daemon startup only). */
export async function stopLeftoverSideContainers({
  list = async () =>
    `${(await podman(["ps", "-a", "--format", "{{.Names}}"], { timeout: 30 })).stdout ?? ""}`,
  remove = async (name: string) => {
    await podman(["rm", "-f", "-t", "5", name], { timeout: 60 });
  },
}: {
  list?: () => Promise<string>;
  remove?: (name: string) => Promise<void>;
} = {}): Promise<string[]> {
  const names = (await list())
    .split("\n")
    .map((x) => x.trim())
    .filter((x) => x && isSideContainerName(x));
  const stopped: string[] = [];
  for (const name of names) {
    try {
      await remove(name);
      stopped.push(name);
    } catch (err) {
      logger.warn("could not stop a leftover side container", {
        name,
        err: `${err}`,
      });
    }
  }
  if (stopped.length > 0) {
    logger.warn("stopped side containers left from an earlier mode", {
      count: stopped.length,
    });
  }
  return stopped;
}

let timer: ReturnType<typeof setInterval> | undefined;
let pending: Promise<void> | undefined;

async function tick(): Promise<void> {
  await evaluateRuntimeUidMode();
  await runRuntimeUidCheck();
}

/** Run a check soon (after a project start or stop); coalesced. */
export function scheduleRuntimeUidCheck(): void {
  pending ??= tick().finally(() => {
    pending = undefined;
  });
}

/** At daemon startup: evaluate, clean up side containers, then every minute. */
export async function startRuntimeUidMonitor(): Promise<void> {
  if (timer != null) return;
  const { state } = hostRuntimeUidMode();
  if (state !== "keep-id") {
    try {
      await stopLeftoverSideContainers();
    } catch (err) {
      logger.warn("listing side containers failed", { err: `${err}` });
    }
  }
  await tick();
  timer = setInterval(() => void tick(), RUNTIME_UID_CHECK_INTERVAL_MS);
  timer.unref?.();
}

export function stopRuntimeUidMonitor(): void {
  if (timer != null) clearInterval(timer);
  timer = undefined;
}
