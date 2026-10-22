/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Sagebrush reads /api/v2/sagebrush/limits strictly: a number that is not a
// non-negative safe integer, or a flag that is not a boolean, makes it treat
// the whole answer as an outage (docs/sagebrush.md). So the Sagebrush tier
// limits are checked where a tier is saved, and anything else is dropped where
// they are resolved, so that the tier template's value is used instead.

export const SAGEBRUSH_INTEGER_LIMITS = [
  "sagebrush_storage_bytes",
  "sagebrush_max_file_bytes",
  "sagebrush_sync_version_bytes",
  "sagebrush_sync_read_bytes_per_day",
  "sagebrush_sync_retention_days",
] as const;

/** The value if it is a non-negative safe integer, else undefined. */
export function sagebrushSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}

export const SAGEBRUSH_BOOLEAN_LIMITS = [
  "sagebrush_private_links",
  "sagebrush_sync_enabled",
] as const;

/** Throws if a tier's usage limits set a Sagebrush limit Sagebrush can't read.
 * A blank (null or absent) limit is fine: it is inherited. */
export function assertValidSagebrushLimits(usageLimits: unknown): void {
  if (usageLimits == null || typeof usageLimits !== "object") return;
  const limits = usageLimits as Record<string, unknown>;
  for (const key of SAGEBRUSH_INTEGER_LIMITS) {
    const value = limits[key];
    if (value != null && sagebrushSafeInteger(value) === undefined) {
      throw Error(
        `usage_limits.${key} must be a whole number from 0 to ${Number.MAX_SAFE_INTEGER}`,
      );
    }
  }
  for (const key of SAGEBRUSH_BOOLEAN_LIMITS) {
    const value = limits[key];
    if (value != null && typeof value !== "boolean") {
      throw Error(`usage_limits.${key} must be true or false`);
    }
  }
}
