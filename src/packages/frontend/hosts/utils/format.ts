import type { Host } from "@cocalc/conat/hub/api/hosts";

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;

export const formatCpuRamLabel = (
  cpu?: number | null,
  ramGiB?: number | null,
): string => {
  const cpuLabel = cpu != null ? String(cpu) : "?";
  const ramLabel = ramGiB != null ? String(ramGiB) : "?";
  return `${cpuLabel} vCPU / ${ramLabel} GiB`;
};

export const formatGpuLabel = (
  count?: number | null,
  label?: string | null,
): string => {
  if (!count || count <= 0) return "";
  const suffix = label ? ` ${label}` : " GPU";
  return ` · ${count}x${suffix}`;
};

export const formatRegionsLabel = (count?: number | null): string =>
  count && count > 0 ? ` · ${count} regions` : "";

export const formatRegionLabel = (
  name: string,
  location?: string | null,
  lowC02?: boolean | null,
): string => {
  const lowC02Label = lowC02 ? " (low CO₂)" : "";
  const suffix = location ? ` — ${location}${lowC02Label}` : "";
  return `${name}${suffix}`;
};

function readPositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

export function formatBinaryBytes(
  value: number | null | undefined,
  opts?: { compact?: boolean },
): string | undefined {
  if (value == null || !Number.isFinite(value) || value < 0) return undefined;
  const compact = !!opts?.compact;
  if (value < KIB) {
    return compact ? `${Math.ceil(value)} B` : `${Math.round(value)} B`;
  }
  if (value < MIB) {
    const amount = value / KIB;
    return compact ? `${Math.ceil(amount)} KiB` : `${amount.toFixed(1)} KiB`;
  }
  if (value < GIB) {
    const amount = value / MIB;
    return compact ? `${Math.ceil(amount)} MiB` : `${amount.toFixed(1)} MiB`;
  }
  const amount = value / GIB;
  return compact ? `${Math.ceil(amount)} GiB` : `${amount.toFixed(1)} GiB`;
}

export function getHostCpuCount(host: Host): number | undefined {
  return (
    readPositiveInt(host.host_cpu_count) ??
    readPositiveInt(host.machine?.metadata?.cpu) ??
    readPositiveInt(host.machine?.metadata?.cpus) ??
    readPositiveInt(host.machine?.metadata?.vcpus)
  );
}

export function getHostRamGiB(host: Host): number | undefined {
  const observed = host.metrics?.current?.memory_total_bytes;
  if (observed != null && Number.isFinite(observed) && observed > 0) {
    return Math.max(1, Math.round(observed / GIB));
  }
  return (
    readPositiveInt(host.host_ram_gb) ??
    readPositiveInt(host.machine?.metadata?.ram_gb) ??
    readPositiveInt(host.machine?.metadata?.memory_gb) ??
    readPositiveInt(host.machine?.metadata?.memory)
  );
}

export function getHostSizeDisplay(host: Host): {
  primary: string;
  secondary?: string;
} {
  const cpu = getHostCpuCount(host);
  const ramGiB = getHostRamGiB(host);
  const fallback = host.size || host.machine?.machine_type || "n/a";
  if (cpu == null && ramGiB == null) {
    return { primary: fallback };
  }
  const primary = formatCpuRamLabel(cpu, ramGiB);
  const secondary =
    fallback && fallback !== primary ? fallback : host.machine?.machine_type;
  return secondary ? { primary, secondary } : { primary };
}
