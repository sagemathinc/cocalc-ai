/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The metadata a project-host sends to the bay in register and heartbeat
// reports, assembled from already-read inputs. Pure (no I/O, no clock), so
// the bay's tests can run the real assembly (server/conat
// host-report-metadata.test.ts) and check that an honest report passes the
// bay's allow-list and budgets unchanged. master.ts reads the inputs and
// calls these functions.

export interface HostBaseMetadataInput {
  runnerId: string;
  host_session_id: string;
  host_boot_id: string | undefined;
  host_session_started_at: string;
  host_boot_started_at: string;
  host_cpu_count: number;
  host_ram_gb: number;
}

// The metadata fixed for the life of the project-host process.
export function buildHostBaseMetadata(input: HostBaseMetadataInput) {
  return {
    runnerId: input.runnerId,
    host_session_id: input.host_session_id,
    host_boot_id: input.host_boot_id,
    host_session_started_at: input.host_session_started_at,
    host_boot_started_at: input.host_boot_started_at,
    host_cpu_count: input.host_cpu_count,
    host_ram_gb: input.host_ram_gb,
  };
}

export interface HostReportMetadataInput {
  base: Record<string, unknown> | undefined;
  cloudflared: unknown;
  host_uptime_s: number;
  currentMetrics: unknown;
  pressureState: unknown;
  placementSnapshot: unknown;
  bootstrapLifecycle: unknown;
  host_agent: unknown;
  runtime_health: unknown;
  acp_worker_health: unknown;
  bees: unknown;
  host_integrity: unknown;
  runtime_uid_mode: unknown;
  observed_components: unknown;
  rootfs_scanner: unknown;
  software: { project_host?: string } & Record<string, unknown>;
  software_inventory: unknown;
  agent_rpc_report_version: number;
  content_origin_domain: string | null | undefined;
}

// The metadata of one register or heartbeat report.
export function buildHostReportMetadata(input: HostReportMetadataInput) {
  return {
    ...(input.base ?? {}),
    cloudflared_restart_supported: true,
    cloudflared_diagnostics_supported: true,
    cloudflared: input.cloudflared,
    host_uptime_s: input.host_uptime_s,
    ...(input.currentMetrics
      ? {
          metrics: {
            current: input.currentMetrics,
          },
        }
      : {}),
    ...(input.pressureState ? { pressure: input.pressureState } : {}),
    ...(input.placementSnapshot ? { placement: input.placementSnapshot } : {}),
    ...(input.bootstrapLifecycle
      ? {
          bootstrap_lifecycle: input.bootstrapLifecycle,
        }
      : {}),
    host_agent: input.host_agent,
    runtime_health: input.runtime_health,
    acp_worker_health: input.acp_worker_health,
    bees: input.bees,
    host_integrity: input.host_integrity,
    // R1: which host uid projects run their user as (keep-id or a
    // separate uid), why, whether sidecars follow yet, and whether the
    // daemon state stayed private after a separate start.
    runtime_uid_mode: input.runtime_uid_mode,
    observed_components: input.observed_components,
    rootfs_scanner: input.rootfs_scanner,
    software: input.software,
    software_inventory: input.software_inventory,
    // The delivery reports this host can render (the hub downgrades or
    // holds others for it). Tied to this build: the hub merges heartbeat
    // metadata, so after a rollback a stale value must not count.
    agent_rpc_report: {
      version: input.agent_rpc_report_version,
      project_host: input.software.project_host ?? null,
    },
    // The content domain this host actually serves (null when off), so
    // the hub only issues content links the host will accept.
    content_origin_domain: input.content_origin_domain ?? null,
  };
}
