/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Limits of the independent control-plane-conat (browser <-> bay) egress
// pool: the site default, unless the account's effective limits (an admin
// entitlement override) set them.  No imports beyond types, so both the
// admission policy and usage status can use it without an import cycle.

import type { MembershipUsageLimits } from "@cocalc/conat/hub/api/purchases";

export const DEFAULT_CONTROL_PLANE_EGRESS_5H_BYTES = 10_000_000_000;
export const DEFAULT_CONTROL_PLANE_EGRESS_7D_BYTES = 100_000_000_000;

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export function getControlPlaneEgressLimitsFromEffective(
  limits?: Pick<
    MembershipUsageLimits,
    "control_plane_egress_5h_bytes" | "control_plane_egress_7d_bytes"
  > | null,
): { egress_5h_bytes: number; egress_7d_bytes: number } {
  return {
    egress_5h_bytes:
      positive(limits?.control_plane_egress_5h_bytes) ??
      positiveIntegerEnv(
        "COCALC_CONTROL_PLANE_EGRESS_5H_BYTES",
        DEFAULT_CONTROL_PLANE_EGRESS_5H_BYTES,
      ),
    egress_7d_bytes:
      positive(limits?.control_plane_egress_7d_bytes) ??
      positiveIntegerEnv(
        "COCALC_CONTROL_PLANE_EGRESS_7D_BYTES",
        DEFAULT_CONTROL_PLANE_EGRESS_7D_BYTES,
      ),
  };
}
