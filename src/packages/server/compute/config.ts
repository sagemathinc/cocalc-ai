/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getServerSettings } from "@cocalc/database/settings/server-settings";

export type ComputeVmMode =
  | "disabled"
  | "reconcile_only"
  | "admin_canary"
  | "enabled";

export type ComputeEnvironment = "development" | "staging" | "production";

export interface ComputeVmConfig {
  mode: ComputeVmMode;
  environment: ComputeEnvironment;
  emergency_stop: boolean;
  admin_allowlist: Set<string>;
  gcp_service_account_json?: string;
  gcp_project_id?: string;
  gcp_network?: string;
  gcp_network_tag: string;
  // Explicit IPv4 CIDRs that may reach managed VMs on tcp:22. Never
  // 0.0.0.0/0; empty means unconfigured, and the network check fails closed.
  ssh_source_ranges: string[];
  staging_legacy_provider: boolean;
  max_active_per_account: number;
  max_active_total: number;
  max_ttl_minutes: number;
  max_boot_disk_gb: number;
  max_volumes_per_account: number;
  max_volume_gb: number;
  unfunded_volume_delete_days: number;
  unfunded_volume_max_exposure_usd: number;
}

type Settings = Record<string, any>;

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  return Math.floor(positiveNumber(value, fallback));
}

function booleanValue(value: unknown): boolean {
  return value === true || `${value ?? ""}`.trim().toLowerCase() === "yes";
}

function environmentFromSettings(settings: Settings): ComputeEnvironment {
  const forced = `${process.env.COCALC_COMPUTE_VM_ENVIRONMENT ?? ""}`
    .trim()
    .toLowerCase();
  if (["development", "staging", "production"].includes(forced)) {
    return forced as ComputeEnvironment;
  }
  const dns = `${settings.dns ?? ""}`.trim().toLowerCase();
  if (dns === "cocalc.ai" || dns === "www.cocalc.ai") return "production";
  if (dns.includes("staging")) return "staging";
  return "development";
}

function parseMode(
  value: unknown,
  environment: ComputeEnvironment,
): { mode: ComputeVmMode; automatic: boolean } {
  const raw = `${value ?? "auto"}`.trim().toLowerCase() || "auto";
  if (raw === "auto") {
    return {
      mode: environment === "production" ? "disabled" : "admin_canary",
      automatic: true,
    };
  }
  if (
    raw !== "disabled" &&
    raw !== "reconcile_only" &&
    raw !== "admin_canary" &&
    raw !== "enabled"
  ) {
    throw new Error(`invalid managed compute VM mode '${value}'`);
  }
  return { mode: raw, automatic: false };
}

function parseAllowlist(value: unknown): Set<string> {
  return new Set(
    `${value ?? ""}`
      .split(/[\s,]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

function parseServiceAccount(value: unknown): {
  json?: string;
  project_id?: string;
} {
  const json = `${value ?? ""}`.trim();
  if (!json) return {};
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("managed compute VM GCP service account JSON is invalid");
  }
  const project_id = `${parsed?.project_id ?? ""}`.trim();
  if (!project_id || !`${parsed?.client_email ?? ""}`.trim()) {
    throw new Error(
      "managed compute VM GCP service account JSON must include project_id and client_email",
    );
  }
  return { json, project_id };
}

// The narrowest prefix accepted for an SSH source range. Our own addresses are
// single hosts (/32) or small provider blocks; anything wider is treated as
// public.
export const MIN_SSH_SOURCE_PREFIX = 16;

export function parseSshSourceRange(value: string): string {
  const match = value
    .trim()
    .match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!match) {
    throw new Error(
      `managed compute SSH source range '${value}' must be an IPv4 CIDR`,
    );
  }
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((octet) => octet > 255) || prefix > 32) {
    throw new Error(
      `managed compute SSH source range '${value}' is not a valid IPv4 CIDR`,
    );
  }
  if (prefix < MIN_SSH_SOURCE_PREFIX) {
    throw new Error(
      `managed compute SSH source range '${value}' is wider than /${MIN_SSH_SOURCE_PREFIX}`,
    );
  }
  const address = octets.reduce((acc, octet) => acc * 256 + octet, 0);
  const size = 2 ** (32 - prefix);
  if (address % size !== 0) {
    throw new Error(
      `managed compute SSH source range '${value}' has host bits set`,
    );
  }
  return `${octets.join(".")}/${prefix}`;
}

