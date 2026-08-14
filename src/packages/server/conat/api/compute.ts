/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  ComputeCatalog,
  ComputeVolume,
  ComputeVm,
  CreateComputeVolumeRequest,
  CreateComputeVmRequest,
} from "@cocalc/conat/hub/api/compute";
import type { HostCatalogMachineType } from "@cocalc/conat/hub/api/hosts";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import getPool from "@cocalc/database/pool";
import { assertComputeProjectAssignedToHost } from "@cocalc/server/compute/host-authorization";
import { requireDangerousSessionAuth } from "./dangerous-session-auth";
import { resolveProjectReferenceAllowRemote } from "@cocalc/server/conat/project-remote-access";
import {
  addComputeVmSshPublicKey,
  allocateComputeVmPublicHostname,
  appendComputeEvent,
  enqueueComputeWork,
  insertComputeVm,
  listOwnedComputeVms,
  listProjectComputeVms,
  resolveProjectComputeVm,
  resolveOwnedComputeVm,
  updateComputeVm,
} from "@cocalc/server/compute/db";
import type { ComputeVmRow } from "@cocalc/server/compute/types";
import type { ComputeVolumeRow } from "@cocalc/server/compute/types";
import {
  normalizeManagedVmSshPublicKey,
  resolveManagedVmCreateSshAuthorization,
} from "@cocalc/server/compute/ssh-authorization";
import {
  ensureProviderComputeSshAccess,
  prepareProviderComputeWindowsRdp,
  deleteOrphanProviderComputeAddress,
  deleteOrphanProviderComputeBootDisk,
  deleteOrphanProviderComputeInstance,
  getProviderComputeRegions,
  requireProviderComputeSubnetwork,
  stopOrphanProviderComputeInstance,
} from "@cocalc/server/compute/provider";
import {
  approveAgentComputeGrant,
  listAgentComputeGrants,
  requireAgentComputeGrant,
  revokeAgentComputeGrant,
  type ComputeAgentAuth,
  type ComputeAgentGrantRequest,
} from "@cocalc/server/compute/turn-grants";
import { DEFAULT_SPOT_RECOVERY_POLICY } from "@cocalc/server/cloud/spot-restore";
import {
  getComputeVmConfig,
  requireComputeVmCreateAllowed,
  requireComputeVmStartAllowed,
} from "@cocalc/server/compute/config";
import {
  appendComputeVolumeEvent,
  insertComputeVolume,
  listOwnedComputeVolumes,
  listProjectComputeVolumes,
  resolveProjectComputeVolume,
  resolveOwnedComputeVolume,
  updateComputeVolume,
} from "@cocalc/server/compute/volume-db";
import {
  effectiveComputeVolumeSizeGb,
  NEBIUS_COMPUTE_VOLUME_INCREMENT_GB,
  validComputeVolumeSizeIncrement,
} from "@cocalc/server/compute/volume-size";
import { assertDedicatedHostAdmissionForAccount } from "@cocalc/server/project-host/admission";
import type { DedicatedHostFundingMode } from "@cocalc/server/project-host/admission";
import { estimateDedicatedHostRate } from "@cocalc/server/project-host/spend";
import {
  GCP_WINDOWS_SERVER_LICENSE_USD_PER_VCPU_HOUR,
  getDedicatedHostSurchargeFraction,
  gcpMachineArchitecture,
  gcpMachineGpu,
  gcpMinimumBootDiskGb,
  isSupportedCatalogGcpMachineType,
} from "@cocalc/util/project-host-pricing";
import { getCatalog as getHostCatalog } from "./hosts";
import { loadNebiusInstanceTypes } from "@cocalc/server/cloud/providers";
import { getManagedVmProjectSshPublicKey } from "@cocalc/server/projects/managed-vm-ssh-config";
import {
  defaultComputeZone,
  regionFromComputeZone,
  requireComputeZoneInRegions,
  restrictHostCatalogToRegions,
} from "@cocalc/server/compute/placement";
import {
  listComputeOrphans,
  updateComputeOrphan,
} from "@cocalc/server/compute/orphans";
import { deleteHostDns } from "@cocalc/server/cloud/dns";
import centralLog from "@cocalc/database/postgres/central-log";
import type { MoneyValue } from "@cocalc/util/money";

const MIN_VOLUME_GB = 10;
const HOURS_PER_MONTH = 730;

export function rateWithProviderCost<
  T extends {
    hourly_cost_usd: MoneyValue;
    pricing_snapshot: Record<string, any>;
  },
>(
  provider: "gcp" | "nebius",
  rate: T,
  settings: Record<string, any>,
): T & { provider_hourly_cost_usd: string } {
  const surcharge = getDedicatedHostSurchargeFraction(provider, settings);
  return {
    ...rate,
    provider_hourly_cost_usd: (
      Number(rate.hourly_cost_usd) /
      (1 + surcharge)
    ).toFixed(9),
  };
}

function requireAccount(accountId?: string) {
  const value = `${accountId ?? ""}`.trim();
  if (!value) throw new Error("must be signed in");
  return value;
}

function resolveComputeActor(
  opts: {
    account_id?: string;
    project_id?: string;
    agent_auth?: ComputeAgentAuth;
  },
  expectedProjectId?: string,
) {
  const accountId = requireAccount(
    opts.agent_auth?.account_id ?? opts.account_id,
  );
  if (opts.agent_auth) {
    const projectId = expectedProjectId ?? `${opts.project_id ?? ""}`.trim();
    if (!projectId || opts.agent_auth.project_id !== projectId) {
      throw Object.assign(
        new Error("managed-compute capability cannot cross projects"),
        { code: 403 },
      );
    }
  }
  return {
    accountId,
    actorKind: opts.agent_auth ? ("agent" as const) : ("human" as const),
  };
}

async function authorizeComputeMutation(opts: {
  actor: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string;
    agent_auth?: ComputeAgentAuth;
  };
  action: "availability" | "billable" | "destructive";
  project_id: string;
  vm_id?: string;
  request?: ComputeAgentGrantRequest;
  require_fresh_auth: boolean;
}) {
  if (opts.actor.agent_auth) {
    const semanticRequest = { ...(opts.request ?? {}) };
    delete semanticRequest.operation_id;
    const operationId = createHash("sha256")
      .update(opts.actor.agent_auth.token_fingerprint)
      .update("\0")
      .update(opts.action)
      .update("\0")
      .update(opts.project_id)
      .update("\0")
      .update(opts.vm_id ?? "")
      .update("\0")
      .update(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(semanticRequest).sort(([a], [b]) =>
              a.localeCompare(b),
            ),
          ),
        ),
      )
      .digest("hex");
    await requireAgentComputeGrant({
      auth: opts.actor.agent_auth,
      action: opts.action,
      project_id: opts.project_id,
      vm_id: opts.vm_id,
      request: { ...semanticRequest, operation_id: operationId },
    });
    return;
  }
  if (opts.require_fresh_auth) {
    await requireDangerousSessionAuth({
      account_id: requireAccount(opts.actor.account_id),
      browser_id: opts.actor.browser_id,
      session_hash: opts.actor.session_hash,
      require_second_factor: "if_enabled",
    });
  }
}

async function requireProjectMembership(accountId: string, projectId: string) {
  const project = await resolveProjectReferenceAllowRemote({
    account_id: accountId,
    project_id: projectId,
  });
  if (!project) {
    throw Object.assign(new Error("project not found or access denied"), {
      code: 403,
    });
  }
}

function normalizeName(value: string) {
  const name = `${value ?? ""}`.trim();
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) {
    throw new Error(
      "VM name must start with a letter and contain at most 32 lowercase letters, digits, or hyphens",
    );
  }
  return name;
}

function normalizeZone(value: string) {
  const zone = `${value ?? ""}`.trim().toLowerCase();
  if (!/^[a-z]+-[a-z]+\d-[a-z]$/.test(zone)) {
    throw new Error(`invalid GCP zone '${value}'`);
  }
  return zone;
}

function normalizeIdempotencyKey(value: string) {
  const key = `${value ?? ""}`.trim();
  if (!key || key.length > 200) {
    throw new Error(
      "idempotency_key is required and must be at most 200 bytes",
    );
  }
  return key;
}

function cachedEgressSummary(vm: ComputeVmRow) {
  const egress = vm.metadata?.billing?.egress ?? {};
  const updatedAt = egress.metered_through_at ?? null;
  const stale =
    !updatedAt || Date.now() - new Date(updatedAt).valueOf() > 20 * 60_000;
  const free = vm.provider === "nebius" || vm.funding_mode === "site-funded";
  return {
    current_month_bytes: Number(
      egress.current_month_bytes ?? egress.total_bytes ?? 0,
    ),
    current_month_cost_usd: `${egress.current_month_cost_usd ?? egress.total_cost_usd ?? "0"}`,
    lifetime_bytes: Number(egress.lifetime_bytes ?? egress.total_bytes ?? 0),
    lifetime_cost_usd: `${egress.lifetime_cost_usd ?? egress.total_cost_usd ?? "0"}`,
    unit_price_per_gb_usd: `${free ? 0 : (egress.unit_cost_usd_per_gb ?? 0.1)}`,
    free,
    updated_at: updatedAt,
    complete_through: updatedAt,
    stale,
    error: egress.error ?? null,
  };
}

async function egressSummary(vm: ComputeVmRow) {
  try {
    const { rows } = await getPool("medium").query(
      `WITH intervals AS (
         SELECT bytes::numeric AS bytes, amount_usd AS amount, ended_at
           FROM compute_egress_meter_intervals WHERE resource_id=$1
         UNION ALL
         SELECT quantity::numeric AS bytes, provider_cost_usd AS amount, ended_at
           FROM compute_site_funded_usage
          WHERE resource_id=$1 AND usage_kind='egress'
       )
       SELECT
         COALESCE(SUM(bytes),0)::text AS lifetime_bytes,
         COALESCE(SUM(amount),0)::text AS lifetime_cost,
         COALESCE(SUM(bytes) FILTER
           (WHERE ended_at >= date_trunc('month',NOW())),0)::text AS month_bytes,
         COALESCE(SUM(amount) FILTER
           (WHERE ended_at >= date_trunc('month',NOW())),0)::text AS month_cost,
         MAX(ended_at) AS complete_through
       FROM intervals`,
      [vm.id],
    );
    const row = rows[0] ?? {};
    const completeThrough = row.complete_through ?? null;
    const free = vm.provider === "nebius" || vm.funding_mode === "site-funded";
    return {
      current_month_bytes: Number(row.month_bytes ?? 0),
      current_month_cost_usd: free ? "0" : `${row.month_cost ?? "0"}`,
      lifetime_bytes: Number(row.lifetime_bytes ?? 0),
      lifetime_cost_usd: free ? "0" : `${row.lifetime_cost ?? "0"}`,
      unit_price_per_gb_usd: free ? "0" : "0.10",
      free,
      updated_at: completeThrough,
      complete_through: completeThrough,
      stale:
        !completeThrough ||
        Date.now() - new Date(completeThrough).valueOf() > 20 * 60_000,
      error: null,
    };
  } catch (err) {
    return {
      ...cachedEgressSummary(vm),
      stale: true,
      error: `authoritative egress ledger unavailable: ${err}`,
    };
  }
}

