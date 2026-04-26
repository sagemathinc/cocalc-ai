import type {
  Host,
  HostAutoGrowConfig,
  HostInterruptionRestorePolicy,
  HostPricingModel,
} from "@cocalc/conat/hub/api/hosts";
import type { HostProvider } from "../types";

type CreateSimilarHostFormValues = {
  name: string;
  provider: HostProvider;
  cpu?: number;
  ram_gb?: number;
  disk_gb?: number;
  disk?: number;
  region?: string;
  zone?: string;
  machine_type?: string;
  gpu_type?: string;
  size?: string;
  storage_mode?: string;
  disk_type?: string;
  pricing_model?: HostPricingModel;
  interruption_restore_policy?: HostInterruptionRestorePolicy;
  self_host_ssh_target?: string;
  auto_grow_enabled?: boolean;
  auto_grow_max_disk_gb?: number;
  auto_grow_growth_step_gb?: number;
  auto_grow_min_grow_interval_minutes?: number;
};

const readPositive = (value: unknown): number | undefined => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
};

const defaultRestorePolicy = (
  pricingModel: HostPricingModel | undefined,
): HostInterruptionRestorePolicy =>
  pricingModel === "spot" ? "immediate" : "none";

const similarName = (name: string | undefined): string => {
  const base = (name ?? "My host").trim() || "My host";
  return /\s+\(similar\)$/i.test(base) ? base : `${base} (similar)`;
};

const readAutoGrow = (host: Host) => {
  const metadata = (host.machine?.metadata ?? {}) as Record<string, unknown>;
  const nested = (metadata.auto_grow ?? {}) as HostAutoGrowConfig;
  return {
    enabled:
      nested.enabled ??
      (typeof metadata.auto_grow_enabled === "boolean"
        ? metadata.auto_grow_enabled
        : false),
    max_disk_gb: readPositive(
      nested.max_disk_gb ?? metadata.auto_grow_max_disk_gb,
    ),
    growth_step_gb: readPositive(
      nested.growth_step_gb ?? metadata.auto_grow_growth_step_gb,
    ),
    min_grow_interval_minutes: readPositive(
      nested.min_grow_interval_minutes ??
        metadata.auto_grow_min_grow_interval_minutes,
    ),
  };
};

export function buildCreateSimilarHostFormValues(
  host: Host,
  providerOptions: HostProvider[],
): CreateSimilarHostFormValues {
  const hostProvider = host.machine?.cloud as HostProvider | undefined;
  const provider = providerOptions.includes(hostProvider ?? "none")
    ? (hostProvider ?? "none")
    : (providerOptions[0] ?? "none");
  const disk = readPositive(host.machine?.disk_gb);
  const autoGrow = readAutoGrow(host);
  return {
    name: similarName(host.name),
    provider,
    cpu: readPositive(host.machine?.metadata?.cpu),
    ram_gb: readPositive(host.machine?.metadata?.ram_gb),
    disk_gb: disk,
    disk,
    region: host.region ?? undefined,
    zone: host.machine?.zone ?? undefined,
    machine_type: host.machine?.machine_type ?? undefined,
    gpu_type: host.machine?.gpu_type ?? "none",
    size: host.machine?.machine_type ?? host.size ?? undefined,
    storage_mode: host.machine?.storage_mode ?? "persistent",
    disk_type: host.machine?.disk_type ?? undefined,
    pricing_model: host.pricing_model ?? "on_demand",
    interruption_restore_policy:
      host.interruption_restore_policy ??
      defaultRestorePolicy(host.pricing_model),
    self_host_ssh_target:
      host.machine?.metadata?.self_host_ssh_target ?? undefined,
    auto_grow_enabled: autoGrow.enabled,
    auto_grow_max_disk_gb: autoGrow.max_disk_gb,
    auto_grow_growth_step_gb: autoGrow.growth_step_gb,
    auto_grow_min_grow_interval_minutes: autoGrow.min_grow_interval_minutes,
  };
}

export type { CreateSimilarHostFormValues };
