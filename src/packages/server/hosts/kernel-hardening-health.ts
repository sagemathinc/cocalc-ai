/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Admin health view of the kernel attack-surface settings that each running
// project host reports in its metrics (kernel_sysctls.hardening, see
// project-host/host-sysctl.ts). A package update, a container runtime change
// or a new image default could remove one of them silently; this makes that
// visible.

import getPool from "@cocalc/database/pool";
import type { HostKernelHardeningSnapshot } from "@cocalc/conat/hub/api/hosts";
import type { LaunchHealthLevel } from "@cocalc/conat/hub/api/system";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { PROJECT_HOST_KERNEL_HARDENING } from "@cocalc/conat/project-host/kernel-hardening";

const HOST_ONLINE_WINDOW_MS = 5 * 60 * 1000;

export interface HostKernelHardeningSummary {
  active_hosts: number;
  // Hosts whose software predates the report.
  unreported_hosts: number;
  failing: { host_id: string; host_name: string | null; failed: string[] }[];
}

type Row = {
  host_id: string;
  host_name: string | null;
  hardening: HostKernelHardeningSnapshot | null;
};

export function summarizeHostKernelHardening(
  rows: Row[],
): HostKernelHardeningSummary {
  const failing: HostKernelHardeningSummary["failing"] = [];
  let unreported = 0;
  for (const { host_id, host_name, hardening } of rows) {
    if (hardening == null) {
      unreported += 1;
      continue;
    }
    const checks = Array.isArray(hardening.checks) ? hardening.checks : [];
    const failed = checks
      .filter((check) => !check?.ok)
      .map(
        (check) =>
          `${check?.key}=${check?.actual ?? "missing"} (want ${check?.expected})`,
      );
    // A report that skips a setting, or says it is not ok without saying why,
    // is a reporting regression, not a pass.
    const reported = new Set(checks.map((check) => check?.key));
    for (const { key } of PROJECT_HOST_KERNEL_HARDENING) {
      if (!reported.has(key)) failed.push(`${key} not reported`);
    }
    if (hardening.ok !== true && failed.length === 0) {
      failed.push("report says not ok but lists no failed setting");
    }
    if (failed.length > 0) {
      failing.push({ host_id, host_name, failed });
    }
  }
  return { active_hosts: rows.length, unreported_hosts: unreported, failing };
}

export async function getHostKernelHardeningSummary(): Promise<HostKernelHardeningSummary> {
  const bayId = getConfiguredBayId();
  const { rows } = await getPool().query<Row>(
    `SELECT id AS host_id, name AS host_name,
       metadata->'metrics'->'current'->'kernel_sysctls'->'hardening' AS hardening
     FROM project_hosts
     WHERE deleted IS NULL
       AND status = 'running'
       AND last_seen >= NOW() - ($1::double precision * INTERVAL '1 millisecond')
       AND COALESCE(NULLIF(bay_id, ''), $2) = $2
     ORDER BY name, id`,
    [HOST_ONLINE_WINDOW_MS, bayId],
  );
  return summarizeHostKernelHardening(rows);
}

// Drift is a warning: the host is still confined by its other layers, but a
// default nobody asserts has gone away. Hosts that don't report it yet (older
// software) are counted, not flagged.
export function kernelHardeningHealth(
  result: PromiseSettledResult<HostKernelHardeningSummary>,
): { level: LaunchHealthLevel; summary: string; details: string[] } {
  if (result.status === "rejected") {
    return {
      level: "unknown",
      summary: "Unable to read project host kernel hardening reports.",
      details: [`${result.reason}`],
    };
  }
  const { active_hosts, unreported_hosts, failing } = result.value;
  const reporting = active_hosts - unreported_hosts;
  const unreported = unreported_hosts
    ? ` ${unreported_hosts} host${unreported_hosts === 1 ? " does" : "s do"} not report it yet.`
    : "";
  return {
    level: failing.length > 0 ? "warning" : "healthy",
    summary:
      failing.length > 0
        ? `${failing.length}/${reporting} reporting hosts have kernel hardening drift.${unreported}`
        : `${reporting}/${active_hosts} active hosts report the expected kernel hardening.${unreported}`,
    details: failing.map(
      ({ host_id, host_name, failed }) =>
        `${host_name ? `${host_name} (${host_id})` : host_id}: ${failed.join(", ")}`,
    ),
  };
}