export function parseSshSourceRanges(value: unknown): string[] {
  const ranges = `${value ?? ""}`
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseSshSourceRange);
  return Array.from(new Set(ranges)).sort();
}

export function resolveComputeVmConfig(settings: Settings): ComputeVmConfig {
  const environment = environmentFromSettings(settings);
  const { mode, automatic } = parseMode(settings.compute_vm_mode, environment);
  const serviceAccount = parseServiceAccount(
    settings.compute_vm_gcp_service_account_json,
  );
  const gcpNetworkTag =
    `${settings.compute_vm_gcp_network_tag ?? ""}`.trim() ||
    "cocalc-compute-vm";
  const gcpNetwork = `${settings.compute_vm_gcp_network ?? ""}`.trim();
  const staging_legacy_provider =
    automatic && environment === "staging" && serviceAccount.json == null;

  return {
    mode,
    environment,
    emergency_stop: booleanValue(settings.compute_vm_emergency_stop),
    admin_allowlist: parseAllowlist(settings.compute_vm_admin_allowlist),
    gcp_service_account_json: serviceAccount.json,
    gcp_project_id: serviceAccount.project_id,
    gcp_network: gcpNetwork || undefined,
    gcp_network_tag: gcpNetworkTag,
    ssh_source_ranges: parseSshSourceRanges(
      settings.compute_vm_ssh_source_ranges,
    ),
    staging_legacy_provider,
    max_active_per_account: positiveInteger(
      settings.compute_vm_max_active_per_project,
      10,
    ),
    max_active_total: positiveInteger(
      settings.compute_vm_max_active_total,
      1_000,
    ),
    max_ttl_minutes: positiveInteger(
      settings.compute_vm_max_ttl_minutes,
      24 * 60,
    ),
    max_boot_disk_gb: positiveInteger(
      settings.compute_vm_max_boot_disk_gb,
      10_000,
    ),
    max_volumes_per_account: positiveInteger(
      settings.compute_vm_max_volumes_per_account,
      10,
    ),
    max_volume_gb: positiveInteger(settings.compute_vm_max_volume_gb, 10_000),
    unfunded_volume_delete_days: positiveNumber(
      settings.compute_vm_unfunded_volume_delete_days,
      30,
    ),
    unfunded_volume_max_exposure_usd: positiveNumber(
      settings.compute_vm_unfunded_volume_max_exposure_usd,
      100,
    ),
  };
}

export function computeVmUiEnabled(settings: Settings): boolean {
  try {
    const environment = environmentFromSettings(settings);
    const { mode } = parseMode(settings.compute_vm_mode, environment);
    return mode === "admin_canary" || mode === "enabled";
  } catch {
    return false;
  }
}

export async function getComputeVmConfig(): Promise<ComputeVmConfig> {
  return resolveComputeVmConfig((await getServerSettings()) as Settings);
}

export function requireComputeVmCreateAllowed(
  config: ComputeVmConfig,
  accountId: string,
): void {
  if (config.emergency_stop) {
    throw Object.assign(
      new Error("managed compute VM emergency stop is active"),
      { code: 503 },
    );
  }
  if (config.mode !== "admin_canary" && config.mode !== "enabled") {
    throw Object.assign(
      new Error(
        config.mode === "disabled" || config.mode === "reconcile_only"
          ? "managed compute VM creation is disabled"
          : "managed compute VM creation is unavailable",
      ),
      { code: 503 },
    );
  }
  if (
    config.mode === "admin_canary" &&
    !config.staging_legacy_provider &&
    !config.admin_allowlist.has(accountId.toLowerCase())
  ) {
    throw Object.assign(
      new Error("account is not allowlisted for the managed compute VM canary"),
      { code: 403 },
    );
  }
  if (config.environment === "production") {
    if (!config.gcp_service_account_json || !config.gcp_project_id) {
      throw new Error(
        "managed compute VM production credentials are not configured",
      );
    }
    if (!config.gcp_network) {
      throw new Error(
        "managed compute VM production network is not configured",
      );
    }
    const networkProject = config.gcp_network.match(
      /^projects\/([^/]+)\/global\/networks\/[^/]+$/,
    )?.[1];
    if (networkProject !== config.gcp_project_id) {
      throw new Error(
        "managed compute VM network must be a global VPC in the dedicated credential project",
      );
    }
  }
}

export function requireComputeVmStartAllowed(
  config: ComputeVmConfig,
  accountId: string,
): void {
  requireComputeVmCreateAllowed(config, accountId);
}
