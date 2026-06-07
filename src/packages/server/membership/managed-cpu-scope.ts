/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";

export type ManagedCpuAccountingScope =
  | "shared_managed"
  | "site_funded_dedicated"
  | "account_funded_dedicated"
  | "local_or_self_host"
  | "unknown";

export type ManagedCpuHostFundingMode =
  | "account-prepaid"
  | "account-postpaid"
  | "site-funded";

export interface ManagedCpuAccountingClassification {
  scope: ManagedCpuAccountingScope;
  counts_toward_managed_cpu_budget: boolean;
  host_funding_mode_snapshot?: ManagedCpuHostFundingMode;
  host_tier_snapshot?: number;
  host_kind_snapshot?: string;
}

type HostClassificationInput = {
  metadata?: any;
  tier?: number | string | null;
  missing?: boolean;
};

function normalizeFundingMode(
  value: unknown,
): ManagedCpuHostFundingMode | undefined {
  const mode = `${value ?? ""}`.trim().toLowerCase();
  if (
    mode === "account-prepaid" ||
    mode === "account-postpaid" ||
    mode === "site-funded"
  ) {
    return mode;
  }
}

function normalizeTier(value: unknown): number | undefined {
  if (value == null) return;
  const tier = Number(value);
  return Number.isFinite(tier) ? tier : undefined;
}

function getLocalOrSelfHostKind(metadata: any): string | undefined {
  const machine = metadata?.machine ?? {};
  const machineCloud = `${machine?.cloud ?? ""}`.trim().toLowerCase();
  const selfHostMode = `${machine?.metadata?.self_host_mode ?? ""}`
    .trim()
    .toLowerCase();
  const provider = `${metadata?.provider ?? ""}`.trim().toLowerCase();
  const cloudProvider = `${metadata?.cloud_provider ?? ""}`
    .trim()
    .toLowerCase();
  const metadataCloud = `${metadata?.cloud ?? ""}`.trim().toLowerCase();

  if (provider === "star" || cloudProvider === "star") {
    return "star";
  }
  if (metadata?.local === true || metadataCloud === "local") {
    return "local";
  }
  if (machineCloud === "self-host") {
    return selfHostMode ? `self-host:${selfHostMode}` : "self-host:local";
  }
  if (machineCloud === "local") {
    return "local";
  }
}

export function classifyManagedCpuAccountingScopeFromHost(
  host: HostClassificationInput | undefined,
): ManagedCpuAccountingClassification {
  if (!host || host.missing) {
    return {
      scope: "unknown",
      counts_toward_managed_cpu_budget: true,
      host_kind_snapshot: "missing-host",
    };
  }

  const metadata = host.metadata ?? {};
  const fundingMode = normalizeFundingMode(metadata?.billing?.funding_mode);
  const tier = normalizeTier(host.tier);
  const localOrSelfHostKind = getLocalOrSelfHostKind(metadata);

  if (localOrSelfHostKind) {
    return {
      scope: "local_or_self_host",
      counts_toward_managed_cpu_budget: false,
      host_funding_mode_snapshot: fundingMode,
      host_tier_snapshot: tier,
      host_kind_snapshot: localOrSelfHostKind,
    };
  }

  if (fundingMode === "account-prepaid" || fundingMode === "account-postpaid") {
    return {
      scope: "account_funded_dedicated",
      counts_toward_managed_cpu_budget: false,
      host_funding_mode_snapshot: fundingMode,
      host_tier_snapshot: tier,
      host_kind_snapshot: "account-funded-dedicated",
    };
  }

  if (fundingMode === "site-funded") {
    return {
      scope: "site_funded_dedicated",
      counts_toward_managed_cpu_budget: true,
      host_funding_mode_snapshot: fundingMode,
      host_tier_snapshot: tier,
      host_kind_snapshot: "site-funded-dedicated",
    };
  }

  if (tier != null) {
    return {
      scope: "shared_managed",
      counts_toward_managed_cpu_budget: true,
      host_tier_snapshot: tier,
      host_kind_snapshot: "shared-tiered-host",
    };
  }

  return {
    scope: "unknown",
    counts_toward_managed_cpu_budget: true,
    host_tier_snapshot: tier,
    host_kind_snapshot: "unclassified-host",
  };
}

export async function getManagedCpuAccountingClassificationForHost(opts: {
  host_id?: string;
  project_id?: string;
}): Promise<ManagedCpuAccountingClassification> {
  const host_id = `${opts.host_id ?? ""}`.trim();
  if (host_id) {
    const { rows } = await getPool("short").query<{
      tier: number | null;
      metadata: any;
    }>(
      "SELECT tier, metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL LIMIT 1",
      [host_id],
    );
    return classifyManagedCpuAccountingScopeFromHost(
      rows[0] ? { tier: rows[0].tier, metadata: rows[0].metadata } : undefined,
    );
  }

  const project_id = `${opts.project_id ?? ""}`.trim();
  if (project_id) {
    const { rows } = await getPool("short").query<{
      tier: number | null;
      metadata: any;
    }>(
      `
        SELECT project_hosts.tier, project_hosts.metadata
        FROM projects
        LEFT JOIN project_hosts
          ON project_hosts.id = projects.host_id
         AND project_hosts.deleted IS NULL
        WHERE projects.project_id=$1
        LIMIT 1
      `,
      [project_id],
    );
    return classifyManagedCpuAccountingScopeFromHost(
      rows[0] && rows[0].metadata != null
        ? { tier: rows[0].tier, metadata: rows[0].metadata }
        : undefined,
    );
  }

  return classifyManagedCpuAccountingScopeFromHost(undefined);
}

export async function countsTowardManagedCpuBudgetForHost(opts: {
  host_id?: string;
  project_id?: string;
}): Promise<boolean> {
  return (await getManagedCpuAccountingClassificationForHost(opts))
    .counts_toward_managed_cpu_budget;
}
