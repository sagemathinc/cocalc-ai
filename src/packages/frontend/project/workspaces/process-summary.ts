/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { pathMatchesWorkspace } from "@cocalc/conat/workspaces";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";
import type {
  Process,
  ProjectInfo,
  ProjectInfoHistory,
} from "@cocalc/util/types/project-info/types";
import type { WorkspaceRecord } from "./types";

export type WorkspaceProcessLiveSummary = {
  processCount: number;
  terminals: number;
  notebooks: number;
  other: number;
  cpuPct: number;
  memRss: number;
};

export type WorkspaceProcessHistorySummary = {
  cpuTrend: number[];
  memTrend: number[];
  timestamps: number[];
};

export type WorkspaceProcessSummary = WorkspaceProcessLiveSummary &
  WorkspaceProcessHistorySummary;

function normalizeWorkspaceProcessPath(
  path: string | undefined,
  homeDirectory: string,
): string | undefined {
  const trimmed = `${path ?? ""}`.trim();
  if (!trimmed) return;
  return normalizeAbsolutePath(trimmed, homeDirectory);
}

function processPath(
  process: Pick<Process, "origin" | "cocalc">,
): string | undefined {
  if (process.origin?.path) return process.origin.path;
  const cocalc = process.cocalc;
  if (cocalc != null && "path" in cocalc) {
    return cocalc.path;
  }
  return undefined;
}

function liveProcessKind(process: Pick<Process, "origin" | "cocalc">) {
  return process.origin?.kind ?? process.cocalc?.type;
}

function matchesWorkspace(
  record: WorkspaceRecord,
  path: string | undefined,
  homeDirectory: string,
): boolean {
  const normalized = normalizeWorkspaceProcessPath(path, homeDirectory);
  return normalized != null && pathMatchesWorkspace(record, normalized);
}

export function summarizeWorkspaceLiveProcesses(
  record: WorkspaceRecord,
  info: ProjectInfo | null,
  homeDirectory: string,
): WorkspaceProcessLiveSummary {
  const summary: WorkspaceProcessLiveSummary = {
    processCount: 0,
    terminals: 0,
    notebooks: 0,
    other: 0,
    cpuPct: 0,
    memRss: 0,
  };
  if (info?.processes == null) return summary;

  for (const process of Object.values(info.processes)) {
    if (!matchesWorkspace(record, processPath(process), homeDirectory)) {
      continue;
    }
    summary.processCount += 1;
    summary.cpuPct += process.cpu.pct;
    summary.memRss += process.stat.mem.rss;
    switch (liveProcessKind(process)) {
      case "terminal":
        summary.terminals += 1;
        break;
      case "jupyter":
        summary.notebooks += 1;
        break;
      default:
        summary.other += 1;
        break;
    }
  }

  return summary;
}

export function summarizeWorkspaceProcessHistory(
  record: WorkspaceRecord,
  history: ProjectInfoHistory | null,
  homeDirectory: string,
): WorkspaceProcessHistorySummary {
  const cpuTrend: number[] = [];
  const memTrend: number[] = [];
  const timestamps: number[] = [];

  for (const sample of history?.samples ?? []) {
    let cpuPct = 0;
    let memRss = 0;
    for (const process of Object.values(sample.processes ?? {})) {
      if (!matchesWorkspace(record, process.path, homeDirectory)) continue;
      cpuPct += process.cpu_pct ?? 0;
      memRss += process.mem_rss ?? 0;
    }
    if (cpuPct === 0 && memRss === 0) continue;
    cpuTrend.push(cpuPct);
    memTrend.push(memRss);
    timestamps.push(sample.timestamp);
  }

  return { cpuTrend, memTrend, timestamps };
}

export function summarizeWorkspaceProcesses(opts: {
  record: WorkspaceRecord;
  info: ProjectInfo | null;
  history: ProjectInfoHistory | null;
  homeDirectory: string;
}): WorkspaceProcessSummary {
  return {
    ...summarizeWorkspaceLiveProcesses(
      opts.record,
      opts.info,
      opts.homeDirectory,
    ),
    ...summarizeWorkspaceProcessHistory(
      opts.record,
      opts.history,
      opts.homeDirectory,
    ),
  };
}
