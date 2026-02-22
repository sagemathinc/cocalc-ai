/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { akv, type AKV } from "@cocalc/conat/sync/akv";
import { getLogger } from "@cocalc/conat/client";
import { projectSubject } from "@cocalc/conat/names";
import { conat } from "@cocalc/conat/client";
import type {
  Process,
  Processes,
  ProjectInfo,
} from "@cocalc/util/types/project-info/types";
export type { ProjectInfo };

const SERVICE_NAME = "project-info";
const logger = getLogger("project:project-info");
const HISTORY_PREFIX = "v1/history/sample/";
const HISTORY_STORE_NAME = "project-info-history";
const DEFAULT_HISTORY_WINDOW_MINUTES = 60;
const DEFAULT_HISTORY_SAMPLE_SECONDS = 60;
const DEFAULT_HISTORY_TTL_SECONDS = 2 * 60 * 60;
const DEFAULT_HISTORY_TOP_N = 50;

export interface ProjectInfoHistoryProcessSample {
  id: string;
  pid: number;
  cpu_pct: number;
  mem_rss: number;
  kind?: string;
  path?: string;
  root_id?: string;
}

export interface ProjectInfoHistoryProjectSample {
  cpu_pct: number;
  mem_rss: number;
  mem_tot?: number;
  disk_usage?: number;
  nprocs: number;
}

export interface ProjectInfoHistorySample {
  timestamp: number;
  scope?: ProjectInfo["scope"];
  project: ProjectInfoHistoryProjectSample;
  processes: Record<string, ProjectInfoHistoryProcessSample>;
}

export interface ProjectInfoHistory {
  generated_at: number;
  minutes: number;
  samples: ProjectInfoHistorySample[];
}

function envInt(name: string, fallback: number, min: number): number {
  const value = Number.parseInt(process.env[name] ?? `${fallback}`, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, value);
}

function historyEphemeralDefault(): boolean {
  if (process.env.COCALC_PROJECT_INFO_HISTORY_EPHEMERAL != null) {
    return process.env.COCALC_PROJECT_INFO_HISTORY_EPHEMERAL !== "0";
  }
  // Lite sets this environment variable; launchpad does not.
  return process.env.COCALC_LITE_SQLITE_FILENAME != null;
}

function sampleKey(bucket: number): string {
  return `${HISTORY_PREFIX}${String(bucket).padStart(12, "0")}`;
}

function processStableId(proc: Process): string {
  return `${proc.pid}:${proc.stat.starttime}`;
}

function processSample(proc: Process): ProjectInfoHistoryProcessSample {
  return {
    id: processStableId(proc),
    pid: proc.pid,
    cpu_pct: proc.cpu.pct,
    mem_rss: proc.stat.mem.rss,
    kind: proc.origin?.kind ?? proc.cocalc?.type,
    path: proc.origin?.path ?? (proc.cocalc as any)?.path,
    root_id: proc.origin?.root_id,
  };
}

function topProcessesByUsage(
  processes: Processes | undefined,
  topN: number,
): Record<string, ProjectInfoHistoryProcessSample> {
  if (processes == null || topN <= 0) {
    return {};
  }
  const rows = Object.values(processes)
    .map(processSample)
    .sort((a, b) => b.cpu_pct - a.cpu_pct || b.mem_rss - a.mem_rss)
    .slice(0, topN);
  const out: Record<string, ProjectInfoHistoryProcessSample> = {};
  for (const row of rows) {
    out[row.id] = row;
  }
  return out;
}

function makeHistorySample(info: ProjectInfo, topN: number): ProjectInfoHistorySample {
  const rows = Object.values(info.processes ?? {});
  const cpu_pct = rows.reduce((sum, proc) => sum + proc.cpu.pct, 0);
  const mem_rss = rows.reduce((sum, proc) => sum + proc.stat.mem.rss, 0);
  const nprocs = rows.length;
  return {
    timestamp: info.timestamp,
    scope: info.scope,
    project: {
      cpu_pct,
      mem_rss,
      mem_tot: info.cgroup?.mem_stat?.hierarchical_memory_limit,
      disk_usage: info.disk_usage?.project?.usage,
      nprocs,
    },
    processes: topProcessesByUsage(info.processes, topN),
  };
}

interface Api {
  get: () => Promise<ProjectInfo | null>;
  getHistory: (opts?: { minutes?: number }) => Promise<ProjectInfoHistory>;
}

export async function get({ project_id }: { project_id: string }) {
  const c = await conat();
  const subject = getSubject({ project_id });
  return await c.call(subject).get();
}

export async function getHistory({
  project_id,
  minutes,
}: {
  project_id: string;
  minutes?: number;
}) {
  const c = await conat();
  const subject = getSubject({ project_id });
  return await c.call(subject).getHistory({ minutes });
}

