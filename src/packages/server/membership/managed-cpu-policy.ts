/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getEffectiveMembershipUsageLimits } from "@cocalc/server/membership/effective-limits";
import { getManagedCpuUsageForAccount } from "@cocalc/server/membership/managed-cpu";
import { getProjectUsageAccountId } from "@cocalc/server/membership/project-usage";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";

export interface ManagedProjectCpuPolicy {
  account_id?: string;
  allowed: boolean;
  blocked_by?: "5h" | "7d";
  managed_cpu_5h_seconds?: number;
  managed_cpu_7d_seconds?: number;
  managed_cpu_5h_reset_at?: Date;
  managed_cpu_7d_reset_at?: Date;
  managed_cpu_5h_reset_in?: string;
  managed_cpu_7d_reset_in?: string;
  cpu_5h_seconds?: number;
  cpu_7d_seconds?: number;
}

export async function getManagedProjectCpuPolicy(opts: {
  account_id?: string;
  project_id?: string;
}): Promise<ManagedProjectCpuPolicy> {
  const project_id = `${opts.project_id ?? ""}`.trim() || undefined;
  const account_id =
    `${opts.account_id ?? ""}`.trim() ||
    (project_id ? await getProjectUsageAccountId(project_id) : undefined);
  if (!account_id) {
    return { allowed: true };
  }
  const resolution = await resolveMembershipForAccount(account_id);
  const effectiveLimits = getEffectiveMembershipUsageLimits(resolution);
  const cpu_5h_seconds = effectiveLimits.cpu_5h_seconds;
  const cpu_7d_seconds = effectiveLimits.cpu_7d_seconds;
  const usage = await getManagedCpuUsageForAccount({
    account_id,
    limit5h: cpu_5h_seconds,
    limit7d: cpu_7d_seconds,
  });
  const blocked_by = usage.over_managed_cpu_5h
    ? "5h"
    : usage.over_managed_cpu_7d
      ? "7d"
      : undefined;
  return {
    account_id,
    allowed: blocked_by == null,
    blocked_by,
    managed_cpu_5h_seconds: usage.managed_cpu_5h_seconds,
    managed_cpu_7d_seconds: usage.managed_cpu_7d_seconds,
    managed_cpu_5h_reset_at: usage.managed_cpu_5h_reset_at,
    managed_cpu_7d_reset_at: usage.managed_cpu_7d_reset_at,
    managed_cpu_5h_reset_in: usage.managed_cpu_5h_reset_in,
    managed_cpu_7d_reset_in: usage.managed_cpu_7d_reset_in,
    cpu_5h_seconds,
    cpu_7d_seconds,
  };
}

function formatCpuHours(seconds: number | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "0";
  const hours = seconds / 3600;
  if (hours >= 100) return hours.toFixed(0);
  if (hours >= 10) return hours.toFixed(1);
  return hours.toFixed(2);
}

export function formatManagedProjectCpuPolicyBlockMessage(
  policy: ManagedProjectCpuPolicy,
): string {
  const window = policy.blocked_by === "5h" ? "5-hour" : "7-day";
  const used =
    policy.blocked_by === "5h"
      ? policy.managed_cpu_5h_seconds
      : policy.managed_cpu_7d_seconds;
  const limit =
    policy.blocked_by === "5h" ? policy.cpu_5h_seconds : policy.cpu_7d_seconds;
  const reset =
    policy.blocked_by === "5h"
      ? policy.managed_cpu_5h_reset_in
      : policy.managed_cpu_7d_reset_in;
  const resetText = reset ? ` The window begins freeing up in ${reset}.` : "";
  return `This account has used ${formatCpuHours(used)} of ${formatCpuHours(limit)} CPU-hours in its rolling ${window} compute budget.${resetText} Existing running projects are not stopped, but starting another project is paused until the budget window frees up or the account is upgraded.`;
}