function managedVmSshAlias(vm: Pick<ComputeVmRow, "name">): string {
  return vm.name;
}

async function publicVm(vm: ComputeVmRow): Promise<ComputeVm> {
  const {
    ssh_public_key: _sshPublicKey,
    dns_record_id: _dnsRecordId,
    idempotency_key: _key,
    metadata,
    ...result
  } = vm;
  const { ssh_public_keys: _sshPublicKeys, ...publicMetadata } = metadata ?? {};
  return {
    ...result,
    operating_system: vm.operating_system ?? "linux",
    operating_system_version: vm.operating_system_version ?? "ubuntu-24.04",
    os_license_hourly_price: vm.os_license_hourly_price ?? "0.000000",
    private_ip: vm.metadata?.runtime?.private_ip ?? null,
    internal_hostname: vm.metadata?.runtime?.internal_hostname ?? null,
    egress_summary: await egressSummary(vm),
    ssh_alias: managedVmSshAlias(vm),
    metadata: publicMetadata,
  };
}

function publicVolume(volume: ComputeVolumeRow): ComputeVolume {
  const { idempotency_key: _key, ...result } = volume;
  return result;
}

async function resolveOwned(
  accountId: string,
  idOrName: string,
  includeDeleted = false,
) {
  const vm = await resolveOwnedComputeVm({
    owner_account_id: accountId,
    id_or_name: `${idOrName ?? ""}`.trim(),
    include_deleted: includeDeleted,
  });
  if (!vm) throw new Error(`compute VM '${idOrName}' not found`);
  return vm;
}

async function resolveOwnedVolume(
  accountId: string,
  idOrName: string,
  includeDeleted = false,
) {
  const volume = await resolveOwnedComputeVolume({
    owner_account_id: accountId,
    id_or_name: `${idOrName ?? ""}`.trim(),
    include_deleted: includeDeleted,
  });
  if (!volume) throw new Error(`compute volume '${idOrName}' not found`);
  return volume;
}

function normalizeVolumeName(value: string) {
  const name = `${value ?? ""}`.trim();
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) {
    throw new Error(
      "volume name must start with a letter and contain at most 32 lowercase letters, digits, or hyphens",
    );
  }
  return name;
}

function normalizeFundingMode(value: unknown): DedicatedHostFundingMode {
  if (
    value === "site-funded" ||
    value === "account-prepaid" ||
    value === "account-postpaid"
  ) {
    return value;
  }
  throw new Error(
    "funding_mode must be site-funded, account-prepaid, or account-postpaid",
  );
}

