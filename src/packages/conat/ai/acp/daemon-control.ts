/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Client as ConatClient } from "@cocalc/conat/core/client";

export type AcpDaemonState = "active" | "draining" | "stopped";

export interface AcpDaemonStatus {
  worker_id: string;
  host_id: string;
  pid: number;
  bundle_version: string;
  bundle_path: string;
  state: AcpDaemonState;
  started_at: number;
  last_heartbeat_at: number;
  last_seen_running_jobs: number;
  last_queue_progress_at: number;
  running_turn_leases: number;
  live_app_server_runtimes?: number;
  background_terminal_processes?: number;
  exit_requested_at?: number | null;
  stop_reason?: string | null;
}

export interface AcpProjectFenceResult {
  project_id: string;
  queued_jobs: number;
  running_jobs: number;
  running_turns: number;
  queued_payloads: number;
  disposed_agents: number;
}

interface AcpDaemonControlApi {
  health: () => Promise<AcpDaemonStatus>;
  requestDrain: (opts?: { reason?: string | null }) => Promise<AcpDaemonStatus>;
  fenceProject: (opts: {
    project_id: string;
    reason: string;
  }) => Promise<AcpProjectFenceResult>;
}

export function acpDaemonControlSubject({
  host_id,
  worker_id,
}: {
  host_id: string;
  worker_id: string;
}): string {
  return `hub.host.${host_id}.acp-worker.${worker_id}`;
}

function requireExplicitConatClient(client?: ConatClient): ConatClient {
  if (client != null) {
    return client;
  }
  throw new Error("must provide an explicit Conat client");
}

export function acpDaemonControlClient({
  client,
  host_id,
  worker_id,
  timeout,
  waitForInterest = false,
}: {
  client?: ConatClient;
  host_id: string;
  worker_id: string;
  timeout?: number;
  waitForInterest?: boolean;
}): AcpDaemonControlApi {
  return requireExplicitConatClient(client).call<AcpDaemonControlApi>(
    acpDaemonControlSubject({ host_id, worker_id }),
    { timeout, waitForInterest },
  );
}

export async function initAcpDaemonControlService({
  client,
  host_id,
  worker_id,
  getStatus,
  requestDrain,
  fenceProject,
}: {
  client: ConatClient;
  host_id: string;
  worker_id: string;
  getStatus: () => Promise<AcpDaemonStatus> | AcpDaemonStatus;
  requestDrain: (opts?: {
    reason?: string | null;
  }) => Promise<AcpDaemonStatus> | AcpDaemonStatus;
  fenceProject: (opts: {
    project_id: string;
    reason: string;
  }) => Promise<AcpProjectFenceResult> | AcpProjectFenceResult;
}) {
  return await client.service<AcpDaemonControlApi>(
    acpDaemonControlSubject({ host_id, worker_id }),
    {
      async health() {
        return await getStatus();
      },
      async requestDrain(opts?: { reason?: string | null }) {
        return await requestDrain(opts);
      },
      async fenceProject(opts: { project_id: string; reason: string }) {
        return await fenceProject(opts);
      },
    },
  );
}
