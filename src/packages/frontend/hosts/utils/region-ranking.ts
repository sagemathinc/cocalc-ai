/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  mapCloudRegionToR2Region,
  rankR2RegionDistance,
  type R2Region,
} from "@cocalc/util/consts";
import type { HostFieldOption } from "../providers/registry";

export type RegionPreference = "balanced" | "closest" | "cheapest";

type RegionOptionMeta = {
  compatible?: boolean;
  hourlyRate?: number;
  expectPrice?: boolean;
};

function getDistanceRank(
  option: HostFieldOption,
  preferredRegion: R2Region | undefined,
) {
  return rankR2RegionDistance(
    preferredRegion,
    mapCloudRegionToR2Region(option.value),
  );
}

function getHourlyRate(option: HostFieldOption): number | undefined {
  const value = (option.meta as RegionOptionMeta | undefined)?.hourlyRate;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function shouldExpectPrice(option: HostFieldOption): boolean {
  return (option.meta as RegionOptionMeta | undefined)?.expectPrice === true;
}

function isCompatible(option: HostFieldOption): boolean {
  return (option.meta as RegionOptionMeta | undefined)?.compatible !== false;
}

function pricePenalty(
  option: HostFieldOption,
  cheapestHourlyRate: number | undefined,
) {
  const hourlyRate = getHourlyRate(option);
  if (hourlyRate == null) {
    return shouldExpectPrice(option) ? 3 : 0;
  }
  if (
    cheapestHourlyRate == null ||
    !Number.isFinite(cheapestHourlyRate) ||
    cheapestHourlyRate <= 0
  ) {
    return 0;
  }
  return Math.max(0, hourlyRate / cheapestHourlyRate - 1);
}

function scoreRegionOption(opts: {
  option: HostFieldOption;
  preference: RegionPreference;
  preferredRegion: R2Region | undefined;
  cheapestHourlyRate: number | undefined;
}) {
  const incompatiblePenalty = isCompatible(opts.option) ? 0 : 10_000;
  const missingPricePenalty =
    getHourlyRate(opts.option) == null && shouldExpectPrice(opts.option)
      ? 1_000
      : 0;
  const distance = getDistanceRank(opts.option, opts.preferredRegion);
  const price = pricePenalty(opts.option, opts.cheapestHourlyRate);
  switch (opts.preference) {
    case "closest":
      return (
        incompatiblePenalty + missingPricePenalty + distance * 100 + price * 10
      );
    case "cheapest":
      return (
        incompatiblePenalty + missingPricePenalty + price * 100 + distance * 10
      );
    case "balanced":
    default:
      return (
        incompatiblePenalty + missingPricePenalty + distance * 40 + price * 60
      );
  }
}

export function sortRegionOptionsByPreference(opts: {
  options: HostFieldOption[];
  preference: RegionPreference;
  preferredRegion: R2Region | undefined;
}): HostFieldOption[] {
  const priced = opts.options
    .map(getHourlyRate)
    .filter((value): value is number => value != null)
    .sort((a, b) => a - b);
  const cheapestHourlyRate = priced[0];
  return [...opts.options].sort((a, b) => {
    const scoreA = scoreRegionOption({
      option: a,
      preference: opts.preference,
      preferredRegion: opts.preferredRegion,
      cheapestHourlyRate,
    });
    const scoreB = scoreRegionOption({
      option: b,
      preference: opts.preference,
      preferredRegion: opts.preferredRegion,
      cheapestHourlyRate,
    });
    if (scoreA !== scoreB) return scoreA - scoreB;
    return a.label.localeCompare(b.label) || a.value.localeCompare(b.value);
  });
}

export function markRecommendedRegionOption(
  options: HostFieldOption[],
): HostFieldOption[] {
  if (options.length <= 1) return options;
  const [first, ...rest] = options;
  return [
    {
      ...first,
      label: `${first.label} · recommended`,
    },
    ...rest,
  ];
}
