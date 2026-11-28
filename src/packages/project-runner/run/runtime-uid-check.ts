/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The runtime uid self-check: kernel facts about every process on the host,
read by the daemon (the runtime user) at startup, every minute and after each
project start or stop, and reported in the heartbeat.

INVARIANT (what this check proves, and all it proves): no process running as
the host-services uid is in a namespace tuple other than the host services'
own or rootless Podman's infrastructure.

LIMIT: a container launched to share ALL of Podman's infrastructure
namespaces (user, mount and pid) would not be distinguishable by kernel facts.
That case is prevented by the launch gate (podman-launch.ts and its
structural test), not by this check. The check is not proof that all project
code is off the host-services uid.

How a process is judged (real uid only, never names, argv or environment):
- read /proc/PID/stat (start time), then status (real uid, NSpid), uid_map,
  the user/mnt/pid namespace links and the executable's identity, then the
  start time again: a process that changed in between is unknown;
- a process of the runtime uid is allowed when it is:
  - in the daemon's own (user, mnt, pid) namespaces: the host services;
  - in rootless Podman's parent user namespace (bound by its identity, the
    namespace `podman unshare` joins, read by the daemon itself) and the
    host's pid namespace: podman, conmon, catatonit. Their mount namespaces
    can't be bound to one identity (each conmon has its own); a launched
    container can't be in the host's pid namespace, since the launch gate
    refuses pid namespace (and pod) sharing;
  - in that parent user namespace and running the trusted pasta binary
    (the same device and inode), which sandboxes itself in a pid namespace
    of its own. A container launched without user namespace flags would have
    the same namespace shape: the binary's identity tells them apart (it is
    not mounted into any container; a compromised host-services uid could
    replace it, which is outside what this check can prove);
  anything else of the runtime uid is a violation; a runtime-uid process in a
  container's pid namespace always is.
