/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { uptime } from "node:os";
import { ProcessStats } from "@cocalc/backend/process-stats";
import { getLogger } from "@cocalc/project/logger";
import type { Processes, ProjectInfoScope } from "@cocalc/util/types/project-info/types";

const logger = getLogger("project-info:snapshot");

export interface ProcessSnapshot {
  procs?: Processes;
  uptime: number;
  boottime: Date;
  scope: ProjectInfoScope;
  process_count: {
    visible: number;
    total?: number;
  };
}

export interface ProcessSnapshotProvider {
  readonly scope: ProjectInfoScope;
  init: (opts: { testing: boolean }) => Promise<void>;
  snapshot: (timestamp: number) => Promise<ProcessSnapshot>;
}

function nowUptime() {
  const up = uptime();
  return { uptime: up, boottime: new Date(Date.now() - up * 1000) };
}

class AllProcessSnapshotProvider implements ProcessSnapshotProvider {
  readonly scope: ProjectInfoScope = "all";
  private readonly processStats = ProcessStats.getInstance();

  async init({ testing }: { testing: boolean }) {
    if (testing) {
      this.processStats.setTesting(true);
    }
    await this.processStats.init();
  }

  async snapshot(timestamp: number): Promise<ProcessSnapshot> {
    const { procs, uptime, boottime } = await this.processStats.processes(timestamp);
    const visible = Object.keys(procs).length;
    return {
      scope: this.scope,
      procs,
      uptime,
      boottime,
      process_count: { visible, total: visible },
    };
  }
}

class OffProcessSnapshotProvider implements ProcessSnapshotProvider {
  readonly scope: ProjectInfoScope = "off";

  async init(_opts: { testing: boolean }) {}

  async snapshot(_timestamp: number): Promise<ProcessSnapshot> {
    const { uptime, boottime } = nowUptime();
    return {
      scope: this.scope,
      uptime,
      boottime,
      process_count: { visible: 0, total: 0 },
    };
  }
}

export function getProjectInfoScopeFromEnv(): ProjectInfoScope {
  const scope = process.env.COCALC_PROJECT_INFO_SCOPE?.trim().toLowerCase();
  if (scope === "off") return "off";
  if (scope === "owned") {
    logger.debug(
      "COCALC_PROJECT_INFO_SCOPE=owned requested; falling back to all until owned provider is enabled",
    );
  }
  return "all";
}

export function createProcessSnapshotProvider(opts?: {
  scope?: ProjectInfoScope;
}): ProcessSnapshotProvider {
  switch (opts?.scope) {
    case "off":
      return new OffProcessSnapshotProvider();
    case "owned":
    case "all":
    default:
      return new AllProcessSnapshotProvider();
  }
}
