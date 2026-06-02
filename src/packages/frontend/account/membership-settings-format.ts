/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { capitalize, round2 } from "@cocalc/util/misc";

const PROJECT_DEFAULT_KEYS = ["memory", "disk_quota"] as const;

export function normalizeRecord(value?: unknown): Record<string, unknown> {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return {};
}

export function formatResetAt(resetAt?: Date | string): string | undefined {
  if (!resetAt) return;
  const date = new Date(resetAt);
  if (!Number.isFinite(date.getTime())) return;
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatProjectDefaultValue(key: string, value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return String(value);
  }
  if (key === "memory" || key === "disk_quota") {
    if (value >= 1000) {
      const gb = value / 1000;
      return `${Number.isInteger(gb) ? gb : round2(gb)} GB`;
    }
    return `${value} MB`;
  }
  const rounded = Number.isInteger(value) ? value : round2(value);
  return `${rounded}`;
}

function projectDefaultLabel(key: string): string {
  switch (key) {
    case "memory":
      return "RAM";
    case "disk_quota":
      return "Disk";
    default:
      return capitalize(key.replace(/_/g, " "));
  }
}

export function getProgressPercent(current: number, limit: number): number {
  if (!(limit > 0) || !Number.isFinite(limit)) return 0;
  return Math.max(0, Math.min(100, (current / limit) * 100));
}

export function getProjectDefaultsItems(
  projectDefaults: Record<string, unknown>,
): Array<{
  key: string;
  label: string;
  value: string;
}> {
  return PROJECT_DEFAULT_KEYS.map((key) => {
    if (!(key in projectDefaults)) return null;
    const value = projectDefaults[key];
    return {
      key,
      label: projectDefaultLabel(key),
      value: formatProjectDefaultValue(key, value),
    };
  }).filter((item) => item != null) as Array<{
    key: string;
    label: string;
    value: string;
  }>;
}

export function extractLimit(
  limits: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = limits[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

export function formatFeatureTag(key: string, value: unknown): string | null {
  if (value == null || value === false) return null;
  const label = capitalize(key.replace(/_/g, " "));
  if (value === true) return label;
  return `${label}: ${value}`;
}
