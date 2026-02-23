/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { exec as cp_exec } from "node:child_process";
import { uptime } from "node:os";
import { promisify } from "node:util";
import type {
  CoCalcInfo,
  Process,
  Processes,
  State,
} from "@cocalc/util/types/project-info/types";
import {
  getOwnedProcessRegistry,
  type OwnedRootProcess,
} from "./owned-process-registry";
import { collectDescendantsByRoot, staleRootIds } from "./owned-linux-snapshot-provider";
import type { ProcessSnapshot, ProcessSnapshotProvider } from "./snapshot-provider";
import { ensureJupyterOwnedRootBridge } from "./jupyter-owned-roots";
import { ensureBackendOwnedRootBridge } from "./backend-owned-roots";

const exec = promisify(cp_exec);
const DEFAULT_PROCESS_LIMIT = 1024;

type PsProc = {
  pid: number;
  ppid: number;
  cpuPct: number;
  rssMiB: number;
  etimes: number;
  nice: number;
  state: string;
  comm: string;
  args: string;
};

const PS_COMMAND =
  "ps -axo pid=,ppid=,%cpu=,rss=,etimes=,ni=,state=,comm=,args=";

export function normalizeState(state: string): State {
  const s = (state || "").trim().toUpperCase();
  if (s.includes("R")) return "R";
  if (s.includes("D")) return "D";
  if (s.includes("T")) return "T";
  if (s.includes("Z")) return "Z";
  if (s.includes("W")) return "W";
  return "S";
}

export function parsePsLine(line: string): PsProc | undefined {
  const m = line.trim().match(
    /^(\d+)\s+(\d+)\s+([0-9.]+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s*(.*)$/,
  );
  if (m == null) return;
  return {
    pid: Number.parseInt(m[1], 10),
    ppid: Number.parseInt(m[2], 10),
    cpuPct: Number.parseFloat(m[3]) || 0,
    rssMiB: (Number.parseInt(m[4], 10) || 0) / 1024,
    etimes: Number.parseInt(m[5], 10) || 0,
    nice: Number.parseInt(m[6], 10) || 0,
    state: m[7],
    comm: m[8],
    args: m[9] || m[8],
  };
}

function cocalcInfoFromRoot(root: OwnedRootProcess): CoCalcInfo | undefined {
  switch (root.kind) {
    case "project":
      return { type: "project" };
    case "sshd":
      return { type: "sshd" };
    case "terminal":
      if (root.path != null) return { type: "terminal", path: root.path };
      return;
    case "jupyter":
      if (root.path != null) return { type: "jupyter", path: root.path };
      return;
    case "x11":
      if (root.path != null) return { type: "x11", path: root.path };
      return;
    default:
      return;
  }
}

export class OwnedDarwinProcessSnapshotProvider implements ProcessSnapshotProvider {
  readonly scope = "owned" as const;
  private readonly registry = getOwnedProcessRegistry();
  private readonly procLimit: number;

  constructor(opts?: { procLimit?: number }) {
    this.procLimit = opts?.procLimit ?? DEFAULT_PROCESS_LIMIT;
  }

  async init(_opts: { testing: boolean }) {
    ensureJupyterOwnedRootBridge();
    ensureBackendOwnedRootBridge();
  }

  async snapshot(_timestamp: number): Promise<ProcessSnapshot> {
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
      return {
        scope: this.scope,
        uptime: up,
        boottime,
        process_count: { visible: 0, total: 0 },
      };
    }

    const rows = await this.readPsRows();
    const rowByPid = new Map(rows.map((row) => [row.pid, row]));
    const alive = new Set(rowByPid.keys());
    for (const root_id of staleRootIds({ roots: trackedRoots, alivePids: alive })) {
      this.registry.markExited(root_id);
    }
    const liveRoots = roots.filter((root) => rowByPid.has(root.pid));
    if (liveRoots.length === 0) {
      return {
        scope: this.scope,
        uptime: up,
        boottime,
        process_count: { visible: 0, total: 0 },
      };
    }

    const childrenByPid = new Map<number, number[]>();
    for (const row of rows) {
      const children = childrenByPid.get(row.ppid) ?? [];
      children.push(row.pid);
      childrenByPid.set(row.ppid, children);
      childrenByPid.set(row.pid, childrenByPid.get(row.pid) ?? []);
    }

    const { pids, rootByPid } = collectDescendantsByRoot({
      roots: liveRoots,
      childrenByPid,
      limit: this.procLimit,
    });
    const procs: Processes = {};
    for (const pid of pids) {
      const row = rowByPid.get(pid);
      if (row == null) continue;
      const root = rootByPid.get(pid);
      const cpuSecs = (row.cpuPct / 100) * row.etimes;
      const cmdline = row.args.trim().length > 0 ? row.args.trim().split(/\s+/) : [row.comm];
      const proc: Process = {
        pid: row.pid,
        ppid: row.ppid,
        exe: row.comm,
        cmdline,
        stat: {
          ppid: row.ppid,
          state: normalizeState(row.state),
          utime: cpuSecs,
          stime: 0,
          cutime: 0,
          cstime: 0,
          starttime: Math.max(0, up - row.etimes),
          nice: row.nice,
          num_threads: 1,
          mem: { rss: row.rssMiB },
        },
        cpu: { pct: row.cpuPct, secs: cpuSecs },
        uptime: row.etimes,
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
      procs[proc.pid] = proc;
    }
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

  private async readPsRows(): Promise<PsProc[]> {
    const { stdout } = await exec(PS_COMMAND);
    return stdout
      .split("\n")
      .map((line) => parsePsLine(line))
      .filter((row): row is PsProc => row != null);
  }
}
