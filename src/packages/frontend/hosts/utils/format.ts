import type { Host } from "@cocalc/conat/hub/api/hosts";

export const formatCpuRamLabel = (
  cpu?: number | null,
  ramGb?: number | null,
): string => {
  const cpuLabel = cpu != null ? String(cpu) : "?";
  const ramLabel = ramGb != null ? String(ramGb) : "?";
  return `${cpuLabel} vCPU / ${ramLabel} GB`;
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

export function getHostCpuCount(host: Host): number | undefined {
  return (
    readPositiveInt(host.host_cpu_count) ??
    readPositiveInt(host.machine?.metadata?.cpu) ??
    readPositiveInt(host.machine?.metadata?.cpus) ??
    readPositiveInt(host.machine?.metadata?.vcpus)
  );
}

export function getHostRamGb(host: Host): number | undefined {
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
  const ramGb = getHostRamGb(host);
  const fallback = host.size || host.machine?.machine_type || "n/a";
  if (cpu == null && ramGb == null) {
    return { primary: fallback };
  }
  const primary = formatCpuRamLabel(cpu, ramGb);
  const secondary =
    fallback && fallback !== primary ? fallback : host.machine?.machine_type;
  return secondary ? { primary, secondary } : { primary };
}
