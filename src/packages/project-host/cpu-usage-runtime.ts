/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type ProjectHostCpuUsageMode = "off" | "observe";

function normalizeMode(
  value: string | undefined,
): ProjectHostCpuUsageMode | undefined {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  if (normalized === "off" || normalized === "observe") {
    return normalized;
  }
  if (normalized === "on" || normalized === "true" || normalized === "1") {
    return "observe";
  }
  return undefined;
}

export function getProjectHostCpuUsageMode(): ProjectHostCpuUsageMode {
  return (
    normalizeMode(process.env.COCALC_PROJECT_HOST_CPU_USAGE_MODE) ??
    normalizeMode(process.env.COCALC_PROJECT_HOST_CPU_USAGE_ENABLED) ??
    "observe"
  );
}

export function isProjectHostCpuUsageTrackingEnabled(): boolean {
  return getProjectHostCpuUsageMode() !== "off";
}

export const __test__ = {
  normalizeMode,
};
