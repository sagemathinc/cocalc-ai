/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { gcpCpuCountForMachineType } from "./project-host-pricing";

type GcpBenchmarkSeries =
  | "e2-standard"
  | "t2a-standard"
  | "t2d-standard"
  | "n2-highmem"
  | "n2d-standard"
  | "n2d-highmem"
  | "c3-standard"
  | "c3-highcpu"
  | "c3-highmem"
  | "c3d-standard"
  | "c3d-highcpu"
  | "c3d-highmem"
  | "g2-standard";

type GcpBenchmarkSourceEntry = {
  series: GcpBenchmarkSeries;
  prefix: string;
  representative_machine_type: string;
  representative_vcpus: number;
  representative_coremark_score: number;
  cpu_platform: string;
};

export type GcpMachineBenchmark = GcpBenchmarkSourceEntry & {
  coremark_per_vcpu: number;
  normalized_coremark_per_vcpu: number;
  estimated_coremark_score?: number;
};

// Representative per-vCPU CoreMark data from Google's VM-family benchmark page,
// captured on 2026-05-09 for the release-frozen GCP dedicated-host families.
const GCP_MACHINE_BENCHMARKS: readonly GcpBenchmarkSourceEntry[] = [
  {
    series: "e2-standard",
    prefix: "e2-standard-",
    representative_machine_type: "e2-standard-4",
    representative_vcpus: 4,
    representative_coremark_score: 52043,
    cpu_platform: "Intel",
  },
  {
    series: "t2a-standard",
    prefix: "t2a-standard-",
    representative_machine_type: "t2a-standard-4",
    representative_vcpus: 4,
    representative_coremark_score: 94096,
    cpu_platform: "Ampere",
  },
  {
    series: "t2d-standard",
    prefix: "t2d-standard-",
    representative_machine_type: "t2d-standard-4",
    representative_vcpus: 4,
    representative_coremark_score: 119587,
    cpu_platform: "Milan",
  },
  {
    series: "n2-highmem",
    prefix: "n2-highmem-",
    representative_machine_type: "n2-highmem-4",
    representative_vcpus: 4,
    representative_coremark_score: 66798,
    cpu_platform: "Ice Lake",
  },
  {
    series: "n2d-standard",
    prefix: "n2d-standard-",
    representative_machine_type: "n2d-standard-4",
    representative_vcpus: 4,
    representative_coremark_score: 80098,
    cpu_platform: "Milan",
  },
  {
    series: "n2d-highmem",
    prefix: "n2d-highmem-",
    representative_machine_type: "n2d-highmem-4",
    representative_vcpus: 4,
    representative_coremark_score: 80065,
    cpu_platform: "Milan",
  },
  {
    series: "c3-standard",
    prefix: "c3-standard-",
    representative_machine_type: "c3-standard-4",
    representative_vcpus: 4,
    representative_coremark_score: 80609,
    cpu_platform: "Sapphire Rapids",
  },
  {
    series: "c3-highcpu",
    prefix: "c3-highcpu-",
    representative_machine_type: "c3-highcpu-4",
    representative_vcpus: 4,
    representative_coremark_score: 80641,
    cpu_platform: "Sapphire Rapids",
  },
  {
    series: "c3-highmem",
    prefix: "c3-highmem-",
    representative_machine_type: "c3-highmem-4",
    representative_vcpus: 4,
    representative_coremark_score: 80742,
    cpu_platform: "Sapphire Rapids",
  },
  {
    series: "c3d-standard",
    prefix: "c3d-standard-",
    representative_machine_type: "c3d-standard-4",
    representative_vcpus: 4,
    representative_coremark_score: 94572,
    cpu_platform: "Genoa",
  },
  {
    series: "c3d-highcpu",
    prefix: "c3d-highcpu-",
    representative_machine_type: "c3d-highcpu-4",
    representative_vcpus: 4,
    representative_coremark_score: 94611,
    cpu_platform: "Genoa",
  },
  {
    series: "c3d-highmem",
    prefix: "c3d-highmem-",
    representative_machine_type: "c3d-highmem-4",
    representative_vcpus: 4,
    representative_coremark_score: 94477,
    cpu_platform: "Genoa",
  },
  {
    series: "g2-standard",
    prefix: "g2-standard-",
    representative_machine_type: "g2-standard-4",
    representative_vcpus: 4,
    representative_coremark_score: 56273,
    cpu_platform: "Cascade Lake",
  },
] as const;

const GCP_BENCHMARK_BASELINE = GCP_MACHINE_BENCHMARKS.find(
  (entry) => entry.representative_machine_type === "n2d-standard-4",
);

const GCP_BENCHMARK_BASELINE_PER_VCPU =
  (GCP_BENCHMARK_BASELINE?.representative_coremark_score ?? 1) /
  (GCP_BENCHMARK_BASELINE?.representative_vcpus ?? 1);

export function getGcpMachineBenchmark(
  machineType?: string | null,
  cpuCount?: number | null,
): GcpMachineBenchmark | undefined {
  const name = `${machineType ?? ""}`.trim().toLowerCase();
  if (!name) return undefined;
  const source = GCP_MACHINE_BENCHMARKS.find((entry) =>
    name.startsWith(entry.prefix),
  );
  if (!source) return undefined;
  const coremark_per_vcpu =
    source.representative_coremark_score / source.representative_vcpus;
  const resolvedCpuCount =
    (typeof cpuCount === "number" && Number.isFinite(cpuCount) && cpuCount > 0
      ? cpuCount
      : gcpCpuCountForMachineType(name)) ?? undefined;
  return {
    ...source,
    coremark_per_vcpu,
    normalized_coremark_per_vcpu:
      coremark_per_vcpu / GCP_BENCHMARK_BASELINE_PER_VCPU,
    estimated_coremark_score:
      resolvedCpuCount != null
        ? coremark_per_vcpu * resolvedCpuCount
        : undefined,
  };
}