- Processes that are not dumpable (the daemon's own workers, whose node
  binary has a file capability; systemd --user; sudo) don't let even the
  same uid read their namespace links. They are judged by what stays
  readable: an identity uid_map (the initial user namespace) and a single
  NSpid entry (the host's pid namespace) count as the host services,
  reported as "partial"; anything else is unknown. This is a stated revision
  of the invariant, and a documented weakness: project code never runs in the
  initial user namespace (containers always get their own, and separate
  projects don't run as the runtime uid), and a non-root process there can't
  make a mount namespace of its own, so the unread mount link hides nothing
  project code could set up.
- Unreadable is unknown, never fine. The allowed set is fixed by this rule:
  nothing that happens to exist when the daemon starts is enrolled.
*/

import { readdir, readFile, readlink, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { PROJECT_RUNTIME_SEPARATE_UID } from "@cocalc/util/project-runtime";
import { parseIdMap, type MapExtent } from "./runtime-identity";

export const RUNTIME_UID_INVARIANT =
  "no process running as the host-services uid is in a namespace tuple other than the host services' own or rootless Podman's infrastructure";

export interface NsTuple {
  user: string;
  mnt: string;
  pid: string;
}

/** What /proc says about one process (as read, before judging). */
export interface ProcFacts {
  pid: number;
  ruid: number;
  // pid in each nested pid namespace, outermost first (NSpid)
  nspid: number[];
  uidMap?: MapExtent[];
  ns?: NsTuple; // undefined: not readable (not dumpable)
  exe?: { dev: number; ino: number };
  cgroup?: string;
  // the process changed between reads, or a read failed unexpectedly
  unstable?: boolean;
}

export interface CheckContext {
  runtimeUid: number;
  separateUid: number;
  daemon: NsTuple;
  // the runtime user's subordinate uid ranges ({start, length}), in order
  subuids: { start: number; length: number }[];
  // rootless Podman's parent user namespace ("user:[N]", from podman
  // unshare), when known
  podmanUserNs?: string;
  // the trusted pasta executables (passt and its variants), by identity
  pasta: { dev: number; ino: number }[];
  configured: "keep-id" | "separate" | "invalid";
}

export interface ViolationDetail {
  pid: number;
  kind: "container-pid-namespace" | "other-namespaces";
  // the shape of its user namespace's map (numbers only)
  uid_map: string;
  // which cgroup subtree it is in: project pool, host services, other
  cgroup: "project-pool" | "host-services" | "other";
  // pid namespace depth relative to the host (1: the host's)
  pid_depth: number;
}

export interface RuntimeUidCheck {
  invariant: string;
  // null on a keep-id host, where project code runs as the runtime uid by
  // design: the check only judges hosts configured otherwise
  violations: number | null;
  unknown: number;
  partial: number;
  // containers of the other mode still running: keep-id ones on a separate
  // host, separate ones on a keep-id host (by pid namespace or cgroup)
  old_mode_containers: number;
  checked_at: string;
  detail?: ViolationDetail[];
  // complete scans this check took (processes vanishing mid-scan make the
  // monitor scan again), and the earlier scans' unknown counts
  scans?: number;
  unknown_before?: number[];
}

const MAX_DETAIL = 10;

export function cgroupClass(cgroup?: string): ViolationDetail["cgroup"] {
  if (!cgroup) return "other";
  if (cgroup.includes("cocalc-project-pool")) return "project-pool";
  if (cgroup.includes("cocalc-host-services")) return "host-services";
  return "other";
}

function mapShape(map?: MapExtent[]): string {
  return (map ?? [])
    .map((e) => `${e.inside} ${e.outside} ${e.length}`)
    .join(", ");
}

export function isIdentityMap(map?: MapExtent[]): boolean {
  return (
    map != null &&
    map.length === 1 &&
    map[0].inside === 0 &&
    map[0].outside === 0 &&
    map[0].length === 4294967295
  );
}

/**
 * Rootless Podman's parent user namespace, by its map: 0 is the runtime uid
 * (length 1), then the runtime user's subordinate ranges, in order, from 1.
 */
export function isRootlessParentMap(
  map: MapExtent[] | undefined,
  runtimeUid: number,
  subuids: { start: number; length: number }[],
): boolean {
  if (map == null || map.length !== subuids.length + 1 || subuids.length === 0)
    return false;
  const [first, ...rest] = map;
  if (first.inside !== 0 || first.outside !== runtimeUid || first.length !== 1)
    return false;
  let inside = 1;
  for (let i = 0; i < subuids.length; i++) {
    const e = rest[i];
    if (
      e.inside !== inside ||
      e.outside !== subuids[i].start ||
      e.length !== subuids[i].length
    )
      return false;
    inside += e.length;
  }
  return true;
}

function sameTuple(a: NsTuple, b: NsTuple): boolean {
  return a.user === b.user && a.mnt === b.mnt && a.pid === b.pid;
}

/** Judge a process table (pure: the tests run it on measured shapes). */
export function judgeProcesses(
  procs: ProcFacts[],
  ctx: CheckContext,
  now = new Date(),
): RuntimeUidCheck {
  let violations = 0;
  let unknown = 0;
  let partial = 0;
  const detail: ViolationDetail[] = [];
  // old-mode containers, by pid namespace (or cgroup when it can't be read)
  const oldKeepId = new Set<string>();
  const oldSeparate = new Set<string>();
  const judgeViolations = ctx.configured !== "keep-id";
  for (const p of procs) {
    if (p.ruid === ctx.separateUid) {
      if (ctx.configured === "keep-id")
        oldSeparate.add(p.ns?.pid ?? p.cgroup ?? `pid:${p.pid}`);
      continue;
    }
    // a process that kept changing (or couldn't be attributed) is unknown
    if (p.unstable && (p.ruid === ctx.runtimeUid || Number.isNaN(p.ruid))) {
      unknown++;
      continue;
    }
    if (p.ruid !== ctx.runtimeUid || p.unstable) continue;
    const depth = p.nspid.length;
    if (p.ns == null) {
      // not dumpable: judged by what stays readable
      if (isIdentityMap(p.uidMap) && depth === 1) partial++;
      else unknown++;
      continue;
    }
    if (
      ctx.podmanUserNs == null &&
      !sameTuple(p.ns, ctx.daemon) &&
      isRootlessParentMap(p.uidMap, ctx.runtimeUid, ctx.subuids)
    ) {
      // Podman's namespace couldn't be read: its processes can't be bound
      unknown++;
      continue;
    }
    const inParent = ctx.podmanUserNs != null && p.ns.user === ctx.podmanUserNs;
    const allowed =
      sameTuple(p.ns, ctx.daemon) ||
      (inParent && p.ns.pid === ctx.daemon.pid) ||
      (inParent &&
        p.exe != null &&
        ctx.pasta.some((t) => t.dev === p.exe!.dev && t.ino === p.exe!.ino));
    if (allowed) continue;
    if (!judgeViolations) continue;
    violations++;
    // a keep-id project's process: the project user (2001) is the runtime uid
    const keepIdContainer = (p.uidMap ?? []).some(
      (e) => e.outside === ctx.runtimeUid && e.length === 1 && e.inside !== 0,
    );
    // counted by the container's own pid namespace, directly below the
    // host's: namespaces nested inside a container (a browser sandbox) are
    // that container's, already counted (still each a violation)
    if (keepIdContainer && depth === 2) oldKeepId.add(p.ns.pid);
    if (detail.length < MAX_DETAIL)
      detail.push({
        pid: p.pid,
        kind:
          p.ns.pid !== ctx.daemon.pid && depth > 1
            ? "container-pid-namespace"
            : "other-namespaces",
        uid_map: mapShape(p.uidMap),
        cgroup: cgroupClass(p.cgroup),
        pid_depth: depth,
      });
  }
  return {
    invariant: RUNTIME_UID_INVARIANT,
    violations: judgeViolations ? violations : null,
    unknown,
    partial,
    old_mode_containers:
      ctx.configured === "keep-id" ? oldSeparate.size : oldKeepId.size,
    checked_at: now.toISOString(),
    ...(detail.length > 0 ? { detail } : {}),
  };
}

/** Field 22 of /proc/PID/stat (after the parenthesized comm). */
export function parseStartTime(stat: string): string | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = stat.slice(close + 2).split(" ");
  // fields[0] is field 3 (state): start time is field 22
  return fields[19];
}

export function parseStatus(status: string): {
  ruid?: number;
  nspid: number[];
} {
  let ruid: number | undefined;
  let nspid: number[] = [];
  for (const line of status.split("\n")) {
    if (line.startsWith("Uid:")) ruid = Number(line.split(/\s+/)[1]);
    else if (line.startsWith("NSpid:"))
      nspid = line.split(/\s+/).slice(1).filter(Boolean).map(Number);
  }
  return { ruid, nspid };
}

export function parseSubuids(
  text: string,
  user: { name: string; uid: number },
): { start: number; length: number }[] {
  const out: { start: number; length: number }[] = [];
  for (const line of text.split("\n")) {
    const [who, start, length] = line.trim().split(":");
    if (who !== user.name && who !== `${user.uid}`) continue;
    if (!/^\d+$/.test(start ?? "") || !/^\d+$/.test(length ?? "")) continue;
    out.push({ start: Number(start), length: Number(length) });
  }
  return out;
}

async function readOne(
  procRoot: string,
  pid: number,
  wantNs: (ruid: number) => boolean,
): Promise<ProcFacts> {
  const dir = join(procRoot, `${pid}`);
  let start1: string | undefined;
  try {
    start1 = parseStartTime(await readFile(join(dir, "stat"), "utf8"));
  } catch {
    // listed but gone before the first read: who it ran as can't be bound,
    // so it is unknown (never assumed fine)
    return { pid, ruid: Number.NaN, nspid: [], unstable: true };
  }
  try {
    const { ruid, nspid } = parseStatus(
      await readFile(join(dir, "status"), "utf8"),
    );
    if (ruid == null) throw Error("no uid");
    const facts: ProcFacts = { pid, ruid, nspid };
    if (wantNs(ruid)) {
      facts.uidMap = parseIdMap(await readFile(join(dir, "uid_map"), "utf8"));
      try {
        facts.ns = {
          user: await readlink(join(dir, "ns/user")),
          mnt: await readlink(join(dir, "ns/mnt")),
          pid: await readlink(join(dir, "ns/pid")),
        };
        const exe = await stat(join(dir, "exe"));
        facts.exe = { dev: exe.dev, ino: exe.ino };
      } catch (err) {
        if ((err as { code?: string })?.code !== "EACCES") throw err;
        facts.ns = undefined;
        facts.exe = undefined;
      }
    }
    try {
      facts.cgroup = (await readFile(join(dir, "cgroup"), "utf8")).trim();
    } catch {}
    const start2 = parseStartTime(await readFile(join(dir, "stat"), "utf8"));
    if (start2 !== start1) return { pid, ruid, nspid, unstable: true };
    return facts;
  } catch {
    return { pid, ruid: Number.NaN, nspid: [], unstable: true };
  }
}

/** Read every process (a second look at the unstable ones, once). */
export async function readProcessTable({
  procRoot = "/proc",
  wantNs,
}: {
  procRoot?: string;
  wantNs: (ruid: number) => boolean;
}): Promise<ProcFacts[]> {
  const pids = (await readdir(procRoot))
    .filter((name) => /^\d+$/.test(name))
    .map(Number);
  const out: ProcFacts[] = [];
  const retry: number[] = [];
  for (const pid of pids) {
    const facts = await readOne(procRoot, pid, wantNs);
    if (facts.unstable) retry.push(pid);
    else out.push(facts);
  }
  for (const pid of retry) {
    // every listed pid is judged: one that reads cleanly the second time
    // counts as read, one that vanished or keeps changing stays unknown
    out.push(await readOne(procRoot, pid, wantNs));
  }
  return out;
}

export async function runtimeUidCheckContext({
  configured,
  pastaBinaries = [],
  podmanUserNs,
  procRoot = "/proc",
}: {
  configured: CheckContext["configured"];
  pastaBinaries?: string[];
  // the user namespace `podman unshare` joins ("user:[N]"), when known
  podmanUserNs?: string;
  procRoot?: string;
}): Promise<CheckContext> {
  const runtimeUid = process.getuid?.() ?? -1;
  const self = join(procRoot, "self");
  const daemon = {
    user: await readlink(join(self, "ns/user")),
    mnt: await readlink(join(self, "ns/mnt")),
    pid: await readlink(join(self, "ns/pid")),
  };
  let subuids: { start: number; length: number }[] = [];
  try {
    subuids = parseSubuids(await readFile("/etc/subuid", "utf8"), {
      name: userInfo().username,
      uid: runtimeUid,
    });
  } catch {}
  const pasta: CheckContext["pasta"] = [];
  for (const path of pastaBinaries) {
    try {
      const st = await stat(path);
      pasta.push({ dev: st.dev, ino: st.ino });
    } catch {}
  }
  return {
    runtimeUid,
    separateUid: PROJECT_RUNTIME_SEPARATE_UID,
    daemon,
    subuids,
    ...(podmanUserNs && /^user:\[\d+\]$/.test(podmanUserNs)
      ? { podmanUserNs }
      : {}),
    pasta,
    configured,
  };
}
