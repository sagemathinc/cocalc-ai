/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The host side of a separate project runtime uid (see runtime-identity.ts):
what a start asks of the root helper and how it checks that the host is safe
for it.

- The helper's capabilities come from `cocalc-runtime-storage project-view
  probe`, never from HELPER_SCHEMA_VERSION (numbers are assigned in merge
  order and say nothing about features).
- The live rootless map comes from `podman unshare`.
- hostPreconditions() reads the host's state (stat and mountinfo only) and
  lists what isn't safe; any failure keeps the start on keep-id.

Both are cached briefly: they change only when the host's helpers or rootless
namespace change, and a start must not pay for them every time.
*/

import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { executeCode } from "@cocalc/backend/execute-code";
import { podman } from "@cocalc/backend/podman";
import getLogger from "@cocalc/backend/logger";
import {
  resolveRuntimeIdentity,
  type RuntimeIdentity,
  type RuntimeUidModeStatus,
} from "./runtime-identity";

const logger = getLogger("project-runner:runtime-host");

const STORAGE_WRAPPER = "/usr/local/sbin/cocalc-runtime-storage";
const HELPER_TIMEOUT_S = 30;
const CACHE_MS = 5 * 60_000;

// What the root helper creates and checks (see bootstrap.py).
export const PROJECT_DATA_ROOT = "/mnt/cocalc";
export const PROJECT_VIEW_ROOT = "/run/cocalc/project-views";
export const PROJECT_ROOTFS_ROOT = "/run/cocalc/project-rootfs";

export type ProjectViewKind = "home" | "scratch" | "browser-run" | "secrets";

// The only sources the helper accepts for each view.
export function projectViewSource(
  project_id: string,
  kind: ProjectViewKind,
): string {
  switch (kind) {
    case "home":
      return join(PROJECT_DATA_ROOT, `project-${project_id}`);
    case "scratch":
      return join(PROJECT_DATA_ROOT, `project-${project_id}-scratch`);
    case "browser-run":
      return join(PROJECT_DATA_ROOT, "data/tmp/cocalc-browser-run", project_id);
    case "secrets":
      return join(
        PROJECT_DATA_ROOT,
        "data/tmp/cocalc-project-secrets",
        project_id,
      );
  }
}

export function projectViewPath(
  project_id: string,
  kind: ProjectViewKind,
): string {
  return join(PROJECT_VIEW_ROOT, project_id, kind);
}

export function projectIdmappedRootfsPath(project_id: string): string {
  return join(PROJECT_ROOTFS_ROOT, project_id, "root");
}

async function storageHelper(args: string[]): Promise<string> {
  const result = await executeCode({
    verbose: false,
    err_on_exit: true,
    command: "sudo",
    args: ["-n", STORAGE_WRAPPER, ...args],
    timeout: HELPER_TIMEOUT_S,
  });
  return `${result.stdout ?? ""}`;
}

async function helperProbe(): Promise<string | undefined> {
  try {
    return await storageHelper(["project-view", "probe"]);
  } catch {
    // older helpers exit 2 with a usage line
    return undefined;
  }
}

async function liveMaps(): Promise<{ uidMap: string; gidMap: string }> {
  const read = async (file: string) =>
    `${(await podman(["unshare", "cat", file], { timeout: 30 })).stdout ?? ""}`;
  return {
    uidMap: await read("/proc/self/uid_map"),
    gidMap: await read("/proc/self/gid_map"),
  };
}

export interface MountEntry {
  mountpoint: string;
  options: string[];
  fstype: string;
}

export function parseMountinfo(text: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of `${text ?? ""}`.split("\n")) {
    if (!line) continue;
    const [left, right] = line.split(" - ");
    if (right == null) continue;
    const fields = left.split(" ");
    const after = right.split(" ");
    entries.push({
      mountpoint: fields[4],
      // per-mount options (field 6) and the superblock options after " - "
      options: [...(fields[5] ?? "").split(","), ...(after[2] ?? "").split(",")],
      fstype: after[0],
    });
  }
  return entries;
}

// The mount that contains path: the longest mountpoint that is a prefix.
export function mountFor(
  mounts: MountEntry[],
  path: string,
): MountEntry | undefined {
  let best: MountEntry | undefined;
  for (const m of mounts) {
    const prefix = m.mountpoint === "/" ? "/" : `${m.mountpoint}/`;
    if (
      (path === m.mountpoint || path.startsWith(prefix)) &&
      (best == null || m.mountpoint.length > best.mountpoint.length)
    ) {
      best = m;
    }
  }
  return best;
}

export interface HostState {
  stat: (
    path: string,
  ) => Promise<{ uid: number; gid: number; mode: number; isDirectory: boolean } | undefined>;
  mountinfo: () => Promise<string>;
  runtimeGid: number;
  // where the shared scratch dir of this host is, if it has one
  sharedScratch?: string;
}

/**
 * The host's safety preconditions for separate mode (agreed with
 * @security-audit): the failures, empty when the host is safe.
 */
export async function checkHostPreconditions(
  host: HostState,
): Promise<string[]> {
  const failures: string[] = [];
  const expect = async (
    path: string,
    want: { uid: number; gid?: number; mode: number },
  ) => {
    const info = await host.stat(path);
    if (info == null || !info.isDirectory) {
      failures.push(`${path} is missing`);
      return;
    }
    const mode = info.mode & 0o7777;
    if (
      info.uid !== want.uid ||
      (want.gid != null && info.gid !== want.gid) ||
      mode !== want.mode
    ) {
      failures.push(
        `${path} is ${info.uid}:${info.gid} ${mode.toString(8)}, not ${want.uid}:${want.gid ?? "*"} ${want.mode.toString(8)}`,
      );
    }
  };
  // the data root is hardened: only root and the runtime user get in
  await expect(PROJECT_DATA_ROOT, { uid: 0, gid: host.runtimeGid, mode: 0o750 });
  await expect(PROJECT_VIEW_ROOT, { uid: 0, gid: host.runtimeGid, mode: 0o710 });
  await expect(PROJECT_ROOTFS_ROOT, { uid: 0, gid: 0, mode: 0o711 });
  const run = await host.stat("/run/cocalc");
  if (run == null || run.uid !== 0 || (run.mode & 0o022) !== 0) {
    failures.push("/run/cocalc is not root-owned or is group/other-writable");
  }
  const mounts = parseMountinfo(await host.mountinfo());
  const data = mountFor(mounts, PROJECT_DATA_ROOT);
  for (const option of ["nosuid", "nodev"]) {
    if (!data?.options.includes(option)) {
      failures.push(`${PROJECT_DATA_ROOT} is not mounted ${option}`);
    }
  }
  // Shared scratch has no safe view yet: separate mode needs it absent.
  if (host.sharedScratch) {
    failures.push(`shared scratch ${host.sharedScratch} has no project view`);
  }
  return failures;
}

async function statHost(path: string) {
  try {
    const info = await lstat(path);
    return {
      uid: info.uid,
      gid: info.gid,
      mode: info.mode,
      isDirectory: info.isDirectory(),
    };
  } catch {
    return undefined;
  }
}

let cached:
  | { at: number; key: string; identity: Promise<RuntimeIdentity> }
  | undefined;
let lastStatus: RuntimeUidModeStatus | undefined;

/** The last decision, for health and the heartbeat. */
export function runtimeUidModeStatus(): RuntimeUidModeStatus | undefined {
  return lastStatus;
}

export function clearRuntimeIdentityCache(): void {
  cached = undefined;
}

/**
 * Keep-id or separate for the next start. Fallbacks are warned on every start
 * so an operator who configured separate sees why it isn't in effect.
 */
export async function runtimeIdentityForStart({
  sharedScratch,
}: {
  sharedScratch?: string;
} = {}): Promise<RuntimeIdentity> {
  const key = `${process.env.COCALC_PROJECT_RUNTIME_UID_MODE ?? ""}|${sharedScratch ?? ""}`;
  if (cached == null || cached.key !== key || Date.now() - cached.at > CACHE_MS) {
    const identity = resolveRuntimeIdentity({
      helperProbe,
      liveMaps,
      hostPreconditions: async () =>
        await checkHostPreconditions({
          stat: statHost,
          mountinfo: async () => await readFile("/proc/self/mountinfo", "utf8"),
          runtimeGid: process.getgid?.() ?? -1,
          sharedScratch,
        }),
    });
    cached = { at: Date.now(), key, identity };
    // a failed resolution must not stick
    identity.catch(() => {
      if (cached?.identity === identity) cached = undefined;
    });
  }
  const identity = await cached.identity;
  lastStatus = identity.status;
  if (identity.status.configured !== "keep-id" && identity.mode === "keep-id") {
    logger.warn("separate runtime uid configured but not in effect", identity.status);
  }
  return identity;
}

/** project-view harden: idempotent; run before each separate start. */
export async function hardenProjectDataRoot(): Promise<void> {
  await storageHelper(["project-view", "harden"]);
}

export async function mountProjectView({
  project_id,
  kind,
  uid,
}: {
  project_id: string;
  kind: ProjectViewKind;
  uid: number;
}): Promise<string> {
  await storageHelper([
    "project-view",
    "mount",
    project_id,
    kind,
    `${uid}`,
    projectViewSource(project_id, kind),
  ]);
  return projectViewPath(project_id, kind);
}

/** Unmounts every view of the project (and its idmapped rootfs upper). */
export async function umountProjectViews(project_id: string): Promise<void> {
  await storageHelper(["project-view", "umount", project_id]);
}

export async function projectHasViews(project_id: string): Promise<boolean> {
  const prefix = join(PROJECT_VIEW_ROOT, project_id) + "/";
  try {
    return parseMountinfo(await readFile("/proc/self/mountinfo", "utf8")).some(
      (m) => m.mountpoint.startsWith(prefix),
    );
  } catch (err) {
    logger.debug("projectHasViews: failed to read mountinfo", { err: `${err}` });
    return false;
  }
}
