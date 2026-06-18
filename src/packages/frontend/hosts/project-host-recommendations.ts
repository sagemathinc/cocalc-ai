/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { Host, HostPressureZone } from "@cocalc/conat/hub/api/hosts";
import {
  mapCloudRegionToR2Region,
  rankR2RegionDistance,
  type R2Region,
} from "@cocalc/util/consts";
import { getGcpMachineBenchmark } from "@cocalc/util/project-host-benchmarks";

export type ProjectHostLoadLabel =
  | "normal"
  | "watching"
  | "busy"
  | "very_busy"
  | "unavailable"
  | "unknown";

export type ProjectHostRecommendationReason =
  | "same_region"
  | "remote_region"
  | "selected"
  | "standard"
  | "spot"
  | "spot_fallback"
  | "gpu"
  | "missing_gpu"
  | "fast_cpu"
  | "slow_cpu"
  | "pressure"
  | "unavailable";

export type ProjectHostRecommendation = {
  host: Host;
  score: number;
  backupRegion?: R2Region;
  sameProjectRegion: boolean;
  load: ProjectHostLoadLabel;
  relativeCpuSpeed?: number;
  reasons: ProjectHostRecommendationReason[];
};

export type ProjectHostRecommendationResult = {
  recommended?: ProjectHostRecommendation;
  candidates: ProjectHostRecommendation[];
  unavailable: ProjectHostRecommendation[];
  projectRegionCandidates: ProjectHostRecommendation[];
  remoteCandidates: ProjectHostRecommendation[];
};

export type RecommendProjectHostsOptions = {
  hosts: Host[];
  projectRegion: R2Region;
  wantsGpu?: boolean;
  selectedHostId?: string;
};

const PRESSURE_RANK: Record<HostPressureZone, number> = {
  normal: 0,
  observe: 1,
  pressure: 2,
  emergency: 3,
};

function desiredPricingModel(host: Host): string | undefined {
  return host.desired_pricing_model ?? host.pricing_model;
}

function effectivePricingModel(host: Host): string | undefined {
  return host.effective_pricing_model ?? host.pricing_model;
}

function isSpotHost(host: Host): boolean {
  return desiredPricingModel(host) === "spot";
}

function isSpotFallbackHost(host: Host): boolean {
  if (!isSpotHost(host)) return false;
  const phase = host.recovery_phase ?? host.spot_recovery_state?.phase;
  return (
    effectivePricingModel(host) === "on_demand" ||
    phase === "running_standard_fallback" ||
    phase === "probing_spot"
  );
}

function pressureRank(host: Host): number {
  const zone = host.pressure?.zone;
  return zone ? (PRESSURE_RANK[zone] ?? 0) : 0;
}

function loadLabel(host: Host): ProjectHostLoadLabel {
  if (host.can_place === false) return "unavailable";
  switch (host.pressure?.zone) {
    case "normal":
      return "normal";
    case "observe":
      return "watching";
    case "pressure":
      return "busy";
    case "emergency":
      return "very_busy";
    default:
      return "unknown";
  }
}

function relativeCpuSpeed(host: Host): number | undefined {
  if (host.machine?.cloud !== "gcp") return undefined;
  return getGcpMachineBenchmark(host.machine?.machine_type, host.host_cpu_count)
    ?.normalized_coremark_per_vcpu;
}

function scoreHost({
  host,
  projectRegion,
  wantsGpu,
  selectedHostId,
}: RecommendProjectHostsOptions & {
  host: Host;
}): ProjectHostRecommendation {
  const backupRegion = mapCloudRegionToR2Region(host.region);
  const sameProjectRegion = backupRegion === projectRegion;
  const reasons: ProjectHostRecommendationReason[] = [];
  let score = 0;

  if (host.can_place === false) {
    reasons.push("unavailable");
    score -= 10_000;
  }

  if (sameProjectRegion) {
    score += 1_000;
    reasons.push("same_region");
  } else {
    const distanceRank = rankR2RegionDistance(projectRegion, backupRegion);
    score += 400 - Math.min(distanceRank, 20) * 50;
    reasons.push("remote_region");
  }

  if (selectedHostId && host.id === selectedHostId) {
    score += 200;
    reasons.push("selected");
  }

  if (wantsGpu) {
    if (host.gpu) {
      score += 350;
      reasons.push("gpu");
    } else {
      score -= 500;
      reasons.push("missing_gpu");
    }
  } else if (host.gpu) {
    score -= 25;
  }

  const rank = pressureRank(host);
  score -= rank * 150;
  if (rank >= PRESSURE_RANK.pressure) {
    reasons.push("pressure");
  }

  if (isSpotFallbackHost(host)) {
    score += 30;
    reasons.push("spot_fallback");
  } else if (isSpotHost(host)) {
    reasons.push("spot");
  } else {
    score += 60;
    reasons.push("standard");
  }

  const speed = relativeCpuSpeed(host);
  if (speed != null) {
    if (speed >= 1.15) {
      score += Math.min(100, Math.round((speed - 1) * 80));
      reasons.push("fast_cpu");
    } else if (speed <= 0.85) {
      score -= Math.min(100, Math.round((1 - speed) * 80));
      reasons.push("slow_cpu");
    }
  }

  return {
    host,
    score,
    backupRegion,
    sameProjectRegion,
    load: loadLabel(host),
    relativeCpuSpeed: speed,
    reasons,
  };
}

function recommendationSort(
  a: ProjectHostRecommendation,
  b: ProjectHostRecommendation,
): number {
  return (
    b.score - a.score ||
    `${a.host.name}`.localeCompare(`${b.host.name}`) ||
    a.host.id.localeCompare(b.host.id)
  );
}

export function recommendProjectHosts(
  opts: RecommendProjectHostsOptions,
): ProjectHostRecommendationResult {
  const recommendations = opts.hosts
    .filter((host) => !host.deleted)
    .map((host) => scoreHost({ ...opts, host }));
  const candidates = recommendations
    .filter((recommendation) => recommendation.host.can_place !== false)
    .sort(recommendationSort);
  const unavailable = recommendations
    .filter((recommendation) => recommendation.host.can_place === false)
    .sort(recommendationSort);
  const projectRegionCandidates = candidates.filter(
    (recommendation) => recommendation.sameProjectRegion,
  );
  const remoteCandidates = candidates.filter(
    (recommendation) => !recommendation.sameProjectRegion,
  );
  return {
    recommended: projectRegionCandidates[0] ?? remoteCandidates[0],
    candidates,
    unavailable,
    projectRegionCandidates,
    remoteCandidates,
  };
}
