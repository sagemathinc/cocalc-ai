/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { exec as cp_exec } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { uptime } from "node:os";
import { promisify } from "node:util";
import type {
  CoCalcInfo,
  Process,
  Processes,
  Stat,
  State,
} from "@cocalc/util/types/project-info/types";
import {
  getOwnedProcessRegistry,
  type OwnedRootProcess,
} from "./owned-process-registry";
import type { ProcessSnapshot, ProcessSnapshotProvider } from "./snapshot-provider";
import { ensureJupyterOwnedRootBridge } from "./jupyter-owned-roots";
import { ensureBackendOwnedRootBridge } from "./backend-owned-roots";

const exec = promisify(cp_exec);
const DEFAULT_PROCESS_LIMIT = 1024;

export function collectDescendantsFromMap(opts: {
  rootPids: number[];
  childrenByPid: Map<number, number[]>;
  limit?: number;
}): Set<number> {
  const { rootPids, childrenByPid, limit = DEFAULT_PROCESS_LIMIT } = opts;
  const seen = new Set<number>();
  const queue = [...rootPids];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (seen.size >= limit) break;
    for (const child of childrenByPid.get(pid) ?? []) {
      if (!seen.has(child)) queue.push(child);
    }
  }
  return seen;
}

export function collectDescendantsByRoot(opts: {
  roots: (OwnedRootProcess & { pid: number })[];
  childrenByPid: Map<number, number[]>;
  limit?: number;
}): {
  pids: Set<number>;
  rootByPid: Map<number, OwnedRootProcess & { pid: number }>;
} {
  const { roots, childrenByPid, limit = DEFAULT_PROCESS_LIMIT } = opts;
  const pids = new Set<number>();
  const rootByPid = new Map<number, OwnedRootProcess & { pid: number }>();
  for (const root of roots) {
    const queue = [root.pid];
    const seen = new Set<number>();
    while (queue.length > 0) {
      const pid = queue.shift()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      if (!pids.has(pid)) {
        pids.add(pid);
      }
      if (!rootByPid.has(pid)) {
        rootByPid.set(pid, root);
      }
      if (pids.size >= limit) {
        return { pids, rootByPid };
      }
      for (const child of childrenByPid.get(pid) ?? []) {
        if (!seen.has(child)) queue.push(child);
      }
    }
  }
  return { pids, rootByPid };
}

export function staleRootIds(opts: {
  roots: OwnedRootProcess[];
  alivePids: Set<number>;
}): string[] {
  const { roots, alivePids } = opts;
  const stale: string[] = [];
  for (const root of roots) {
    if (root.pid == null) continue;
    if (!alivePids.has(root.pid)) stale.push(root.root_id);
  }
  return stale;
}

function cocalcInfoFromRoot(root: OwnedRootProcess): CoCalcInfo | undefined {
  switch (root.kind) {
    case "project":
      return { type: "project" };
    case "sshd":
      return { type: "sshd" };
    case "terminal":
      if (root.path != null) {
        return { type: "terminal", path: root.path };
      }
      return;
    case "jupyter":
      if (root.path != null) {
        return { type: "jupyter", path: root.path };
      }
      return;
    case "x11":
      if (root.path != null) {
        return { type: "x11", path: root.path };
      }
      return;
    default:
      return;
  }
}

export class OwnedLinuxProcessSnapshotProvider implements ProcessSnapshotProvider {
  readonly scope = "owned" as const;
  private readonly registry = getOwnedProcessRegistry();
  private readonly procLimit: number;
  private ticks = 100;
  private pagesize = 4096;
  private last = new Map<number, { timestamp: number; cpuSecs: number }>();

  constructor(opts?: { procLimit?: number }) {
    this.procLimit = opts?.procLimit ?? DEFAULT_PROCESS_LIMIT;
  }

  async init(_opts: { testing: boolean }) {
    ensureJupyterOwnedRootBridge();
    ensureBackendOwnedRootBridge();
    const [p_ticks, p_pagesize] = await Promise.all([
      exec("getconf CLK_TCK"),
      exec("getconf PAGESIZE"),
    ]);
    this.ticks = parseInt(p_ticks.stdout.trim()) || 100;
    this.pagesize = parseInt(p_pagesize.stdout.trim()) || 4096;
  }

