/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Shared by host-report-metadata.test.ts and host-registry.test.ts.

// Top-level metadata keys the bay writes (every jsonb path, `- 'key'` and
// metadata.key assignment in server/database code that touches project_hosts,
// plus the keys the bay writes through upsertProjectHost on host create and
// provider reconcile). None may come from a host report.
export const BAY_OWNED_METADATA_KEYS = [
  "admin_reopen_reservation",
  "billing",
  "cloud_provider",
  "cloudflare_tunnel",
  "content_dns",
  "desired_state",
  "dns",
  "dns_reconciliation",
  "ip_address",
  "last_action",
  "last_action_at",
  "last_action_error",
  "last_action_status",
  "legacy_migration_disabled_reason",
  "local",
  "machine",
  "machine_change_pending",
  "planned_project_host_transition",
  "provider",
  "public_ip",
  "public_route",
  "public_route_auto_recovery",
  "public_route_incidents",
  "public_route_probe",
  "public_url",
  "renewal_interval",
  "restart_recovery",
  "runtime",
  "runtime_auto_recovery",
  "runtime_deployments",
  "runtime_synthetic_probe",
  "self_host",
  "shutdown_notice",
  "spot_recovery_policy",
  "spot_recovery_state",
  "storage_admission_mode",
] as const;

// A report as a bd0131eb project-host sends it (project-host/master.ts
// basePayload.metadata + buildPayload metadata), with representative values.
export function hostReportFixture(): Record<string, unknown> {
  return {
    runnerId: "runner-1",
    host_session_id: "session-1",
    host_boot_id: "boot-1",
    host_session_started_at: "2026-11-13T00:00:00.000Z",
    host_boot_started_at: "2026-11-12T00:00:00.000Z",
    host_cpu_count: 8,
    host_ram_gb: 32,
    host_uptime_s: 1234,
    cloudflared_restart_supported: true,
    cloudflared_diagnostics_supported: true,
    cloudflared: { state: "ok", checked_at: "2026-11-13T00:00:00.000Z" },
    metrics: {
      current: {
        collected_at: "2026-11-13T00:00:00.000Z",
        memory_used_percent: 72.2,
        memory_total_bytes: 34359738368,
        io_containment: { policy_mode: "enforce", capabilities: ["io.max"] },
      },
    },
    pressure: { zone: "normal", evaluated_at_ms: 1, candidate_count: 0 },
    placement: {
      observed_at: "2026-11-13T00:00:00.000Z",
      cached_rootfs_images: ["img-a", "img-b"],
      rootfs_cache_truncated: false,
    },
    bootstrap_lifecycle: { phase: "ready" },
    host_agent: { project_host: { last_known_good_version: "v1" } },
    runtime_health: { ready: true, status: "ok" },
    acp_worker_health: { ok: true },
    bees: { state: "running" },
    host_integrity: { ok: true },
    runtime_uid_mode: { mode: "keep-id" },
    observed_components: [{ component: "acp-worker", state: "running" }],
    rootfs_scanner: { state: "ready" },
    software: { project_host: "v1", project_bundle: "b1", tools: "t1" },
    software_inventory: [{ artifact: "project-host", current_version: "v1" }],
    agent_rpc_report: { version: 1, project_host: "v1" },
    content_origin_domain: null,
  };
}