function getSubject({ project_id }: { project_id: string }) {
  return projectSubject({
    project_id,
    service: SERVICE_NAME,
  });
}

export function createService(opts: {
  infoServer;
  project_id: string;
}) {
  return new ProjectInfoService(opts);
}

class ProjectInfoService {
  private infoServer?;
  private service?;
  private readonly subject: string;
  private readonly history: AKV<ProjectInfoHistorySample>;
  private readonly historyWindowMinutes: number;
  private readonly historySampleSeconds: number;
  private readonly historySampleMs: number;
  private readonly historyTTLms: number;
  private readonly historyTopN: number;
  private lastHistoryBucket?: number;
  info?: ProjectInfo | null = null;

  constructor({ infoServer, project_id }: { infoServer; project_id: string }) {
    logger.debug("register");
    this.subject = getSubject({ project_id });
    this.historyWindowMinutes = envInt(
      "COCALC_PROJECT_INFO_HISTORY_WINDOW_MINUTES",
      DEFAULT_HISTORY_WINDOW_MINUTES,
      1,
    );
    this.historySampleSeconds = envInt(
      "COCALC_PROJECT_INFO_HISTORY_SAMPLE_SECONDS",
      DEFAULT_HISTORY_SAMPLE_SECONDS,
      0,
    );
    this.historySampleMs = this.historySampleSeconds * 1000;
    this.historyTTLms =
      envInt(
        "COCALC_PROJECT_INFO_HISTORY_TTL_SECONDS",
        DEFAULT_HISTORY_TTL_SECONDS,
        0,
      ) * 1000;
    this.historyTopN = envInt(
      "COCALC_PROJECT_INFO_HISTORY_TOP_N",
      DEFAULT_HISTORY_TOP_N,
      0,
    );
    this.history = akv<ProjectInfoHistorySample>({
      project_id,
      name: HISTORY_STORE_NAME,
      ephemeral: historyEphemeralDefault(),
    });
    logger.debug("history config", {
      historyWindowMinutes: this.historyWindowMinutes,
      historySampleSeconds: this.historySampleSeconds,
      historyTTLms: this.historyTTLms,
      historyTopN: this.historyTopN,
    });
    // initializing project info server + reacting when it has something to say
    this.infoServer = infoServer;
    this.infoServer.start();
    this.infoServer.on("info", this.saveInfo);
    this.createService();
  }

  private saveInfo = (info) => {
    this.info = info;
    void this.saveHistory(info);
  };

  private saveHistory = async (info: ProjectInfo | null | undefined) => {
    if (info == null) return;
    if (this.historySampleMs <= 0) return;
    const bucket = Math.floor(info.timestamp / this.historySampleMs);
    if (bucket === this.lastHistoryBucket) return;
    this.lastHistoryBucket = bucket;
    const key = sampleKey(bucket);
    const sample = makeHistorySample(info, this.historyTopN);
    try {
      await this.history.set(
        key,
        sample,
        this.historyTTLms > 0 ? { ttl: this.historyTTLms } : undefined,
      );
    } catch (err) {
      logger.debug("saveHistory failed", err);
    }
  };

  private getHistory = async ({
    minutes,
  }: {
    minutes?: number;
  }): Promise<ProjectInfoHistory> => {
    const windowMinutes = Math.min(
      this.historyWindowMinutes,
      Math.max(1, minutes ?? this.historyWindowMinutes),
    );
    if (this.historySampleMs <= 0) {
      return { generated_at: Date.now(), minutes: windowMinutes, samples: [] };
    }
    const wantedSamples = Math.max(
      1,
      Math.ceil((windowMinutes * 60 * 1000) / this.historySampleMs),
    );
    try {
      const keys = (await this.history.keys()).filter((key) =>
        key.startsWith(HISTORY_PREFIX),
      );
      keys.sort();
      const selected = keys.slice(-wantedSamples);
      const samples = (
        await Promise.all(selected.map((key) => this.history.get(key)))
      )
        .filter((sample): sample is ProjectInfoHistorySample => sample != null)
        .sort((a, b) => a.timestamp - b.timestamp);
      return {
        generated_at: Date.now(),
        minutes: windowMinutes,
        samples,
      };
    } catch (err) {
      logger.debug("getHistory failed", err);
      return { generated_at: Date.now(), minutes: windowMinutes, samples: [] };
    }
  };

  private createService = async () => {
    logger.debug("started project info service ", { subject: this.subject });
    const client = await conat();
    this.service = await client.service<Api>(this.subject, {
      get: async () => this.info ?? null,
      getHistory: async ({ minutes } = {}) => await this.getHistory({ minutes }),
    });
  };

  close = (): void => {
    if (this.infoServer == null) {
      return;
    }
    logger.debug("close");
    this.infoServer?.removeListener("info", this.saveInfo);
    delete this.infoServer;
    this.service?.close();
    delete this.service;
    this.history.close();
  };
}