async function requireComputeFunding(opts: {
  account_id: string;
  action: "create" | "start" | "resize";
  funding_mode: unknown;
  provider?: "gcp" | "nebius";
}) {
  const candidates: readonly DedicatedHostFundingMode[] =
    opts.funding_mode == null
      ? ["account-prepaid", "account-postpaid"]
      : [normalizeFundingMode(opts.funding_mode)];
  let lastError: unknown;
  for (const fundingMode of candidates) {
    try {
      if (fundingMode === "site-funded" && !(await isAdmin(opts.account_id))) {
        throw Object.assign(
          new Error("site-funded managed compute requires a site admin"),
          { code: "site_funded_requires_admin" },
        );
      }
      await assertDedicatedHostAdmissionForAccount({
        account_id: opts.account_id,
        action: opts.action,
        machine_cloud: opts.provider ?? "gcp",
        funding_mode_override: fundingMode,
      });
      return fundingMode;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function machineEntries(
  catalog: Awaited<ReturnType<typeof getHostCatalog>>,
  zone: string,
) {
  const payload = catalog.entries.find(
    ({ kind, scope }) => kind === "machine_types" && scope === `zone/${zone}`,
  )?.payload;
  return Array.isArray(payload) ? (payload as HostCatalogMachineType[]) : [];
}

async function getComputeMachine(opts: {
  account_id: string;
  provider: "gcp" | "nebius";
  region: string;
  zone?: string;
  machine_type: string;
}) {
  if (opts.provider === "nebius") {
    const machine = (await loadNebiusInstanceTypes()).find(
      ({ name, regions }) =>
        name === opts.machine_type &&
        (!regions?.length || regions.includes(opts.region)),
    );
    if (!machine?.vcpus || !machine.memory_gib) {
      throw new Error(
        `machine '${opts.machine_type}' is not available in ${opts.region}`,
      );
    }
    return {
      machine_type: machine.name,
      architecture: "x86_64" as const,
      cpu: machine.vcpus,
      ram_gb: machine.memory_gib,
      gpu_type: machine.gpus ? (machine.gpu_label ?? machine.platform) : null,
      gpu_count: machine.gpus ?? 0,
      provider_spec: {
        platform: machine.platform,
        platform_label: machine.platform_label,
        allowed_for_preemptibles: machine.allowed_for_preemptibles !== false,
      },
    };
  }
  if (!opts.zone) throw new Error("zone is required for GCP managed compute");
  const catalog = await getHostCatalog({
    account_id: opts.account_id,
    provider: "gcp",
  });
  const machine = machineEntries(catalog, opts.zone).find(
    ({ name, deprecated }) => name === opts.machine_type && !deprecated,
  );
  if (!machine?.name || !machine.guestCpus || !machine.memoryMb) {
    throw new Error(
      `machine '${opts.machine_type}' is not available in ${opts.zone}`,
    );
  }
  const gpu = gcpMachineGpu(machine.name);
  return {
    machine_type: machine.name,
    architecture: gcpMachineArchitecture(machine.name),
    cpu: machine.guestCpus,
    ram_gb: machine.memoryMb / 1024,
    gpu_type: gpu?.type ?? null,
    gpu_count: gpu?.count ?? 0,
    provider_spec: {},
  };
}

function volumeAuthorization(opts: {
  provider: "gcp" | "nebius";
  size_gb: number;
  max_volume_gb: number;
}) {
  const sizeGb = Number(opts.size_gb);
  if (
    !Number.isInteger(sizeGb) ||
    sizeGb < MIN_VOLUME_GB ||
    sizeGb > opts.max_volume_gb
  ) {
    throw new Error(
      `size_gb must be an integer from ${MIN_VOLUME_GB} to ${opts.max_volume_gb}`,
    );
  }
  if (!validComputeVolumeSizeIncrement(opts.provider, sizeGb)) {
    throw new Error(
      `size_gb must be a multiple of ${NEBIUS_COMPUTE_VOLUME_INCREMENT_GB} for Nebius volumes`,
    );
  }
  return sizeGb;
}

function defaultComputeVolumeDiskType(provider: "gcp" | "nebius") {
  return provider === "nebius" ? ("ssd" as const) : ("balanced" as const);
}

export async function getCatalog(opts: {
  account_id?: string;
}): Promise<ComputeCatalog> {
  const accountId = requireAccount(opts.account_id);
  const config = await getComputeVmConfig();
  const configuredRegions = await getProviderComputeRegions();
  const gcpCatalog = restrictHostCatalogToRegions(
    await getHostCatalog({
      account_id: accountId,
      provider: "gcp",
    }),
    configuredRegions,
  );
  const zone = defaultComputeZone(gcpCatalog);
  const fundingModes = await Promise.all(
    (["site-funded", "account-prepaid", "account-postpaid"] as const).map(
      async (value) => {
        if (value === "site-funded" && !(await isAdmin(accountId))) {
          return {
            value,
            label: "Site-funded",
            allowed: false,
            reason: "Site-funded VMs are available only to site admins.",
          };
        }
        try {
          await assertDedicatedHostAdmissionForAccount({
            account_id: accountId,
            action: "create",
            machine_cloud: "gcp",
            funding_mode_override: value,
          });
          return {
            value,
            label:
              value === "site-funded"
                ? "Site-funded"
                : value === "account-prepaid"
                  ? "Prepaid from this account"
                  : "Postpaid to this account",
            allowed: true,
          };
        } catch (err) {
          return {
            value,
            label:
              value === "site-funded"
                ? "Site-funded"
                : value === "account-prepaid"
                  ? "Prepaid from this account"
                  : "Postpaid to this account",
            allowed: false,
            reason: `${(err as Error)?.message ?? err}`,
          };
        }
      },
    ),
  );
  const allowedFunding = fundingModes.find(({ allowed }) => allowed);
  if (!allowedFunding) {
    throw new Error("no managed compute funding lane is currently available");
  }
  const providerCatalogs: ComputeCatalog["provider_catalogs"] = {
    gcp: gcpCatalog,
  };
  try {
    providerCatalogs.nebius = await getHostCatalog({
      account_id: accountId,
      provider: "nebius",
    });
  } catch {
    // Nebius is omitted until its provider credentials/catalog are configured.
  }
  return {
    providers: providerCatalogs.nebius ? ["gcp", "nebius"] : ["gcp"],
    provider_catalogs: providerCatalogs,
    funding_modes: fundingModes,
    default_funding_mode: allowedFunding.value,
    operating_systems: [
      {
        value: "linux",
        label: "Linux (Ubuntu 24.04)",
        providers: providerCatalogs.nebius ? ["gcp", "nebius"] : ["gcp"],
        architectures: ["x86_64", "arm64"],
        versions: ["ubuntu-24.04"],
        minimum_boot_disk_gb: 20,
        license_per_vcpu_hourly_usd: "0.000000",
      },
      {
        value: "windows",
        label: "Windows Server 2022",
        providers: ["gcp"],
        architectures: ["x86_64"],
        versions: ["windows-server-2022"],
        minimum_boot_disk_gb: 50,
        license_per_vcpu_hourly_usd:
          GCP_WINDOWS_SERVER_LICENSE_USD_PER_VCPU_HOUR.toFixed(6),
      },
    ],
    defaults: {
      provider: "gcp",
      operating_system: "linux",
      architecture: "x86_64",
      region: regionFromComputeZone(zone),
      zone,
      machine_type: "e2-standard-2",
      ttl_minutes: null,
      boot_disk_gb: 20,
    },
    limits: {
      max_active_per_project: config.max_active_per_project,
      max_ttl_minutes: config.max_ttl_minutes,
      max_boot_disk_gb: config.max_boot_disk_gb,
      max_volume_gb: config.max_volume_gb,
    },
  };
}

export async function createVm(
  opts: CreateComputeVmRequest & { agent_auth?: ComputeAgentAuth },
) {
  const { accountId, actorKind } = resolveComputeActor(opts, opts.project_id);
  const config = await getComputeVmConfig();
  requireComputeVmCreateAllowed(config, accountId);
  await requireProjectMembership(accountId, opts.project_id);
  const provider = opts.provider;
  if (provider !== "gcp" && provider !== "nebius") {
    throw new Error("provider must be gcp or nebius");
  }
  const operatingSystem = opts.operating_system ?? "linux";
  if (operatingSystem !== "linux" && operatingSystem !== "windows") {
    throw new Error("operating_system must be linux or windows");
  }
  if (operatingSystem === "windows" && provider !== "gcp") {
    throw new Error(
      "Windows managed compute is currently available only on GCP",
    );
  }
  const fundingMode = await requireComputeFunding({
    account_id: accountId,
    action: "create",
    funding_mode: opts.funding_mode,
    provider,
  });

  const name = normalizeName(opts.name);
  if (provider === "gcp" && !opts.zone) {
    throw new Error("zone is required for GCP managed compute");
  }
  const zone =
    provider === "gcp"
      ? normalizeZone(opts.zone!)
      : opts.zone?.trim() || undefined;
  const region =
    provider === "gcp"
      ? regionFromComputeZone(zone!)
      : `${opts.region ?? ""}`.trim();
  if (!region) throw new Error("region is required");
  if (provider === "gcp") {
    if (opts.region && opts.region !== region) {
      throw new Error(`zone '${zone}' is not in region '${opts.region}'`);
    }
    const configuredRegions = await getProviderComputeRegions();
    requireComputeZoneInRegions(zone!, configuredRegions);
    await requireProviderComputeSubnetwork(zone!);
  }
  let homeVolume = opts.home_volume
    ? await resolveOwnedVolume(accountId, opts.home_volume)
    : undefined;
  if (homeVolume && homeVolume.provider !== provider) {
    throw new Error("home volume and VM must use the same provider");
  }
  if (operatingSystem === "windows" && homeVolume) {
    throw new Error(
      "Windows VMs currently use only their persistent boot disk; home volumes are not supported",
    );
  }
  if (
    homeVolume &&
    (homeVolume.region !== region ||
      (homeVolume.zone ?? null) !== (zone ?? null))
  ) {
    throw new Error(
      `compute volume '${homeVolume.name}' is in a different provider location`,
    );
  }
  if (homeVolume && homeVolume.project_id !== opts.project_id) {
    throw new Error(
      `compute volume '${homeVolume.name}' belongs to a different project`,
    );
  }
  const machine = await getComputeMachine({
    account_id: accountId,
    provider,
    region,
    zone,
    machine_type: opts.machine_type,
  });
  if (opts.architecture && opts.architecture !== machine.architecture) {
    throw new Error(
      `machine '${machine.machine_type}' has architecture ${machine.architecture}, not ${opts.architecture}`,
    );
  }
  if (operatingSystem === "windows" && machine.architecture !== "x86_64") {
    throw new Error("Windows managed compute requires an x86-64 machine");
  }
  const requestedGpuType = `${opts.gpu_type ?? ""}`.trim();
  const normalizedRequestedGpuType =
    requestedGpuType && requestedGpuType !== "none"
      ? requestedGpuType
      : undefined;
  const machineGpuType = `${machine.gpu_type ?? ""}`.trim() || undefined;
  if (operatingSystem === "windows" && machineGpuType) {
    throw new Error("Windows managed compute does not yet support GPUs");
  }
  if (
    normalizedRequestedGpuType != null &&
    normalizedRequestedGpuType !== machineGpuType
  ) {
    throw new Error(
      `machine '${machine.machine_type}' provides GPU '${machine.gpu_type ?? "none"}', not '${normalizedRequestedGpuType}'`,
    );
  }
  if (
    opts.gpu_count != null &&
    Number(opts.gpu_count) !== Number(machine.gpu_count)
  ) {
    throw new Error(
      `machine '${machine.machine_type}' provides ${machine.gpu_count} GPUs, not ${opts.gpu_count}`,
    );
  }
  if (
    (provider === "gcp" &&
      !isSupportedCatalogGcpMachineType(machine.machine_type)) ||
    (machine.ram_gb < 8 && machine.machine_type !== "t2a-standard-1")
  ) {
    throw new Error(
      `machine_type '${machine.machine_type}' is not supported for managed compute VMs`,
    );
  }
  const pricingModel = opts.pricing_model;
  if (pricingModel !== "spot" && pricingModel !== "on_demand") {
    throw new Error("pricing_model must be spot or on_demand");
  }
  if (
    provider === "nebius" &&
    pricingModel === "spot" &&
    machine.provider_spec.allowed_for_preemptibles === false
  ) {
    throw new Error(
      `Nebius machine '${machine.machine_type}' does not support Spot capacity`,
    );
  }
  const spotSupported = !(
    provider === "nebius" &&
    machine.provider_spec.allowed_for_preemptibles === false
  );
  const ttlMinutes =
    opts.ttl_minutes == null ? undefined : Number(opts.ttl_minutes);
  if (actorKind === "agent" && ttlMinutes == null) {
    throw Object.assign(
      new Error("agent-created VMs require an explicit deletion deadline"),
      { code: 403 },
    );
  }
  if (
    ttlMinutes != null &&
    (!Number.isInteger(ttlMinutes) ||
      ttlMinutes < 5 ||
      ttlMinutes > config.max_ttl_minutes)
  ) {
    throw new Error(
      `ttl_minutes must be an integer from 5 to ${config.max_ttl_minutes}`,
    );
  }
  const bootDiskGb = Number(
    opts.boot_disk_gb ?? (operatingSystem === "windows" ? 80 : 20),
  );
  const minimumBootDiskGb =
    operatingSystem === "windows"
      ? 50
      : provider === "gcp"
        ? gcpMinimumBootDiskGb(machine.machine_type)
        : 10;
  if (
    !Number.isInteger(bootDiskGb) ||
    bootDiskGb < minimumBootDiskGb ||
    bootDiskGb > config.max_boot_disk_gb
  ) {
    throw new Error(
      `boot_disk_gb must be an integer from ${minimumBootDiskGb} to ${config.max_boot_disk_gb} for ${machine.machine_type}`,
    );
  }
  const rateInput = {
    provider,
    region,
    zone,
    machine_type: machine.machine_type,
    gpu_type: machine.gpu_type ?? undefined,
    gpu_count: machine.gpu_count,
    disk_gb: bootDiskGb,
    disk_type: defaultComputeVolumeDiskType(provider),
    operating_system: operatingSystem,
  } as const;
  const [customerSpotRate, customerOnDemandRate, customerStoppedRate] =
    await Promise.all([
      estimateDedicatedHostRate({
        ...rateInput,
        pricing_model: "spot",
        billing_state: "running",
      }),
      estimateDedicatedHostRate({
        ...rateInput,
        pricing_model: "on_demand",
        billing_state: "running",
      }),
      estimateDedicatedHostRate({
        ...rateInput,
        pricing_model: pricingModel,
        billing_state: "stopped",
      }),
    ]);
  if (
    (spotSupported && !customerSpotRate) ||
    !customerOnDemandRate ||
    !customerStoppedRate
  ) {
    throw new Error(
      `pricing is unavailable for ${machine.machine_type} in ${region}`,
    );
  }
  const allowOnDemandFallback =
    pricingModel === "spot" && opts.allow_on_demand_fallback === true;
  const authorizedFallbackHours = allowOnDemandFallback ? 24 : 0;
  const id = randomUUID();
  const settings = await getServerSettings();
  // The database keeps both rates on every VM. For an on-demand-only Nebius
  // shape, use the on-demand rate as the inert Spot placeholder; admission
  // above still rejects selecting Spot for that machine.
  const spotRate = rateWithProviderCost(
    provider,
    customerSpotRate ?? customerOnDemandRate,
    settings,
  );
  const onDemandRate = rateWithProviderCost(
    provider,
    customerOnDemandRate,
    settings,
  );
  const stoppedRate = rateWithProviderCost(
    provider,
    customerStoppedRate,
    settings,
  );
  const { rows: activeRows } = await getPool().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM compute_vms
      WHERE owner_account_id=$1 AND deleted_at IS NULL`,
    [accountId],
  );
  const selectedRate = pricingModel === "spot" ? spotRate : onDemandRate;
  const osLicenseHourlyPrice =
    selectedRate.pricing_snapshot.components.find(
      ({ key }) => key === "windows_license",
    )?.hourly_cost_usd ?? "0.000000";
  await authorizeComputeMutation({
    actor: opts,
    action: "billable",
    project_id: opts.project_id,
    request: {
      operation: "create-vm",
      operation_id: opts.idempotency_key,
      allow_create: true,
      provider,
      machine_class: machine.machine_type,
      funding_mode: fundingMode,
      active_vms: Number(activeRows[0]?.count ?? 0) + 1,
      hourly_usd: Number(selectedRate.hourly_cost_usd),
      total_authorized_usd:
        Number(selectedRate.hourly_cost_usd) *
        ((ttlMinutes ?? config.max_ttl_minutes) / 60),
      ttl_minutes: ttlMinutes ?? config.max_ttl_minutes,
    },
    require_fresh_auth: true,
  });
  const projectKey =
    opts.configure_project_ssh === true || opts.ssh_public_key == null
      ? await getManagedVmProjectSshPublicKey({
          account_id: accountId,
          project_id: opts.project_id,
        })
      : null;
  const {
    ssh_public_key: sshPublicKey,
    configure_project_ssh: configureProjectSsh,
  } = resolveManagedVmCreateSshAuthorization({
    requested_key: opts.ssh_public_key,
    configure_project_ssh: opts.configure_project_ssh,
    project_key: projectKey,
  });
  const providerInstanceId = `cocalc-vm-${id.replaceAll("-", "").slice(0, 24)}`;
  const vm = await insertComputeVm(
    {
      id,
      name,
      owner_account_id: accountId,
      owning_bay_id: getConfiguredBayId(),
      project_id: opts.project_id,
      provider,
      operating_system: operatingSystem,
      operating_system_version:
        operatingSystem === "windows" ? "windows-server-2022" : "ubuntu-24.04",
      os_license_hourly_price: `${osLicenseHourlyPrice}`,
      region,
      zone,
      architecture: machine.architecture,
      machine_type: machine.machine_type,
      cpu: machine.cpu,
      ram_gb: machine.ram_gb,
      gpu_type: machine.gpu_type,
      gpu_count: machine.gpu_count,
      provider_spec: {
        ...machine.provider_spec,
        operating_system: operatingSystem,
        operating_system_version:
          operatingSystem === "windows"
            ? "windows-server-2022"
            : "ubuntu-24.04",
      },
      funding_mode: fundingMode,
      desired_pricing_model: pricingModel,
      effective_pricing_model: pricingModel,
      boot_disk_gb: bootDiskGb,
      boot_disk_id: `${providerInstanceId}-boot`,
      home_volume_id: homeVolume?.id ?? null,
      state: "requested",
      desired_state: "running",
      instance_generation: 1,
      provider_instance_id: providerInstanceId,
      public_address_id: null,
      public_address_state: "pending",
      public_address_updated_at: null,
      public_ip: null,
      public_hostname: await allocateComputeVmPublicHostname(settings.dns),
      dns_record_id: null,
      dns_state: "pending",
      dns_updated_at: null,
      dns_error: null,
      public_ports: [22, 443],
      ssh_user: "user",
      ssh_public_key: sshPublicKey,
      expires_at:
        ttlMinutes == null ? null : new Date(Date.now() + ttlMinutes * 60_000),
      allow_on_demand_fallback: allowOnDemandFallback,
      authorized_fallback_hours: authorizedFallbackHours,
      spot_hourly_price: `${spotRate.hourly_cost_usd}`,
      on_demand_hourly_price: `${onDemandRate.hourly_cost_usd}`,
      authorized_cost: "0.000000",
      accrued_cost: "0.000000",
      billing_state: "pending",
      bootstrap_revision: operatingSystem === "windows" ? 1 : 2,
      observed_bootstrap_revision: null,
      public_port_policy_revision: 2,
      spot_recovery_policy: {
        ...DEFAULT_SPOT_RECOVERY_POLICY,
        standard_fallback_enabled: allowOnDemandFallback,
      },
      spot_recovery_state: { phase: "idle" },
      idempotency_key: normalizeIdempotencyKey(opts.idempotency_key),
      error: null,
      metadata: {
        machine: { cpu: machine.cpu, ram_gb: machine.ram_gb },
        provider_instance_name: providerInstanceId,
        ssh_public_keys: sshPublicKey ? [sshPublicKey] : [],
        configure_project_ssh: configureProjectSsh,
        provider_context: config.staging_legacy_provider
          ? "project-host-provider-context"
          : "dedicated-compute-provider-context",
        price_snapshot_kind: "dedicated-host-catalog",
        max_ttl_minutes: config.max_ttl_minutes,
        billing: {
          funding_mode: fundingMode,
          spot_supported: spotSupported,
          running_rates: {
            spot: spotRate,
            on_demand: onDemandRate,
          },
          stopped_rate: stoppedRate,
        },
      },
    },
    {
      max_active_per_project: config.max_active_per_project,
      max_active_total: config.max_active_total,
    },
  );
  await appendComputeEvent({
    vm,
    actor_account_id: accountId,
    actor_kind: actorKind,
    action: "create",
    idempotency_key: opts.idempotency_key,
    new_state: vm.state,
    status: "requested",
    details: {
      machine_type: vm.machine_type,
      pricing_model: vm.desired_pricing_model,
      expires_at: vm.expires_at,
      funding_mode: fundingMode,
      home_volume_id: vm.home_volume_id,
    },
  });
  await enqueueComputeWork({
    resource_id: vm.id,
    action: "provision",
    idempotency_key: `provision:${vm.id}:1`,
  });
  return publicVm(vm);
}

export async function createVolume(
  opts: CreateComputeVolumeRequest & { agent_auth?: ComputeAgentAuth },
) {
  const { accountId, actorKind } = resolveComputeActor(opts, opts.project_id);
  const config = await getComputeVmConfig();
  requireComputeVmCreateAllowed(config, accountId);
  await requireProjectMembership(accountId, opts.project_id);
  const provider = opts.provider;
  if (provider !== "gcp" && provider !== "nebius") {
    throw new Error("provider must be gcp or nebius");
  }
  const fundingMode = await requireComputeFunding({
    account_id: accountId,
    action: "create",
    funding_mode: opts.funding_mode,
    provider,
  });
  const name = normalizeVolumeName(opts.name);
  const zone =
    provider === "gcp"
      ? normalizeZone(
          opts.zone ??
            (() => {
              throw new Error("zone is required for a GCP home volume");
            })(),
        )
      : opts.zone?.trim() || undefined;
  const region =
    provider === "gcp"
      ? regionFromComputeZone(zone!)
      : `${opts.region ?? ""}`.trim();
  if (!region) throw new Error("region is required");
  if (provider === "gcp") {
    if (opts.region && opts.region !== region) {
      throw new Error(`zone '${zone}' is not in region '${opts.region}'`);
    }
    const configuredRegions = await getProviderComputeRegions();
    requireComputeZoneInRegions(zone!, configuredRegions);
    await requireProviderComputeSubnetwork(zone!);
  }
  const sizeGb = volumeAuthorization({
    provider,
    size_gb: opts.size_gb,
    max_volume_gb: config.max_volume_gb,
  });
  const effectiveSizeGb = effectiveComputeVolumeSizeGb(provider, sizeGb);
  const diskType = defaultComputeVolumeDiskType(provider);
  const customerVolumeRate = await estimateDedicatedHostRate({
    provider,
    region,
    zone,
    machine_type: provider === "gcp" ? "e2-standard-2" : undefined,
    pricing_model: "on_demand",
    disk_gb: effectiveSizeGb,
    disk_type: diskType,
    billing_state: "stopped",
  });
  if (!customerVolumeRate) {
    throw new Error(`storage pricing is unavailable in ${region}`);
  }
  const volumeRate = rateWithProviderCost(
    provider,
    customerVolumeRate,
    await getServerSettings(),
  );
  const monthlyCost = Number(volumeRate.hourly_cost_usd) * HOURS_PER_MONTH;
  await authorizeComputeMutation({
    actor: opts,
    action: "billable",
    project_id: opts.project_id,
    request: {
      operation: "create-volume",
      operation_id: opts.idempotency_key,
      allow_create: true,
      provider,
      machine_class: "home-volume",
      funding_mode: fundingMode,
      hourly_usd: Number(volumeRate.hourly_cost_usd),
      total_authorized_usd: monthlyCost,
      ttl_minutes: 30 * 24 * 60,
    },
    require_fresh_auth: true,
  });
  const id = randomUUID();
  const volume = await insertComputeVolume(
    {
      id,
      name,
      owner_account_id: accountId,
      owning_bay_id: getConfiguredBayId(),
      project_id: opts.project_id,
      provider,
      region,
      zone,
      role: "home",
      funding_mode: fundingMode,
      provider_spec: {},
      disk_type: diskType,
      filesystem: "ext4",
      size_gb: sizeGb,
      desired_size_gb: sizeGb,
      effective_size_gb: effectiveSizeGb,
      provider_disk_id: `cocalc-vol-${id.replaceAll("-", "").slice(0, 24)}`,
      state: "requested",
      desired_state: "ready",
      attached_vm_id: null,
      attachment_generation: 0,
      attachment_state: "detached",
      monthly_price_per_gb: (monthlyCost / effectiveSizeGb).toFixed(6),
      authorized_monthly_cost: monthlyCost.toFixed(6),
      billing_state: "pending",
      idempotency_key: normalizeIdempotencyKey(opts.idempotency_key),
      error: null,
      metadata: {
        provider_context: config.staging_legacy_provider
          ? "project-host-provider-context"
          : "dedicated-compute-provider-context",
        price_snapshot_kind: "dedicated-host-catalog",
        billing: { funding_mode: fundingMode, rate: volumeRate },
      },
    },
    config.max_volumes_per_account,
  );
  await appendComputeVolumeEvent({
    volume,
    actor_account_id: accountId,
    actor_kind: actorKind,
    action: "create",
    idempotency_key: opts.idempotency_key,
    new_state: volume.state,
    status: "requested",
    details: {
      size_gb: volume.size_gb,
      funding_mode: fundingMode,
    },
  });
  await enqueueComputeWork({
    resource_kind: "volume",
    resource_id: volume.id,
    action: "provision_volume",
    idempotency_key: `provision-volume:${volume.id}`,
  });
  return publicVolume(volume);
}

export async function listVolumes(opts: {
  account_id?: string;
  project_id?: string;
  include_deleted?: boolean;
}) {
  const accountId = requireAccount(opts.account_id);
  return (
    await listOwnedComputeVolumes({
      owner_account_id: accountId,
      project_id: opts.project_id,
      include_deleted: opts.include_deleted,
    })
  ).map(publicVolume);
}

export async function getVolume(opts: {
  account_id?: string;
  id_or_name: string;
}) {
  const accountId = requireAccount(opts.account_id);
  return publicVolume(
    await resolveOwnedVolume(accountId, opts.id_or_name, true),
  );
}

export async function resizeVolume(opts: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string;
  id_or_name: string;
  size_gb: number;
  funding_mode?: "site-funded" | "account-prepaid" | "account-postpaid";
  idempotency_key: string;
  agent_auth?: ComputeAgentAuth;
}) {
  const accountId = requireAccount(
    opts.agent_auth?.account_id ?? opts.account_id,
  );
  const config = await getComputeVmConfig();
  requireComputeVmCreateAllowed(config, accountId);
  const volume = await resolveOwnedVolume(accountId, opts.id_or_name);
  const { actorKind } = resolveComputeActor(opts, volume.project_id ?? "");
  const fundingMode = await requireComputeFunding({
    account_id: accountId,
    action: "resize",
    funding_mode: opts.funding_mode ?? volume.funding_mode,
    provider: volume.provider,
  });
  const sizeGb = volumeAuthorization({
    provider: volume.provider,
    size_gb: opts.size_gb,
    max_volume_gb: config.max_volume_gb,
  });
  if (sizeGb < volume.size_gb) {
    throw new Error("compute volumes cannot be shrunk");
  }
  const effectiveSizeGb = effectiveComputeVolumeSizeGb(volume.provider, sizeGb);
  const customerVolumeRate = await estimateDedicatedHostRate({
    provider: volume.provider,
    region: volume.region,
    zone: volume.zone,
    machine_type: volume.provider === "gcp" ? "e2-standard-2" : undefined,
    pricing_model: "on_demand",
    disk_gb: effectiveSizeGb,
    disk_type: volume.disk_type,
    billing_state: "stopped",
  });
  if (!customerVolumeRate)
    throw new Error(`storage pricing is unavailable in ${volume.region}`);
  const volumeRate = rateWithProviderCost(
    volume.provider,
    customerVolumeRate,
    await getServerSettings(),
  );
  const monthlyCost = Number(volumeRate.hourly_cost_usd) * HOURS_PER_MONTH;
  await authorizeComputeMutation({
    actor: opts,
    action: "billable",
    project_id: volume.project_id!,
    vm_id: volume.id,
    request: {
      operation: "resize-volume",
      operation_id: opts.idempotency_key,
      vm_id: volume.id,
      provider: volume.provider,
      machine_class: "home-volume",
      funding_mode: fundingMode,
      hourly_usd: Number(volumeRate.hourly_cost_usd),
      total_authorized_usd: monthlyCost,
    },
    require_fresh_auth: true,
  });
  const fundingChanging = fundingMode !== volume.funding_mode;
  const pendingFundingMode = volume.metadata?.billing?.pending_funding_mode;
  if (pendingFundingMode && pendingFundingMode !== fundingMode) {
    throw new Error(
      `compute volume funding transition to '${pendingFundingMode}' is already pending`,
    );
  }
  const next = (await updateComputeVolume(volume.id, {
    desired_size_gb: sizeGb,
    monthly_price_per_gb: (monthlyCost / effectiveSizeGb).toFixed(6),
    authorized_monthly_cost: monthlyCost.toFixed(6),
    state: sizeGb === volume.size_gb ? volume.state : "resizing",
    error: null,
    metadata: {
      ...volume.metadata,
      billing: {
        ...volume.metadata?.billing,
        funding_mode: volume.funding_mode,
        pending_funding_mode: fundingChanging ? fundingMode : null,
        rate: volumeRate,
      },
    },
  }))!;
  await appendComputeVolumeEvent({
    volume: next,
    actor_account_id: accountId,
    actor_kind: actorKind,
    action: "resize",
    idempotency_key: normalizeIdempotencyKey(opts.idempotency_key),
    old_state: volume.state,
    new_state: next.state,
    status: "requested",
    details: { old_size_gb: volume.size_gb, desired_size_gb: sizeGb },
  });
  if (fundingChanging) {
    await enqueueComputeWork({
      resource_kind: "volume",
      resource_id: volume.id,
      action: "funding_transition",
      idempotency_key: `${opts.idempotency_key}:funding`,
      payload: { funding_mode: fundingMode },
    });
  }
  if (sizeGb > volume.size_gb) {
    await enqueueComputeWork({
      resource_kind: "volume",
      resource_id: volume.id,
      action: "resize_volume",
      idempotency_key: opts.idempotency_key,
    });
  }
  return publicVolume(next);
}

export async function setVolumeFundingMode(opts: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string;
  id_or_name: string;
  funding_mode: "site-funded" | "account-prepaid" | "account-postpaid";
  idempotency_key: string;
  agent_auth?: ComputeAgentAuth;
}) {
  const accountId = requireAccount(
    opts.agent_auth?.account_id ?? opts.account_id,
  );
  const volume = await resolveOwnedVolume(accountId, opts.id_or_name);
  const { actorKind } = resolveComputeActor(opts, volume.project_id ?? "");
  const fundingMode = await requireComputeFunding({
    account_id: accountId,
    action: "resize",
    funding_mode: opts.funding_mode,
    provider: volume.provider,
  });
  const pendingFundingMode = volume.metadata?.billing?.pending_funding_mode;
  if (pendingFundingMode && pendingFundingMode !== fundingMode) {
    throw new Error(
      `compute volume funding transition to '${pendingFundingMode}' is already pending`,
    );
  }
  if (volume.funding_mode === fundingMode && !pendingFundingMode) {
    return publicVolume(volume);
  }
  await authorizeComputeMutation({
    actor: opts,
    action: "billable",
    project_id: volume.project_id ?? "",
    vm_id: volume.id,
    request: {
      operation: "set-volume-funding",
      operation_id: opts.idempotency_key,
      vm_id: volume.id,
      provider: volume.provider,
      machine_class: "home-volume",
      funding_mode: fundingMode,
      hourly_usd: Number(volume.metadata?.billing?.rate?.hourly_cost_usd ?? 0),
      total_authorized_usd: Number(volume.authorized_monthly_cost),
    },
    require_fresh_auth: true,
  });
  const next = (await updateComputeVolume(volume.id, {
    billing_state: "transitioning",
    metadata: {
      ...volume.metadata,
      billing: {
        ...volume.metadata?.billing,
        pending_funding_mode: fundingMode,
      },
    },
  }))!;
  await appendComputeVolumeEvent({
    volume: next,
    actor_account_id: accountId,
    actor_kind: actorKind,
    action: "funding-mode-change",
    idempotency_key: normalizeIdempotencyKey(opts.idempotency_key),
    status: "requested",
    details: { from: volume.funding_mode, to: fundingMode },
  });
  await enqueueComputeWork({
    resource_kind: "volume",
    resource_id: volume.id,
    action: "funding_transition",
    idempotency_key: opts.idempotency_key,
    payload: { funding_mode: fundingMode },
  });
  return publicVolume(next);
}

export async function deleteVolume(opts: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string;
  id_or_name: string;
  confirm_name: string;
  idempotency_key: string;
  agent_auth?: ComputeAgentAuth;
}) {
  const accountId = requireAccount(
    opts.agent_auth?.account_id ?? opts.account_id,
  );
  const volume = await resolveOwnedVolume(accountId, opts.id_or_name);
  const { actorKind } = resolveComputeActor(opts, volume.project_id ?? "");
  await authorizeComputeMutation({
    actor: opts,
    action: "destructive",
    project_id: volume.project_id ?? "",
    vm_id: volume.id,
    request: {
      operation: "delete-volume",
      operation_id: opts.idempotency_key,
      vm_id: volume.id,
    },
    require_fresh_auth: true,
  });
  if (`${opts.confirm_name ?? ""}` !== volume.name) {
    throw new Error(`confirm_name must exactly equal '${volume.name}'`);
  }
  if (volume.attached_vm_id || volume.attachment_state !== "detached") {
    throw new Error("cannot delete an attached or uncertain compute volume");
  }
  const next = (await updateComputeVolume(volume.id, {
    desired_state: "deleted",
    state: "deleting",
    error: null,
  }))!;
  await appendComputeVolumeEvent({
    volume: next,
    actor_account_id: accountId,
    actor_kind: actorKind,
    action: "delete",
    idempotency_key: normalizeIdempotencyKey(opts.idempotency_key),
    old_state: volume.state,
    new_state: "deleting",
    status: "requested",
  });
  await enqueueComputeWork({
    resource_kind: "volume",
    resource_id: volume.id,
    action: "delete_volume",
    idempotency_key: opts.idempotency_key,
  });
  return publicVolume(next);
}

export async function listVms(opts: {
  account_id?: string;
  project_id?: string;
  include_deleted?: boolean;
}) {
  const accountId = requireAccount(opts.account_id);
  const rows = await listOwnedComputeVms({
    owner_account_id: accountId,
    project_id: opts.project_id,
    include_deleted: opts.include_deleted,
  });
  return await Promise.all(rows.map(publicVm));
}

export async function listProjectVms(opts: {
  host_id?: string;
  project_id?: string;
  include_deleted?: boolean;
  agent_auth?: ComputeAgentAuth;
}) {
  const projectId = await requireComputeProjectReadIdentity(opts);
  await requireAgentComputeGrant({
    auth: opts.agent_auth,
    action: "read",
    project_id: projectId,
  });
  return await Promise.all(
    (
      await listProjectComputeVms({
        project_id: projectId,
        include_deleted: opts.include_deleted,
      })
    ).map(publicVm),
  );
}

export async function getVm(opts: { account_id?: string; id_or_name: string }) {
  const accountId = requireAccount(opts.account_id);
  return publicVm(await resolveOwned(accountId, opts.id_or_name, true));
}

export async function getProjectVm(opts: {
  host_id?: string;
  project_id?: string;
  id_or_name: string;
  agent_auth?: ComputeAgentAuth;
}) {
  const projectId = await requireComputeProjectReadIdentity(opts);
  const vm = await resolveProjectComputeVm({
    project_id: projectId,
    id_or_name: `${opts.id_or_name ?? ""}`.trim(),
    include_deleted: true,
  });
  if (!vm) throw new Error(`compute VM '${opts.id_or_name}' not found`);
  await requireAgentComputeGrant({
    auth: opts.agent_auth,
    action: "read",
    project_id: projectId,
    vm_id: vm.id,
  });
  return publicVm(vm);
}

export async function listProjectVolumes(opts: {
  host_id?: string;
  project_id?: string;
  include_deleted?: boolean;
  agent_auth?: ComputeAgentAuth;
}) {
  const projectId = await requireComputeProjectReadIdentity(opts);
  await requireAgentComputeGrant({
    auth: opts.agent_auth,
    action: "read",
    project_id: projectId,
  });
  return (
    await listProjectComputeVolumes({
      project_id: projectId,
      include_deleted: opts.include_deleted,
    })
  ).map(publicVolume);
}

export async function getProjectVolume(opts: {
  host_id?: string;
  project_id?: string;
  id_or_name: string;
  agent_auth?: ComputeAgentAuth;
}) {
  const projectId = await requireComputeProjectReadIdentity(opts);
  const volume = await resolveProjectComputeVolume({
    project_id: projectId,
    id_or_name: `${opts.id_or_name ?? ""}`.trim(),
    include_deleted: true,
  });
  if (!volume) throw new Error(`compute volume '${opts.id_or_name}' not found`);
  await requireAgentComputeGrant({
    auth: opts.agent_auth,
    action: "read",
    project_id: projectId,
  });
  return publicVolume(volume);
}

async function requireComputeProjectReadIdentity(opts: {
  host_id?: string;
  project_id?: string;
}): Promise<string> {
  const projectId = `${opts.project_id ?? ""}`.trim();
  if (!projectId) throw new Error("must be a project");
  const hostId = `${opts.host_id ?? ""}`.trim();
  if (hostId) {
    await assertComputeProjectAssignedToHost({
      project_id: projectId,
      host_id: hostId,
      bay_id: getConfiguredBayId(),
    });
  }
  return projectId;
}

export async function authorizeSshKey(opts: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string;
  id_or_name: string;
  ssh_public_key: string;
  idempotency_key: string;
}) {
  const accountId = requireAccount(opts.account_id);
  const key = normalizeManagedVmSshPublicKey(opts.ssh_public_key);
  if (!key) throw new Error("ssh_public_key is required");
  const vm = await resolveOwned(accountId, opts.id_or_name);
  return await authorizeSshKeyForVm({
    vm,
    key,
    idempotency_key: opts.idempotency_key,
    actor_account_id: accountId,
    actor_kind: "human",
    beforeAdd: async () => {
      await requireDangerousSessionAuth({
        account_id: accountId,
        browser_id: opts.browser_id,
        session_hash: opts.session_hash,
        require_second_factor: "if_enabled",
      });
    },
  });
}

export async function prepareWindowsRdp(opts: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string;
  id_or_name: string;
}) {
  const accountId = requireAccount(opts.account_id);
  await requireDangerousSessionAuth({
    account_id: accountId,
    browser_id: opts.browser_id,
    session_hash: opts.session_hash,
    require_second_factor: "if_enabled",
  });
  const vm = await resolveOwned(accountId, opts.id_or_name);
  if ((vm.operating_system ?? "linux") !== "windows") {
    throw new Error(`compute VM '${vm.name}' is not a Windows VM`);
  }
  if (vm.state !== "ready") {
    throw new Error(`compute VM '${vm.name}' is not ready (state=${vm.state})`);
  }
  const hostname = vm.public_hostname || vm.public_ip;
  if (!hostname) throw new Error("Windows VM has no public SSH hostname");
  const password = `${randomBytes(24).toString("base64url")}aA1!`;
  await prepareProviderComputeWindowsRdp(vm, password);
  await appendComputeEvent({
    vm,
    actor_account_id: accountId,
    actor_kind: "account",
    action: "prepare-rdp",
    idempotency_key: randomUUID(),
    old_state: vm.state,
    new_state: vm.state,
    status: "success",
    details: { public_rdp_port_open: false },
  });
  return {
    id: vm.id,
    name: vm.name,
    hostname,
    ssh_user: vm.ssh_user || "user",
    windows_user: "user",
    windows_password: password,
    remote_port: 3389 as const,
  };
}

async function authorizeSshKeyForVm(opts: {
  vm: ComputeVmRow;
  key: string;
  idempotency_key: string;
  actor_account_id?: string;
  actor_kind: "human" | "project";
  beforeAdd?: () => Promise<void>;
}) {
  const { vm, key } = opts;
  if (vm.state !== "ready" || !vm.public_ip) {
    throw new Error(
      `compute VM '${vm.name}' is not SSH-ready (state=${vm.state})`,
    );
  }
  const existingKeys = Array.from(
    new Set(
      [
        vm.ssh_public_key,
        ...(Array.isArray(vm.metadata?.ssh_public_keys)
          ? vm.metadata.ssh_public_keys
          : []),
      ]
        .map((value) => `${value ?? ""}`.trim())
        .filter(Boolean),
    ),
  );
  let next = vm;
  let added = false;
  if (!existingKeys.includes(key)) {
    await opts.beforeAdd?.();
    const result = await addComputeVmSshPublicKey({
      id: vm.id,
      owner_account_id: vm.owner_account_id,
      ssh_public_key: key,
    });
    next = result.vm;
    added = result.added;
  }
  await ensureProviderComputeSshAccess(next);
  if (added) {
    const authorizedKeyCount = Array.isArray(next.metadata?.ssh_public_keys)
      ? next.metadata.ssh_public_keys.length
      : 1;
    await appendComputeEvent({
      vm: next,
      actor_account_id: opts.actor_account_id,
      actor_kind: opts.actor_kind,
      action: "authorize_ssh_key",
      idempotency_key: normalizeIdempotencyKey(opts.idempotency_key),
      old_state: vm.state,
      new_state: next.state,
      status: "completed",
      details: { authorized_key_count: authorizedKeyCount },
    });
  }
  return publicVm(next);
}

async function authorizeVerifiedProjectSshKey(opts: {
  project_id?: string;
  id_or_name: string;
  ssh_public_key: string;
  idempotency_key: string;
  agent_auth?: ComputeAgentAuth;
  key_verified_by_host?: boolean;
}) {
  const projectId = `${opts.project_id ?? ""}`.trim();
  if (!projectId) throw new Error("must be a project");
  const key = normalizeManagedVmSshPublicKey(opts.ssh_public_key);
  if (!key) throw new Error("ssh_public_key is required");
  const vm = await resolveProjectComputeVm({
    project_id: projectId,
    id_or_name: `${opts.id_or_name ?? ""}`.trim(),
  });
  if (!vm) throw new Error(`compute VM '${opts.id_or_name}' not found`);
  if (!opts.key_verified_by_host) {
    if (!opts.agent_auth) {
      throw Object.assign(
        new Error(
          "project SSH authorization requires a scoped agent or project-host identity",
        ),
        { code: 403 },
      );
    }
    const projectKey = normalizeManagedVmSshPublicKey(
      (await getManagedVmProjectSshPublicKey({
        account_id: opts.agent_auth.account_id,
        project_id: projectId,
      })) ?? "",
    );
    if (!projectKey || projectKey !== key) {
      throw Object.assign(
        new Error("only the exact project deploy public key may be authorized"),
        { code: 403 },
      );
    }
  }
  await requireAgentComputeGrant({
    auth: opts.agent_auth,
    action: "data-plane",
    project_id: projectId,
    vm_id: vm.id,
  });
  const authorized = await authorizeSshKeyForVm({
    vm,
    key,
    idempotency_key: opts.idempotency_key,
    actor_kind: "project",
  });
  const next = (await updateComputeVm(vm.id, {
    metadata: { ...vm.metadata, configure_project_ssh: true },
  }))!;
  await enqueueComputeWork({
    resource_id: vm.id,
    action: "reconcile",
    idempotency_key: `project-ssh-config:${opts.idempotency_key}`,
  });
  return { ...authorized, metadata: next.metadata };
}

export async function authorizeProjectSshKey(opts: {
  project_id?: string;
  id_or_name: string;
  ssh_public_key: string;
  idempotency_key: string;
  agent_auth?: ComputeAgentAuth;
}) {
  return await authorizeVerifiedProjectSshKey({
    project_id: opts.project_id,
    id_or_name: opts.id_or_name,
    ssh_public_key: opts.ssh_public_key,
    idempotency_key: opts.idempotency_key,
    agent_auth: opts.agent_auth,
  });
}

export async function authorizeProjectSshKeyFromHost(opts: {
  host_id?: string;
  project_id: string;
  id_or_name: string;
  ssh_public_key: string;
  idempotency_key: string;
}) {
  const hostId = `${opts.host_id ?? ""}`.trim();
  const projectId = `${opts.project_id ?? ""}`.trim();
  if (!hostId) throw new Error("must be a host");
  if (!projectId) throw new Error("project_id is required");
  await assertComputeProjectAssignedToHost({
    project_id: projectId,
    host_id: hostId,
    bay_id: getConfiguredBayId(),
  });
  return await authorizeVerifiedProjectSshKey({
    project_id: projectId,
    id_or_name: opts.id_or_name,
    ssh_public_key: opts.ssh_public_key,
    idempotency_key: opts.idempotency_key,
    key_verified_by_host: true,
  });
}

async function requestState(opts: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string;
  id_or_name: string;
  idempotency_key: string;
  desired_state: "running" | "stopped";
  agent_auth?: ComputeAgentAuth;
}) {
  const accountId = requireAccount(
    opts.agent_auth?.account_id ?? opts.account_id,
  );
  if (opts.desired_state === "running") {
    requireComputeVmStartAllowed(await getComputeVmConfig(), accountId);
  }
  const vm = await resolveOwned(accountId, opts.id_or_name);
  const { actorKind } = resolveComputeActor(opts, vm.project_id);
  if (opts.desired_state === "running") {
    await requireComputeFunding({
      account_id: accountId,
      action: "start",
      funding_mode: vm.funding_mode,
      provider: vm.provider,
    });
  }
  if (vm.expires_at && vm.expires_at.valueOf() <= Date.now()) {
    throw new Error("compute VM lease has expired");
  }
  if (
    actorKind === "agent" &&
    opts.desired_state === "running" &&
    !vm.expires_at
  ) {
    throw Object.assign(
      new Error("agent-started VMs require an explicit deletion deadline"),
      { code: 403 },
    );
  }
  const action = opts.desired_state === "running" ? "start" : "stop";
  const selectedRate =
    vm.desired_pricing_model === "spot"
      ? vm.spot_hourly_price
      : vm.on_demand_hourly_price;
  const remainingTtlMinutes = vm.expires_at
    ? Math.max(0, Math.ceil((vm.expires_at.valueOf() - Date.now()) / 60_000))
    : 0;
  const activeVms =
    opts.desired_state === "running"
      ? Number(
          (
            await getPool().query<{ count: string }>(
              `SELECT COUNT(*)::text AS count FROM compute_vms
                WHERE owner_account_id=$1 AND deleted_at IS NULL
                  AND desired_state='running'`,
              [accountId],
            )
          ).rows[0]?.count ?? 0,
        ) + (vm.desired_state === "running" ? 0 : 1)
      : undefined;
  await authorizeComputeMutation({
    actor: opts,
    action: "availability",
    project_id: vm.project_id,
    vm_id: vm.id,
    request: {
      operation: opts.desired_state === "running" ? "start-vm" : "stop-vm",
      operation_id: opts.idempotency_key,
      vm_id: vm.id,
      provider: vm.provider,
      machine_class: vm.machine_type,
      funding_mode: vm.funding_mode,
      active_vms: activeVms,
      hourly_usd: Number(selectedRate),
      total_authorized_usd:
        opts.desired_state === "running"
          ? (Number(selectedRate) * remainingTtlMinutes) / 60
          : 0,
      ttl_minutes: remainingTtlMinutes,
    },
    require_fresh_auth: opts.desired_state === "running",
  });
  const next = (await updateComputeVm(vm.id, {
    desired_state: opts.desired_state,
    state: opts.desired_state === "running" ? "starting" : "stopping",
    error: null,
  }))!;
  await appendComputeEvent({
    vm: next,
    actor_account_id: accountId,
    actor_kind: actorKind,
    action,
    idempotency_key: normalizeIdempotencyKey(opts.idempotency_key),
    old_state: vm.state,
    new_state: next.state,
    status: "requested",
  });
  await enqueueComputeWork({
    resource_id: vm.id,
    action,
    idempotency_key: opts.idempotency_key,
  });
  return publicVm(next);
}

export async function startVm(opts: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string;
  id_or_name: string;
  idempotency_key: string;
  agent_auth?: ComputeAgentAuth;
}) {
  return await requestState({ ...opts, desired_state: "running" });
}

export async function stopVm(opts: {
  account_id?: string;
  id_or_name: string;
  idempotency_key: string;
  agent_auth?: ComputeAgentAuth;
}) {
  return await requestState({ ...opts, desired_state: "stopped" });
}

export async function setVmTtl(opts: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string;
  id_or_name: string;
  ttl_minutes?: number | null;
  extend_minutes?: number;
  idempotency_key: string;
  agent_auth?: ComputeAgentAuth;
}) {
  const accountId = requireAccount(
    opts.agent_auth?.account_id ?? opts.account_id,
  );
  const config = await getComputeVmConfig();
  const vm = await resolveOwned(accountId, opts.id_or_name);
  const { actorKind } = resolveComputeActor(opts, vm.project_id);
  if (vm.desired_state === "deleted" || vm.state === "deleting") {
    throw new Error("cannot change the TTL of a deleting VM");
  }
  if (vm.expires_at && vm.expires_at.valueOf() <= Date.now()) {
    throw new Error("cannot change the TTL of an expired VM");
  }
  const hasTtl = Object.prototype.hasOwnProperty.call(opts, "ttl_minutes");
  const hasExtension = opts.extend_minutes != null;
  if (hasTtl === hasExtension) {
    throw new Error("specify exactly one of ttl_minutes or extend_minutes");
  }

  let expiresAt: Date | null;
  if (hasExtension) {
    const minutes = Number(opts.extend_minutes);
    if (!Number.isInteger(minutes) || minutes < 1) {
      throw new Error("extend_minutes must be a positive integer");
    }
    if (!vm.expires_at) {
      throw new Error("this VM has no TTL; use ttl_minutes to set one");
    }
    expiresAt = new Date(vm.expires_at.valueOf() + minutes * 60_000);
  } else if (opts.ttl_minutes == null) {
    expiresAt = null;
  } else {
    const minutes = Number(opts.ttl_minutes);
    if (!Number.isInteger(minutes) || minutes < 5) {
      throw new Error("ttl_minutes must be null or an integer of at least 5");
    }
    expiresAt = new Date(Date.now() + minutes * 60_000);
  }
  if (
    expiresAt &&
    expiresAt.valueOf() > Date.now() + config.max_ttl_minutes * 60_000
  ) {
    throw new Error(
      `the resulting TTL must be at most ${config.max_ttl_minutes} minutes from now`,
    );
  }
  if (actorKind === "agent" && expiresAt == null) {
    throw Object.assign(
      new Error("an agent cannot remove a managed VM deletion deadline"),
      { code: 403 },
    );
  }

  const increasesExposure =
    expiresAt == null ||
    vm.expires_at == null ||
    expiresAt.valueOf() > vm.expires_at.valueOf();
  if (increasesExposure) {
    await requireComputeFunding({
      account_id: accountId,
      action: "start",
      funding_mode: vm.metadata?.billing?.funding_mode,
      provider: vm.provider,
    });
  }

  await authorizeComputeMutation({
    actor: opts,
    action: "billable",
    project_id: vm.project_id,
    vm_id: vm.id,
    request: {
      operation: "set-vm-ttl",
      operation_id: opts.idempotency_key,
      vm_id: vm.id,
      provider: vm.provider,
      machine_class: vm.machine_type,
      funding_mode: vm.funding_mode,
      hourly_usd: Number(
        vm.desired_pricing_model === "spot"
          ? vm.spot_hourly_price
          : vm.on_demand_hourly_price,
      ),
      total_authorized_usd:
        Number(
          vm.desired_pricing_model === "spot"
            ? vm.spot_hourly_price
            : vm.on_demand_hourly_price,
        ) *
        ((expiresAt
          ? Math.max(0, Math.ceil((expiresAt.valueOf() - Date.now()) / 60_000))
          : config.max_ttl_minutes) /
          60),
      ttl_minutes: expiresAt
        ? Math.max(0, Math.ceil((expiresAt.valueOf() - Date.now()) / 60_000))
        : config.max_ttl_minutes,
    },
    require_fresh_auth: true,
  });

  const next = (await updateComputeVm(vm.id, { expires_at: expiresAt }))!;
  await appendComputeEvent({
    vm: next,
    actor_account_id: accountId,
    actor_kind: actorKind,
    action: "set_ttl",
    idempotency_key: normalizeIdempotencyKey(opts.idempotency_key),
    old_state: vm.state,
    new_state: next.state,
    status: "completed",
    details: {
      previous_expires_at: vm.expires_at ?? null,
      expires_at: expiresAt,
      extend_minutes: opts.extend_minutes ?? null,
    },
  });
  return publicVm(next);
}

export async function setVmFundingMode(opts: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string;
  id_or_name: string;
  funding_mode: "site-funded" | "account-prepaid" | "account-postpaid";
  idempotency_key: string;
  agent_auth?: ComputeAgentAuth;
}) {
  const accountId = requireAccount(
    opts.agent_auth?.account_id ?? opts.account_id,
  );
  const vm = await resolveOwned(accountId, opts.id_or_name);
  const { actorKind } = resolveComputeActor(opts, vm.project_id);
  if (actorKind === "agent" && !vm.expires_at) {
    throw Object.assign(
      new Error(
        "an agent cannot change funding for a VM without a deletion deadline",
      ),
      { code: 403 },
    );
  }
  const fundingMode = await requireComputeFunding({
    account_id: accountId,
    action: vm.desired_state === "running" ? "start" : "create",
    funding_mode: opts.funding_mode,
    provider: vm.provider,
  });
  const pendingFundingMode = vm.metadata?.billing?.pending_funding_mode;
  if (pendingFundingMode && pendingFundingMode !== fundingMode) {
    throw new Error(
      `compute VM funding transition to '${pendingFundingMode}' is already pending`,
    );
  }
  if (vm.funding_mode === fundingMode && !pendingFundingMode) {
    return publicVm(vm);
  }
  const selectedRate =
    vm.desired_pricing_model === "spot"
      ? vm.spot_hourly_price
      : vm.on_demand_hourly_price;
  await authorizeComputeMutation({
    actor: opts,
    action: "billable",
    project_id: vm.project_id,
    vm_id: vm.id,
    request: {
      operation: "set-vm-funding",
      operation_id: opts.idempotency_key,
      vm_id: vm.id,
      provider: vm.provider,
      machine_class: vm.machine_type,
      funding_mode: fundingMode,
      hourly_usd: Number(selectedRate),
      total_authorized_usd:
        Number(selectedRate) *
        ((vm.expires_at
          ? Math.max(
              0,
              Math.ceil((vm.expires_at.valueOf() - Date.now()) / 60_000),
            )
          : 0) /
          60),
      ttl_minutes: vm.expires_at
        ? Math.max(
            0,
            Math.ceil((vm.expires_at.valueOf() - Date.now()) / 60_000),
          )
        : 0,
    },
    require_fresh_auth: true,
  });
  const next = (await updateComputeVm(vm.id, {
    billing_state: "transitioning",
    metadata: {
      ...vm.metadata,
      billing: {
        ...vm.metadata?.billing,
        pending_funding_mode: fundingMode,
      },
    },
  }))!;
  await appendComputeEvent({
    vm: next,
    actor_account_id: accountId,
    actor_kind: actorKind,
    action: "funding-mode-change",
    idempotency_key: normalizeIdempotencyKey(opts.idempotency_key),
    old_state: vm.billing_state,
    new_state: "transitioning",
    status: "requested",
    details: { from: vm.funding_mode, to: fundingMode },
  });
  await enqueueComputeWork({
    resource_id: vm.id,
    action: "funding_transition",
    idempotency_key: opts.idempotency_key,
    payload: { funding_mode: fundingMode },
  });
  return publicVm(next);
}

export async function setVmMachineType(opts: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string;
  id_or_name: string;
  machine_type: string;
  idempotency_key: string;
  agent_auth?: ComputeAgentAuth;
}) {
  const accountId = requireAccount(
    opts.agent_auth?.account_id ?? opts.account_id,
  );
  const vm = await resolveOwned(accountId, opts.id_or_name);
  const { actorKind } = resolveComputeActor(opts, vm.project_id);
  if (vm.state !== "stopped" || vm.desired_state !== "stopped") {
    throw new Error("stop the VM before changing its machine type");
  }
  if (vm.machine_type === opts.machine_type) return await publicVm(vm);
  const machine = await getComputeMachine({
    account_id: accountId,
    provider: vm.provider,
    region: vm.region,
    zone: vm.zone ?? undefined,
    machine_type: opts.machine_type,
  });
  if (machine.architecture !== vm.architecture) {
    throw new Error(
      `machine '${machine.machine_type}' has architecture ${machine.architecture}, not ${vm.architecture}`,
    );
  }
  if (
    (machine.gpu_type ?? null) !== (vm.gpu_type ?? null) ||
    Number(machine.gpu_count) !== Number(vm.gpu_count)
  ) {
    throw new Error(
      "changing GPU type or count is not supported; select a machine with the same GPU configuration",
    );
  }
  if (
    (vm.provider === "gcp" &&
      !isSupportedCatalogGcpMachineType(machine.machine_type)) ||
    (machine.ram_gb < 8 && machine.machine_type !== "t2a-standard-1")
  ) {
    throw new Error(
      `machine_type '${machine.machine_type}' is not supported for managed compute VMs`,
    );
  }
  const minimumBootDiskGb =
    vm.operating_system === "windows"
      ? 50
      : vm.provider === "gcp"
        ? gcpMinimumBootDiskGb(machine.machine_type)
        : 10;
  if (vm.boot_disk_gb < minimumBootDiskGb) {
    throw new Error(
      `the existing ${vm.boot_disk_gb} GB boot disk is too small for ${machine.machine_type}; ${minimumBootDiskGb} GB is required`,
    );
  }
  const spotSupported = !(
    vm.provider === "nebius" &&
    machine.provider_spec.allowed_for_preemptibles === false
  );
  if (vm.desired_pricing_model === "spot" && !spotSupported) {
    throw new Error(
      `Nebius machine '${machine.machine_type}' does not support Spot capacity`,
    );
  }
  const rateInput = {
    provider: vm.provider,
    region: vm.region,
    zone: vm.zone,
    machine_type: machine.machine_type,
    gpu_type: machine.gpu_type ?? undefined,
    gpu_count: machine.gpu_count,
    disk_gb: vm.boot_disk_gb,
    disk_type: defaultComputeVolumeDiskType(vm.provider),
    operating_system: vm.operating_system,
  } as const;
  const [customerSpotRate, customerOnDemandRate, customerStoppedRate] =
    await Promise.all([
      estimateDedicatedHostRate({
        ...rateInput,
        pricing_model: "spot",
        billing_state: "running",
      }),
      estimateDedicatedHostRate({
        ...rateInput,
        pricing_model: "on_demand",
        billing_state: "running",
      }),
      estimateDedicatedHostRate({
        ...rateInput,
        pricing_model: vm.desired_pricing_model,
        billing_state: "stopped",
      }),
    ]);
  if (
    (spotSupported && !customerSpotRate) ||
    !customerOnDemandRate ||
    !customerStoppedRate
  ) {
    throw new Error(
      `pricing is unavailable for ${machine.machine_type} in ${vm.region}`,
    );
  }
  const settings = await getServerSettings();
  const spotRate = rateWithProviderCost(
    vm.provider,
    customerSpotRate ?? customerOnDemandRate,
    settings,
  );
  const onDemandRate = rateWithProviderCost(
    vm.provider,
    customerOnDemandRate,
    settings,
  );
  const stoppedRate = rateWithProviderCost(
    vm.provider,
    customerStoppedRate,
    settings,
  );
  const selectedRate =
    vm.desired_pricing_model === "spot" ? spotRate : onDemandRate;
  const osLicenseHourlyPrice =
    selectedRate.pricing_snapshot.components.find(
      ({ key }) => key === "windows_license",
    )?.hourly_cost_usd ?? "0.000000";
  const remainingTtlMinutes = vm.expires_at
    ? Math.max(0, Math.ceil((vm.expires_at.valueOf() - Date.now()) / 60_000))
    : 0;
  await authorizeComputeMutation({
    actor: opts,
    action: "billable",
    project_id: vm.project_id,
    vm_id: vm.id,
    request: {
      operation: "set-vm-machine-type",
      operation_id: opts.idempotency_key,
      vm_id: vm.id,
      provider: vm.provider,
      machine_class: machine.machine_type,
      funding_mode: vm.funding_mode,
      hourly_usd: Number(selectedRate.hourly_cost_usd),
      total_authorized_usd:
        (Number(selectedRate.hourly_cost_usd) * remainingTtlMinutes) / 60,
      ttl_minutes: remainingTtlMinutes,
    },
    require_fresh_auth: true,
  });
  const next = (await updateComputeVm(vm.id, {
    machine_type: machine.machine_type,
    cpu: machine.cpu,
    ram_gb: machine.ram_gb,
    gpu_type: machine.gpu_type,
    gpu_count: machine.gpu_count,
    provider_spec: {
      ...machine.provider_spec,
      operating_system: vm.operating_system,
      operating_system_version: vm.operating_system_version,
    },
    os_license_hourly_price: `${osLicenseHourlyPrice}`,
    spot_hourly_price: `${spotRate.hourly_cost_usd}`,
    on_demand_hourly_price: `${onDemandRate.hourly_cost_usd}`,
    metadata: {
      ...vm.metadata,
      machine: { cpu: machine.cpu, ram_gb: machine.ram_gb },
      billing: {
        ...vm.metadata?.billing,
        spot_supported: spotSupported,
        running_rates: {
          spot: spotRate,
          on_demand: onDemandRate,
        },
        stopped_rate: stoppedRate,
      },
    },
  }))!;
  await appendComputeEvent({
    vm: next,
    actor_account_id: accountId,
    actor_kind: actorKind,
    action: "machine-type-change",
    idempotency_key: normalizeIdempotencyKey(opts.idempotency_key),
    old_state: vm.state,
    new_state: next.state,
    status: "completed",
    details: {
      from: vm.machine_type,
      to: machine.machine_type,
      hourly_cost_usd: selectedRate.hourly_cost_usd,
    },
  });
  return await publicVm(next);
}

export async function deleteVm(opts: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string;
  id_or_name: string;
  idempotency_key: string;
  agent_auth?: ComputeAgentAuth;
}) {
  const accountId = requireAccount(
    opts.agent_auth?.account_id ?? opts.account_id,
  );
  const vm = await resolveOwned(accountId, opts.id_or_name);
  const { actorKind } = resolveComputeActor(opts, vm.project_id);
  await authorizeComputeMutation({
    actor: opts,
    action: "destructive",
    project_id: vm.project_id,
    vm_id: vm.id,
    request: {
      operation: "delete-vm",
      operation_id: opts.idempotency_key,
      vm_id: vm.id,
    },
    require_fresh_auth: true,
  });
  const next = (await updateComputeVm(vm.id, {
    desired_state: "deleted",
    state: "deleting",
  }))!;
  await appendComputeEvent({
    vm: next,
    actor_account_id: accountId,
    actor_kind: actorKind,
    action: "delete",
    idempotency_key: normalizeIdempotencyKey(opts.idempotency_key),
    old_state: vm.state,
    new_state: "deleting",
    status: "requested",
  });
  await enqueueComputeWork({
    resource_id: vm.id,
    action: "delete",
    idempotency_key: opts.idempotency_key,
  });
  return publicVm(next);
}

export async function listOrphans(opts: {
  account_id?: string;
  include_resolved?: boolean;
}) {
  const accountId = requireAccount(opts.account_id);
  if (!(await isAdmin(accountId))) throw new Error("not authorized");
  return await listComputeOrphans({
    include_resolved: opts.include_resolved === true,
  });
}

export async function listAgentGrants(opts: {
  account_id?: string;
  project_id: string;
  include_expired?: boolean;
}) {
  const accountId = requireAccount(opts.account_id);
  await requireProjectMembership(accountId, opts.project_id);
  return await listAgentComputeGrants({
    account_id: accountId,
    project_id: opts.project_id,
    include_expired: opts.include_expired,
  });
}

export async function approveAgentGrant(opts: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string;
  grant_id: string;
}) {
  const accountId = requireAccount(opts.account_id);
  await requireDangerousSessionAuth({
    account_id: accountId,
    browser_id: opts.browser_id,
    session_hash: opts.session_hash,
    require_second_factor: "if_enabled",
  });
  const grant = await approveAgentComputeGrant({
    account_id: accountId,
    grant_id: opts.grant_id,
  });
  await centralLog({
    event: "managed_compute_agent_grant_approved",
    value: {
      account_id: accountId,
      grant_id: grant.grant_id,
      project_id: grant.project_id,
      allowed_actions: grant.allowed_actions,
      allowed_vm_ids: grant.allowed_vm_ids,
      expires_at: grant.expires_at,
    },
  });
  return grant;
}

export async function revokeAgentGrant(opts: {
  account_id?: string;
  grant_id: string;
}) {
  const accountId = requireAccount(opts.account_id);
  await revokeAgentComputeGrant({
    account_id: accountId,
    grant_id: opts.grant_id,
  });
}

export async function resolveOrphan(opts: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string;
  orphan_id: string;
  action: "stop" | "delete" | "ignore";
}) {
  const accountId = requireAccount(opts.account_id);
  if (!(await isAdmin(accountId))) throw new Error("not authorized");
  await requireDangerousSessionAuth({
    account_id: accountId,
    browser_id: opts.browser_id,
    session_hash: opts.session_hash,
    require_second_factor: "if_enabled",
  });
  const orphan = (await listComputeOrphans({ include_resolved: true })).find(
    ({ id }) => id === opts.orphan_id,
  );
  if (!orphan) throw new Error("managed compute orphan not found");
  if (!["stop", "delete", "ignore"].includes(opts.action)) {
    throw new Error("invalid managed compute orphan resolution action");
  }
  await centralLog({
    event: "managed_compute_orphan_resolution",
    value: {
      account_id: accountId,
      orphan_id: orphan.id,
      provider: orphan.provider,
      resource_type: orphan.resource_type,
      resource_id: orphan.resource_id,
      action: opts.action,
      status: "requested",
    },
  });
  const resource = {
    provider: orphan.provider as "gcp" | "nebius",
    resource_id: orphan.resource_id,
    resource_name: orphan.resource_name,
    region: orphan.region,
    zone: orphan.zone,
  };
  if (opts.action === "ignore") {
    await updateComputeOrphan(orphan.id, {
      state: "ignored",
      resolved_at: new Date(),
      last_error: null,
    });
  } else if (opts.action === "stop") {
    if (
      orphan.resource_type !== "instance" ||
      orphan.provider === "cloudflare"
    ) {
      throw new Error("only orphan instances can be stopped");
    }
    await stopOrphanProviderComputeInstance(resource);
    await updateComputeOrphan(orphan.id, {
      state: "stopped",
      stopped_at: new Date(),
      last_error: null,
    });
  } else if (orphan.resource_type === "instance") {
    if (orphan.provider === "cloudflare") throw new Error("invalid provider");
    await deleteOrphanProviderComputeInstance(resource);
    await updateComputeOrphan(orphan.id, {
      state: "deleted",
      resolved_at: new Date(),
      last_error: null,
    });
  } else if (orphan.resource_type === "boot_disk") {
    if (orphan.provider === "cloudflare") throw new Error("invalid provider");
    await deleteOrphanProviderComputeBootDisk(resource);
    await updateComputeOrphan(orphan.id, {
      state: "deleted",
      resolved_at: new Date(),
      last_error: null,
    });
  } else if (orphan.resource_type === "address") {
    if (orphan.provider === "cloudflare") throw new Error("invalid provider");
    await deleteOrphanProviderComputeAddress(resource);
    await updateComputeOrphan(orphan.id, {
      state: "deleted",
      resolved_at: new Date(),
      last_error: null,
    });
  } else {
    await deleteHostDns({
      record_id: orphan.resource_id,
      name: orphan.resource_name,
    });
    await updateComputeOrphan(orphan.id, {
      state: "deleted",
      resolved_at: new Date(),
      last_error: null,
    });
  }
  await centralLog({
    event: "managed_compute_orphan_resolution",
    value: {
      account_id: accountId,
      orphan_id: orphan.id,
      action: opts.action,
      status: "completed",
    },
  });
  const resolved = (await listComputeOrphans({ include_resolved: true })).find(
    ({ id }) => id === orphan.id,
  );
  if (!resolved) throw new Error("managed compute orphan audit row vanished");
  return resolved;
}
