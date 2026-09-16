import type { ComputeVolume } from "@cocalc/conat/hub/api/compute";
import { requireVolumeFundingVersion } from "@cocalc/util/compute-volume-funding";

export function volumeCourseSource(volume: ComputeVolume) {
  return volume.funding_source ?? volume.funding_status?.source;
}

export function volumeFundingLabel(volume: ComputeVolume): string {
  if (volumeCourseSource(volume))
    return volume.funding_status?.label || "Course funding unavailable";
  return volume.funding_mode === "site-funded"
    ? "Site funding"
    : "Personal funding";
}

export function volumeFundingUnavailable(
  volume: ComputeVolume,
  now = Date.now(),
): boolean {
  if (!volumeCourseSource(volume)) return false;
  try {
    requireVolumeFundingVersion(volume.funding_status, now);
    return false;
  } catch {
    return true;
  }
}

export function volumeResizeFunding(volume: ComputeVolume) {
  if (!volumeCourseSource(volume)) return {};
  return {
    expected_funding_version: requireVolumeFundingVersion(
      volume.funding_status,
    ),
  };
}
