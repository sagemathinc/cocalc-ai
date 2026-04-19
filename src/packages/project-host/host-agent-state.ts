/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import fs from "node:fs";
import path from "node:path";

export type ProjectHostRollbackPending = {
  target_version: string;
  previous_version: string;
  started_at: string;
  deadline_at: string;
};

export type ProjectHostRollbackRecord = {
  target_version: string;
  rollback_version: string;
  started_at: string;
  finished_at: string;
  reason: "health_deadline_exceeded";
};

export type HostAgentState = {
  project_host?: {
    last_known_good_version?: string;
    pending_rollout?: ProjectHostRollbackPending;
    last_automatic_rollback?: ProjectHostRollbackRecord;
  };
};

export function resolveHostAgentDataDir(dataDir?: string): string {
  return (
    `${dataDir ?? process.env.COCALC_DATA ?? process.env.DATA ?? ""}`.trim() ||
    "/mnt/cocalc/data"
  );
}

export function hostAgentStateFilePath(dataDir?: string): string {
  return path.join(resolveHostAgentDataDir(dataDir), "host-agent-state.json");
}

export function readHostAgentState(dataDir?: string): HostAgentState {
  try {
    return JSON.parse(fs.readFileSync(hostAgentStateFilePath(dataDir), "utf8"));
  } catch {
    return {};
  }
}

export function writeHostAgentState(
  dataDir: string,
  state: HostAgentState,
): void {
  const file = hostAgentStateFilePath(dataDir);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
