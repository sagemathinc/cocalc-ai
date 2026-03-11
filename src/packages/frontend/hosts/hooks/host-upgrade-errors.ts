/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export function formatHostUpgradeFailureMessage({
  hostName,
  err,
}: {
  hostName?: string;
  err: unknown;
}): string {
  const detail =
    err instanceof Error ? err.message : `${err ?? "Unknown error"}`;
  const prefix = hostName?.trim()
    ? `Unable to upgrade software on host "${hostName.trim()}"`
    : "Unable to upgrade host software";
  return `${prefix}: ${detail}`;
}