  async snapshot(timestamp: number): Promise<ProcessSnapshot> {
    const trackedRoots = this.registry
      .listActiveRoots()
      .filter((root) => root.pid != null) as (OwnedRootProcess & {
      pid: number;
    })[];
    const roots = [...trackedRoots];
    if (!roots.some((root) => root.pid === process.pid)) {
      roots.push({
        root_id: "project-self",
        kind: "project",
        pid: process.pid,
        spawned_at: Date.now(),
      });
    }
    const { uptime: up, boottime } = this.nowUptime();
    if (roots.length === 0) {
      this.last.clear();
      return {
        scope: this.scope,
        uptime: up,
        boottime,
        process_count: { visible: 0, total: 0 },
      };
    }

    const alive = new Set<number>();
    const rootPids: number[] = [];
    const childrenByPid = new Map<number, number[]>();

    // Build a descendant graph from live roots only.
    for (const root of roots) {
      const stat = await this.readStat(root.pid);
      if (stat == null) continue;
      if (
        root.start_time != null &&
        Number.isFinite(root.start_time) &&
        stat.starttime !== root.start_time
      ) {
        continue;
      }
      alive.add(root.pid);
      rootPids.push(root.pid);
      await this.loadChildrenGraph(root.pid, childrenByPid, alive);
    }

    for (const root_id of staleRootIds({ roots: trackedRoots, alivePids: alive })) {
      this.registry.markExited(root_id);
    }

    const liveRootPidSet = new Set(rootPids);
    const { pids: pidSet, rootByPid } = collectDescendantsByRoot({
      roots: roots.filter((root) => liveRootPidSet.has(root.pid)),
      childrenByPid,
      limit: this.procLimit,
    });
    const procs: Processes = {};
    for (const pid of pidSet) {
      const proc = await this.readProcess({
        pid,
        timestamp,
        uptime: up,
        root: rootByPid.get(pid),
      });
      if (proc != null) {
        procs[proc.pid] = proc;
      }
    }
    this.pruneLast(pidSet);
    const visible = Object.keys(procs).length;
    return {
      scope: this.scope,
      procs,
      uptime: up,
      boottime,
      process_count: { visible, total: visible },
    };
  }

  private nowUptime() {
    const up = uptime();
    return { uptime: up, boottime: new Date(Date.now() - up * 1000) };
  }

  private async loadChildrenGraph(
    pid: number,
    childrenByPid: Map<number, number[]>,
    alive: Set<number>,
  ): Promise<void> {
    const queue = [pid];
    const seen = new Set<number>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const children = await this.readChildren(current);
      childrenByPid.set(current, children);
      for (const child of children) {
        alive.add(child);
        if (!seen.has(child)) queue.push(child);
      }
    }
  }

  private async readChildren(pid: number): Promise<number[]> {
    try {
      const path = `/proc/${pid}/task/${pid}/children`;
      const raw = (await readFile(path, "utf8")).trim();
      if (raw.length === 0) return [];
      return raw
        .split(/\s+/)
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isFinite(n));
    } catch {
      return [];
    }
  }

  private async readStat(pid: number): Promise<Stat | undefined> {
    try {
      const raw = await readFile(`/proc/${pid}/stat`, "utf8");
      const i = raw.indexOf("(");
      const j = raw.lastIndexOf(")");
      const start = raw.slice(0, i - 1).trim();
      const end = raw.slice(j + 1).trim();
      const data = `${start} comm ${end}`.split(" ");
      const get = (idx: number) => parseInt(data[idx], 10);
      return {
        ppid: get(3),
        state: data[2] as State,
        utime: get(13) / this.ticks,
        stime: get(14) / this.ticks,
        cutime: get(15) / this.ticks,
        cstime: get(16) / this.ticks,
        starttime: get(21) / this.ticks,
        nice: get(18),
        num_threads: get(19),
        mem: { rss: (get(23) * this.pagesize) / (1024 * 1024) },
      };
    } catch {
      return undefined;
    }
  }

  private async readCmdline(pid: number): Promise<string[] | undefined> {
    try {
      return (await readFile(`/proc/${pid}/cmdline`, "utf8"))
        .split("\0")
        .filter((x) => x.length > 0);
    } catch {
      return undefined;
    }
  }

  private async readExe(pid: number): Promise<string | undefined> {
    try {
      return await readlink(`/proc/${pid}/exe`);
    } catch {
      return undefined;
    }
  }

  private async readProcess(opts: {
    pid: number;
    timestamp: number;
    uptime: number;
    root?: OwnedRootProcess;
  }): Promise<Process | undefined> {
    const { pid, timestamp, uptime, root } = opts;
    const [stat, cmdline, exe] = await Promise.all([
      this.readStat(pid),
      this.readCmdline(pid),
      this.readExe(pid),
    ]);
    if (stat == null || cmdline == null || exe == null) return;
    const cpuSecs = stat.utime + stat.stime;
    const prev = this.last.get(pid);
    const pct =
      prev == null
        ? 0
        : 100 *
          ((cpuSecs - prev.cpuSecs) /
            Math.max(0.001, (timestamp - prev.timestamp) / 1000));
    this.last.set(pid, { timestamp, cpuSecs });
    return {
      pid,
      ppid: stat.ppid,
      cmdline,
      exe,
      stat,
      cpu: { pct, secs: cpuSecs },
      uptime: uptime - stat.starttime,
      cocalc: root == null ? undefined : cocalcInfoFromRoot(root),
      origin:
        root == null
          ? undefined
          : {
              root_id: root.root_id,
              kind: root.kind,
              path: root.path,
              thread_id: root.thread_id,
              session_id: root.session_id,
            },
    };
  }

  private pruneLast(pids: Set<number>) {
    for (const pid of this.last.keys()) {
      if (!pids.has(pid)) this.last.delete(pid);
    }
  }
}
